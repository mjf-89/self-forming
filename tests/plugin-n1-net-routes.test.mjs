import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';
import { El } from './plugin-p4-support.mjs';

// Step N1: general provider selection in plugin-runtime.js (any service with several providers), net.fetch@1 as
// its first use (core-net-native = default, core-net-page), and the generic Settings → Providers section of
// core-plugin-management (providers-settings.js; core-net-native has no settings entry). The real-composition
// check on the phone's wiring is plugin-n1-real-composition.test.mjs. Real plugin-runtime.js / plugin-builtins.js, fake bridge/storage/DOM.
let app, runtimeModule, builtins, net, providersUi, page;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  runtimeModule = await app.load('plugin-runtime.js');
  builtins = await app.load('plugin-builtins.js');
  net = await app.load('builtin/core-net-native/web/index.js');
  providersUi = await app.load('builtin/core-plugin-management/web/providers-settings.js');
  page = await app.load('builtin/core-net-page/web/index.js');
});
after(async () => { await app?.remove(); });

const NET_KEY = 'self-forming.net.route';
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// A provider plugin of an arbitrary service. value gets available() when `ok` is a function.
const provider = (id, service, { isDefault = false, ok, name, value = () => () => id } = {}) => ({
  id, version: '1.0.0', ...name ? { name } : {},
  provides: [{ id: service, version: 1, ...isDefault ? { default: true } : {} }],
  setup(ctx) { ctx.provide(service, 1, Object.assign(value(), ok ? { available: ok } : {})); }
});
const start = async (definitions, options = {}) => {
  const runtime = runtimeModule.createPluginRuntime({ onError: (error) => { throw error; }, ...options });
  for (const definition of definitions) runtime.register(definition);
  await runtime.start();
  return runtime;
};

test('two providers of a non-network service: the default is not a conflict, the choice is used, persisted under a generic key', async () => {
  const storage = memory();
  const runtime = await start([
    provider('store-a', 'notes', { isDefault: true, name: 'Notes A' }),
    provider('store-b', 'notes', { name: 'Notes B' })
  ], { storage });
  assert.deepEqual(runtime.list().map((r) => r.state), ['active', 'active']);
  assert.deepEqual(runtime.selection.providers('notes', 1).map((p) => [p.id, p.default, p.active]), [['store-a', true, true], ['store-b', false, true]]);
  assert.equal(runtime.service('notes', 1)(), 'store-a', 'default without a choice');
  assert.equal(runtime.selection.resolve('notes', 1).status, 'Using Notes A.');
  assert.equal(runtime.selection.choose('notes', 1, 'nope'), false);
  assert.equal(runtime.selection.choose('notes', 1, 'store-b'), true);
  assert.equal(storage.getItem('self-forming.provider.notes@1'), 'store-b');
  assert.equal(runtime.service('notes', 1)(), 'store-b');
  assert.equal(runtime.selection.resolve('notes', 1).status, 'Using Notes B.');
  // A new runtime on the same storage keeps the choice.
  const again = await start([provider('store-a', 'notes', { isDefault: true }), provider('store-b', 'notes')], { storage });
  assert.equal(again.service('notes', 1)(), 'store-b');
  // Choosing the default clears the saved choice.
  again.selection.choose('notes', 1, 'store-a');
  assert.equal(storage.data.size, 0);
  assert.equal(again.service('notes', 1)(), 'store-a');
  await runtime.close(); await again.close();
});

test('without exactly one default, several providers are still a conflict', async () => {
  for (const defaults of [[false, false], [true, true]]) {
    const runtime = runtimeModule.createPluginRuntime({ storage: memory() });
    runtime.register(provider('p-a', 'svc', { isDefault: defaults[0] }));
    runtime.register(provider('p-b', 'svc', { isDefault: defaults[1] }));
    await runtime.start();
    assert.deepEqual(runtime.list().map((r) => r.state), ['blocked', 'blocked']);
    assert.match(runtime.list()[0].reason, /Provider conflict for svc@1/);
    await runtime.close();
  }
});

test('fallback to the default with a visible reason: not active, not available, not installed; the choice is kept', async () => {
  const storage = memory({ 'self-forming.provider.notes@1': 'store-b' });
  let ok = false;
  const runtime = await start([
    provider('store-a', 'notes', { isDefault: true, name: 'Notes A' }),
    provider('store-b', 'notes', { name: 'Notes B', ok: () => ok })
  ], { storage });
  const seen = [];
  runtime.subscribe(() => seen.push(runtime.selection.resolve('notes', 1).reason));
  assert.equal(runtime.service('notes', 1)(), 'store-a');
  assert.equal(runtime.selection.resolve('notes', 1).reason, 'Notes B is not available; using Notes A instead.');
  await tick();
  assert.ok(seen.some((reason) => /not available/.test(reason)), 'listeners are told when a request falls back');
  assert.equal(storage.getItem('self-forming.provider.notes@1'), 'store-b');
  ok = true;
  assert.equal(runtime.service('notes', 1)(), 'store-b');
  assert.equal(runtime.selection.resolve('notes', 1).reason, null);
  // available() that throws counts as unavailable.
  const throwing = await start([provider('store-a', 'notes', { isDefault: true }), provider('store-b', 'notes', { ok: () => { throw new Error('x'); } })], { storage });
  assert.equal(throwing.service('notes', 1)(), 'store-a');
  // Chosen provider stopped: not active.
  await runtime.stop('store-b');
  assert.equal(runtime.service('notes', 1)(), 'store-a');
  assert.match(runtime.selection.resolve('notes', 1).status, /Notes B is not active; using Notes A instead\./);
  // Saved id that is not installed at all.
  const gone = await start([provider('store-a', 'notes', { isDefault: true }), provider('store-c', 'notes')], { storage });
  assert.equal(gone.service('notes', 1)(), 'store-a');
  assert.equal(gone.selection.resolve('notes', 1).status, 'Saved provider "store-b" is not installed; using store-a instead.');
  for (const r of [runtime, throwing, gone]) await r.close();
});

test('unavailable default alone resolves null, recovers per call, and reports both transitions', async () => {
  let ready = false;
  const runtime = await start([provider('net-a', 'net.fetch', { isDefault: true, name: 'Network A', ok: () => ready })], { storage: memory() });
  try {
    const seen = [];
    runtime.subscribe(() => seen.push(runtime.selection.resolve('net.fetch', 1).status));
    assert.equal(runtime.service('net.fetch', 1), null);
    const result = runtime.selection.resolve('net.fetch', 1);
    assert.equal(result.provider, null);
    assert.equal(result.default, 'net-a', 'intended default survives unavailability');
    assert.equal(result.choice, null);
    assert.equal(result.reason, 'Network A is not available.');
    assert.equal(result.status, result.reason);
    assert.equal(runtime.selection.providers('net.fetch', 1)[0].available, false);
    await tick();
    assert.ok(seen.includes('Network A is not available.'));
    ready = true;
    assert.equal(runtime.service('net.fetch', 1)(), 'net-a');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Using Network A.');
    await tick();
    assert.ok(seen.includes('Using Network A.'));
    ready = false;
    assert.equal(runtime.service('net.fetch', 1), null);
    await runtime.stop('net-a');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Network A is not active.');
  } finally { await runtime.close(); }
});

test('unavailable choice and default never resolve a third provider; fallback needs a ready default', async () => {
  let ready = false;
  const storage = memory({ [NET_KEY]: 'net-b' });
  const runtime = await start([
    provider('net-a', 'net.fetch', { isDefault: true, name: 'Network A', ok: () => ready }),
    provider('net-b', 'net.fetch', { name: 'Network B', ok: () => false }),
    provider('net-page', 'net.fetch', { name: 'Direct page' })
  ], { storage });
  try {
    assert.equal(runtime.service('net.fetch', 1), null, 'no implicit direct/page fallback');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Network B is not available; Network A is not available.');
    assert.equal(storage.getItem(NET_KEY), 'net-b');
    ready = true;
    assert.equal(runtime.service('net.fetch', 1)(), 'net-a');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Network B is not available; using Network A instead.');
    ready = false;
    assert.equal(runtime.service('net.fetch', 1), null);
    await runtime.stop('net-a');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Network B is not available; Network A is not active.');
  } finally { await runtime.close(); }
});

test('throwing default availability is unavailable, including when explicitly saved as the choice', async () => {
  for (const saved of [{}, { [NET_KEY]: 'net-a' }, { [NET_KEY]: 'missing' }]) {
    const storage = memory(saved);
    const runtime = await start([provider('net-a', 'net.fetch', { isDefault: true, ok: () => { throw new Error('not ready'); } })], { storage });
    try {
      assert.equal(runtime.service('net.fetch', 1), null);
      assert.equal(runtime.selection.resolve('net.fetch', 1).provider, null);
      assert.match(runtime.selection.resolve('net.fetch', 1).status, /net-a is not available\.$/);
      assert.doesNotMatch(runtime.selection.resolve('net.fetch', 1).status, /Using|using/);
      assert.equal(storage.getItem(NET_KEY), saved[NET_KEY] ?? null);
    } finally { await runtime.close(); }
  }
});

test('a ready chosen provider still resolves when the default is unavailable (look selection unchanged)', async () => {
  const storage = memory({ 'self-forming.provider.look@1': 'look-b' });
  const runtime = await start([
    provider('look-a', 'look', { isDefault: true, ok: () => false }),
    provider('look-b', 'look')
  ], { storage });
  try {
    assert.equal(runtime.service('look', 1)(), 'look-b');
    assert.equal(runtime.selection.resolve('look', 1).status, 'Using look-b.');
    assert.equal(storage.getItem('self-forming.provider.look@1'), 'look-b');
  } finally { await runtime.close(); }
});

test('persistence: net.fetch@1 keeps self-forming.net.route; a broken storage neither breaks resolution nor hides the failure', async () => {
  const storage = memory();
  const runtime = await start([provider('net-a', 'net.fetch', { isDefault: true }), provider('net-b', 'net.fetch')], { storage });
  runtime.selection.choose('net.fetch', 1, 'net-b');
  assert.equal(storage.getItem(NET_KEY), 'net-b');
  assert.equal(runtime.selection.choice('net.fetch', 1), 'net-b');
  const broken = await start([provider('net-a', 'net.fetch', { isDefault: true }), provider('net-b', 'net.fetch')], { storage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } } });
  assert.equal(broken.service('net.fetch', 1)(), 'net-a');
  assert.equal(broken.selection.choose('net.fetch', 1, 'net-b'), true);
  assert.match(broken.selection.resolve('net.fetch', 1).status, /The choice could not be saved\./);
  assert.equal(broken.service('net.fetch', 1)(), 'net-a');
  // A service with one provider is unaffected by any stored value.
  const single = await start([provider('only', 'solo', { isDefault: false })], { storage: memory({ 'self-forming.provider.solo@1': 'other' }) });
  assert.equal(single.service('solo', 1)(), 'only');
  for (const r of [runtime, broken, single]) await r.close();
});

// A bridge whose native http answers; native HTTP itself is covered by plugin-x4-net.test.mjs.
const okBridge = (calls) => ({ closed: false, async call(method) { calls.push(method); if (method === 'http.send') return { status: 200, statusText: 'OK', headers: [], url: 'https://x/' }; if (method === 'http.read') return { data: '', done: true }; return {}; }, onClose: () => () => {} });
async function composeNet(storage, bridge) {
  const runtime = runtimeModule.createPluginRuntime({ onError: (error) => { throw error; }, storage });
  const definitions = builtins.createBuiltinPlugins({ openExecution: () => ({}), sessions: undefined, harness: undefined, net: { bridge } });
  for (const definition of definitions) if (['core-net-native', 'core-net-page'].includes(definition.id)) runtime.register(definition);
  await runtime.start();
  return runtime;
}

test('composition: core-net-native is the default provider of net.fetch@1, core-net-page the choice; switching applies to the next request', async () => {
  const storage = memory();
  const calls = [];
  const runtime = await composeNet(storage, okBridge(calls));
  assert.deepEqual(runtime.list().map((r) => [r.id, r.state]), [['core-net-native', 'active'], ['core-net-page', 'active']]);
  assert.deepEqual(runtime.selection.providers('net.fetch', 1).map((p) => [p.id, p.default, p.name]), [['core-net-native', true, 'Native network'], ['core-net-page', false, 'Page fetch (WebView)']]);
  assert.deepEqual(runtime.contributions('settings.sections'), [], 'core-net-native has no settings entry');
  assert.equal(runtime.contributions('net.routes').length, 0, 'no route registry');
  const original = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, init) => { hits.push([url, init]); return 'page-response'; };
  try {
    await (await runtime.service('net.fetch', 1)('https://x/')).text();
    assert.equal(calls[0], 'http.open', 'default: native, no behaviour change');
    assert.equal(hits.length, 0);
    assert.equal(runtime.service('net.fetch', 1).describe().id, 'core-net-native');
    assert.equal(runtime.selection.choose('net.fetch', 1, 'core-net-page'), true);
    assert.equal(storage.getItem(NET_KEY), 'core-net-page');
    assert.equal(await runtime.service('net.fetch', 1)('https://x/', { a: 1 }), 'page-response');
    assert.deepEqual(hits, [['https://x/', { a: 1 }]]);
    // WebView fetch gone: visible fallback to native.
    globalThis.fetch = undefined;
    const before = calls.length;
    await (await runtime.service('net.fetch', 1)('https://x/')).text();
    assert.ok(calls.length > before, 'native again');
    assert.equal(runtime.selection.resolve('net.fetch', 1).status, 'Page fetch (WebView) is not available; using Native network instead.');
  } finally { globalThis.fetch = original; await runtime.close(); }
});

test('without core-net-page a saved choice falls back to native with a reason', async () => {
  const storage = memory({ [NET_KEY]: 'core-net-page' });
  const calls = [];
  const runtime = runtimeModule.createPluginRuntime({ onError: (error) => { throw error; }, storage });
  const definitions = builtins.createBuiltinPlugins({ openExecution: () => ({}), sessions: undefined, harness: undefined, net: { bridge: okBridge(calls) } });
  for (const definition of definitions) if (definition.id === 'core-net-native') runtime.register(definition);
  await runtime.start();
  await (await runtime.service('net.fetch', 1)('https://x/')).text();
  assert.equal(calls[0], 'http.open');
  assert.match(runtime.selection.resolve('net.fetch', 1).status, /Saved provider "core-net-page" is not installed; using Native network instead\./);
  await runtime.close();

});

test('page provider: plain provider of net.fetch@1, WebView fetch, available while fetch exists; manifest', async () => {
  const original = globalThis.fetch;
  try {
    const hits = [];
    globalThis.fetch = async (url, init) => { hits.push([url, init]); return 'ok'; };
    assert.equal(await page.pageFetch('https://x/', { b: 2 }), 'ok');
    assert.deepEqual(hits, [['https://x/', { b: 2 }]]);
    assert.equal(page.pageFetch.available(), true);
    globalThis.fetch = undefined;
    assert.equal(page.pageFetch.available(), false);
  } finally { globalThis.fetch = original; }
  const provided = [];
  page.create().setup({ provide: (...args) => provided.push(args) });
  assert.deepEqual(provided.map(([id, version]) => [id, version]), [['net.fetch', 1]]);
  const { readFile } = await import('node:fs/promises');
  const manifest = async (id) => JSON.parse(await readFile(new URL(`../plugins/${id}/plugin.json`, import.meta.url), 'utf8'));
  const pageManifest = await manifest('core-net-page'), nativeManifest = await manifest('core-net-native');
  assert.deepEqual([pageManifest.id, pageManifest.essential, pageManifest.bundle, pageManifest.builtin, pageManifest.provides], ['core-net-page', false, 'self-forming-core', true, [{ id: 'net.fetch', version: 1 }]]);
  assert.deepEqual(nativeManifest.provides, [{ id: 'net.fetch', version: 1, default: true }]);
});

const fakeDoc = () => ({ createElement: (tag) => new El(tag) });
const deepFind = (node, id) => node.id === id ? node : node.children.filter((c) => c instanceof El).map((c) => deepFind(c, id)).find(Boolean) ?? null;
const providerPlugins = (extra = []) => [provider('net-a', 'net.fetch', { isDefault: true, name: 'Net A' }), { ...provider('net-b', 'net.fetch', { name: 'Net B' }), hint: 'slow' },
  provider('store-a', 'notes', { isDefault: true, name: 'Notes A' }), provider('store-b', 'notes', { name: 'Notes B' }),
  provider('solo', 'single', { isDefault: true }), ...extra];

test('Providers panel: one selector per service with several providers (net.fetch@1 keeps net-route ids), selecting persists, unbind removes the rows', async () => {
  assert.match(providersUi.markup, /<summary>Providers<\/summary>/);
  assert.deepEqual([providersUi.section.slot, providersUi.PROVIDERS_PANEL_ID], ['providers', 'providers-panel']);
  const storage = memory();
  const runtime = await start(providerPlugins(), { storage });
  assert.deepEqual(runtime.selection.services(), [{ id: 'net.fetch', version: 1 }, { id: 'notes', version: 1 }], 'not the single-provider service');
  const doc = fakeDoc(), node = new El('details');
  const unbind = providersUi.bindProvidersPanel({ node, selection: runtime.selection, subscribe: (l) => runtime.subscribe(l), doc });
  assert.equal(node.hidden, false);
  const select = deepFind(node, 'net-route'), line = deepFind(node, 'net-route-status');
  assert.deepEqual(select.options.map((o) => [o.value, o.textContent]), [['net-a', 'Net A'], ['net-b', 'Net B — slow']]);
  assert.equal(select.disabled, false);
  assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.textContent, 'Using Net A.');
  const notes = deepFind(node, 'provider-notes-1-select');
  assert.deepEqual(notes.options.map((o) => o.value), ['store-a', 'store-b']);
  assert.equal(deepFind(node, 'provider-single-1-select'), null);
  select.value = 'net-b';
  await select.dispatch('change');
  assert.equal(storage.getItem(NET_KEY), 'net-b');
  assert.equal(line.textContent, 'Using Net B.');
  notes.value = 'store-b';
  await notes.dispatch('change');
  assert.equal(storage.getItem('self-forming.provider.notes@1'), 'store-b');
  // Live: a stopped provider shows as not active with the runtime's reason.
  await runtime.stop('net-b');
  assert.equal(select.options[1].textContent, 'Net B — slow (not active)');
  assert.match(line.textContent, /Net B is not active; using Net A instead\./);
  assert.equal(select.value, 'net-b', 'the saved choice stays shown');
  unbind();
  assert.equal(node.hidden, true);
  assert.equal(deepFind(node, 'net-route'), null);
  await runtime.close();
});

test('Providers panel: a binding unbound DURING a snapshot notification never renders again (no duplicated rows on hand-over)', async () => {
  // The browser's bundled -> composed hand-over: a subscribe() that notifies a snapshot of its
  // listeners; the first listener (settings refresh) unbinds the fallback binding and binds the
  // composed one on the SAME shared node; the snapshot then still calls the old render.
  const runtime = await start(providerPlugins());
  const doc = fakeDoc(), node = new El('details');
  const listeners = new Set();
  const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
  const notify = () => { for (const l of [...listeners]) l(); };
  let second = null;
  listeners.add(() => { if (!second) { unbindFirst(); second = providersUi.bindProvidersPanel({ node, selection: runtime.selection, subscribe, doc }); } });
  const unbindFirst = providersUi.bindProvidersPanel({ node, selection: runtime.selection, subscribe, doc });
  notify();
  const count = (id) => { let n = 0; const walk = (el) => { if (el.id === id) n++; for (const c of el.children) if (c instanceof El) walk(c); }; walk(node); return n; };
  assert.equal(count('net-route'), 1, 'one Network provider row, not two');
  assert.equal(count('provider-notes-1-select'), 1);
  notify();
  assert.equal(count('net-route'), 1);
  second();
  assert.equal(count('net-route'), 0);
  await runtime.close();
});

test('Providers panel: no service with several providers = nothing shown; slot names', async () => {
  const runtime = await start([provider('only', 'solo', { isDefault: true })]);
  const node = new El('details');
  providersUi.bindProvidersPanel({ node, selection: runtime.selection, subscribe: (l) => runtime.subscribe(l), doc: fakeDoc() });
  assert.equal(node.hidden, true);
  assert.equal(providersUi.providerSlotName('net.fetch', 1), 'provider:net.fetch@1');
  assert.equal(providersUi.rowLabel('look', 1), 'Look');
  assert.equal(providersUi.rowLabel('net.fetch', 1), 'Network provider');
  assert.deepEqual(providersUi.rowIds('look', 1), { select: 'provider-look-1-select', status: 'provider-look-1-status' });
  assert.equal(providersUi.providerSlot('plugins', fakeDoc()), null);
  await runtime.close();
});
