// Real browser composition and owner controllers; fake cors-rot only at its library boundary.
// No real storage/account/network access. Ordinary browser fetch remains independent bootstrap.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createBrowserNetwork, migrateNetworkRoute } from '../apps/browser/browser-network.js';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createAuthHost, createSelectedFetch } from '../apps/common/auth-host.js';
import { fetchOption } from '../plugins/core-agent/web/open-sessions.js';
import { assembleApp } from './plugin-agent-support.mjs';
import { El, all } from './plugin-p4-support.mjs';
const KEY = 'self-forming.net.route', OLD = 'self-forming.browser.network-mode', MARK = `${OLD}.migrated`;
const NODE = 'self-forming.tailscale.state.node', EXIT = 'self-forming.tailscale.exit-node';
function memory(initial = {}) {
  const values = { ...initial };
  for (const [name, fn] of Object.entries({ getItem: k => values[k] ?? null, setItem: (k,v) => { values[k] = String(v); }, removeItem: k => { delete values[k]; } })) Object.defineProperty(values, name, { value: fn });
  return values;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
function library() {
  const instances = [], log = [];
  return { instances, log, loadCorsRot: async () => ({ createCorsRot(options) {
    const owner = options.tailscale?.storage === null ? 'tor' : 'tailscale';
    const storage = options.tailscale?.storage;
    let mode = options.transport, ts = { state: 'off', exitNodes: [] }, torState = 'idle', disposed = false;
    const listeners = new Set(), tsListeners = new Set(), proxyListeners = new Set();
    const proxy = () => ({ state: mode === 'tor' ? 'running' : 'stopped', active: mode === 'tor', helped: 2, bytes: 42 });
    const snapshot = () => ({ transport: mode, mode, torState, progress: torState === 'initializing' ? { phase: 'directory', done: 1, total: 2, since: Date.now() } : null });
    const emit = () => { for (const fn of listeners) fn(snapshot()); for (const fn of tsListeners) fn(ts); for (const fn of proxyListeners) fn(proxy()); };
    const net = {
      owner, options, setTs: (state, exit = null) => { ts = { state, exitNodes: [{ id: 'home', online: true, name: 'Home' }], appliedExitNode: exit, selectedExitNode: exit }; emit(); },
      readyTor: () => { torState = 'ready'; emit(); },
      fetch: async (url, init) => { log.push(['fetch', owner, mode, url, init]); return new Response(`${owner}-response`); },
      fetchTor: async url => { log.push(['explicitTor', owner, mode, url]); torState = 'ready'; emit(); return new Response('explicit-tor'); },
      connect: async (host, port, options) => {
        log.push(['connect', owner, host, port, options]);
        if (options?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        let closed = false;
        const stream = { read: async () => closed ? undefined : new Uint8Array([1]), write: async data => log.push(['write', owner, data.length]), close: async () => { if (!closed) { closed = true; log.push(['close', owner]); } } };
        options?.signal?.addEventListener('abort', () => { void stream.close(); }, { once: true });
        return stream;
      },
      preconnect: async url => { log.push(['preconnect', owner, url]); return { route: mode, warmed: true }; },
      warmUp() {
        log.push(['warmUp', owner]);
        if (mode === 'tor' && torState !== 'ready') { torState = 'initializing'; emit(); }
        if (mode === 'tailscale') {
          const have = storage?.getItem(NODE), exit = storage?.getItem(EXIT);
          ts = { state: have ? 'Running' : 'NeedsLogin', loginURL: have ? undefined : 'https://login.example.test/', exitNodes: [], appliedExitNode: have ? exit : null };
          emit();
        }
      },
      setTransport(value) { mode = value; log.push(['mode', owner, value]); emit(); },
      getStatus: snapshot,
      subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
      tor: { stop() { log.push(['torStop', owner]); torState = 'idle'; } },
      snowflakeProxy: { getStatus: proxy, subscribe(fn) { proxyListeners.add(fn); fn(proxy()); return () => proxyListeners.delete(fn); }, stop() { log.push(['proxyStop', owner]); } },
      tailscale: {
        subscribe(fn) { tsListeners.add(fn); fn(ts); return () => tsListeners.delete(fn); }, getStatus: () => ts,
        async stop() { log.push(['logout', owner]); for (const key of Object.keys(storage ?? {})) if (key.startsWith('self-forming.tailscale.state.')) storage.removeItem(key); ts = { state: 'off', exitNodes: [] }; emit(); },
        setAuthKey() {}, async setExitNode(id) { storage.setItem(EXIT, id); net.setTs('Running', id); }
      },
      async dispose() { if (disposed) return; disposed = true; log.push(['dispose', owner]); await net.tailscale.stop(); listeners.clear(); tsListeners.clear(); proxyListeners.clear(); }
    };
    instances.push(net); log.push(['create', owner]); return net;
  } }) };
}
let app, bootstrap, builtins, providersSection;
before(async () => { app = await assembleApp(); bootstrap = await app.load('plugin-bootstrap.js'); builtins = await app.load('plugin-builtins.js'); providersSection = (await app.load('builtin/core-plugin-management/web/index.js')).providersSection; });
after(async () => { await app?.remove(); });
function fixture(initial = {}) {
  const storage = memory(initial), lib = library(), direct = [];
  const network = createBrowserNetwork({ storage, origin: 'https://app.example.test/index.html', loadCorsRot: lib.loadCorsRot,
    nativeFetch: async (input, init) => { direct.push([input, init]); return new Response('page'); } });
  network.configureSettingsProvider(providersSection);
  return { storage, lib, direct, network };
}
async function compose(f) {
  const bridgeCalls = [];
  const bridge = { closed: false, onClose: () => () => {}, call: async method => { bridgeCalls.push(method); throw new Error(`Unexpected bridge ${method}`); } };
  const saved = globalThis.localStorage;
  globalThis.localStorage = f.storage;
  try {
    const result = await bootstrap.startPluginComposition({ bridge, browserNetwork: f.network,
      hostInfo: { platform: 'browser', capabilities: {} }, loadDevTools: async () => null, onError: () => {} });
    return { ...result, bridgeCalls };
  } finally { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved; }
}

test('legacy migration once only when canonical is absent; existing choices win and failed persistence retries', () => {
  for (const legacy of [null, 'tor', 'tailscale', 'auto', 'direct']) {
    const storage = memory(legacy === null ? {} : { [OLD]: legacy }); migrateNetworkRoute(storage);
    assert.equal(storage.getItem(KEY), legacy === null ? null : legacy === 'tor' ? 'net-tor' : 'net-tailscale');
    storage.removeItem(KEY); migrateNetworkRoute(storage);
    assert.equal(storage.getItem(KEY), null, 'choosing default cannot revive the old saved route');
    assert.equal(storage.getItem(OLD), legacy);
  }
  for (const choice of ['net-tailscale', 'net-tor', 'core-net-page', 'unknown', '']) {
    const storage = memory({ [OLD]: 'tor', [KEY]: choice }); migrateNetworkRoute(storage); assert.equal(storage.getItem(KEY), choice);
  }
  const storage = memory({ [OLD]: 'tor' });
  const failing = { getItem: storage.getItem, setItem() { throw new Error('full'); } };
  migrateNetworkRoute(failing); assert.equal(storage.getItem(MARK), null); assert.equal(storage.getItem(OLD), 'tor');
  migrateNetworkRoute(storage); assert.equal(storage.getItem(KEY), 'net-tor');
});

test('real browser composition defaults to Tailscale, no native; sign-in is unavailable, same-origin independent, same instance recovers', async () => {
  const f = fixture(); let composition;
  try {
    assert.equal(f.lib.instances.length, 0, 'host construction is lazy');
    composition = await compose(f); await tick();
    const { runtime } = composition;
    assert.ok(!runtime.list().some(row => row.id === 'core-net-native'));
    assert.equal(runtime.selection.resolve('net.fetch', 1).default, 'net-tailscale');
    assert.equal(runtime.selection.resolve('net.fetch', 1).value, null);
    assert.match((await f.network.getStatus()).status, /not available/);
    assert.deepEqual(f.lib.instances.map(net => net.owner), ['tailscale']);
    const fetch = fetchOption({ bridge: {}, networkFetch: f.network.fetch }, { net: () => runtime.service('net.fetch', 1) }).fetch;
    await assert.rejects(fetch('https://models.example.test/'), /unavailable/);
    assert.equal(await (await fetch('/asset.wasm', { credentials: 'same-origin' })).text(), 'page');
    assert.equal(f.direct.length, 1);
    f.lib.instances[0].setTs('Running', 'home'); await tick();
    assert.equal(await (await fetch('https://models.example.test/')).text(), 'tailscale-response');
    f.lib.instances[0].setTs('NeedsLogin'); await tick();
    await assert.rejects(fetch('https://models.example.test/'), /unavailable/);
    assert.equal(f.direct.length, 1, 'external traffic never used page fetch');
    assert.equal(f.lib.instances.length, 1); assert.equal(composition.bridgeCalls.length, 0);
  } finally { await composition?.runtime.close(); await f.network.dispose(); }
});

test('fallback-first -> composition -> detach/reattach/failure uses one owner node; page disposal preserves state, explicit sign-out is separate', async () => {
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' }); let composition;
  try {
    await f.network.warmUp();
    assert.equal(await (await f.network.fetch('https://models.example.test/')).text(), 'tailscale-response');
    composition = await compose(f); await tick();
    for (let i = 0; i < 3; i++) { f.network.bind(null); f.network.bind(composition.runtime); }
    assert.equal(await (await f.network.fetch('https://models.example.test/')).text(), 'tailscale-response');
    assert.equal(f.lib.instances.length, 1);
    assert.equal(f.lib.log.filter(row => row[0] === 'logout').length, 0, 'handoff never logs out');
    await composition.runtime.close();
    f.network.bind(null); // Full composition failed/closed: explicit bundled recovery attachment.
    assert.equal(await (await f.network.fetch('https://models.example.test/')).text(), 'tailscale-response');
    assert.equal(f.lib.instances.length, 1);
    await f.network.dispose(); await f.network.dispose();
    // Page disposal must not dispose/close the Tailscale node: upstream close() logs it out server-side.
    assert.equal(f.lib.log.filter(row => row[0] === 'dispose').length, 0);
    assert.equal(f.lib.log.filter(row => row[0] === 'logout').length, 0);
    assert.equal(f.storage.getItem(NODE), 'saved-state', 'upstream close/logout removal cannot erase persisted reload state');
    assert.equal(f.storage.getItem(EXIT), 'home');
    await assert.rejects(f.network.fetch('https://models.example.test/'), /disposed/);
  } finally { await composition?.runtime.close(); await f.network.dispose(); }
  const signed = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
  try { await signed.network.warmUp(); await signed.network.tailscale.logout(); assert.equal(signed.storage.getItem(NODE), null); assert.equal(signed.storage.getItem(EXIT), null); }
  finally { await signed.network.dispose(); }
});

test('actual setup failure AFTER attaching recovers with the same page controller, unlike normal unready/stopped selection', async () => {
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
  const runtime = createPluginRuntime({ storage: f.storage });
  try {
    const definitions = builtins.createBuiltinPlugins({ sessions: null, net: { browser: true, routes: { controllers: f.network.controllers } } });
    for (const def of definitions.filter(row => ['net-tailscale', 'net-tor', 'core-net-page'].includes(row.id))) {
      const setup = def.setup;
      runtime.register(def.id === 'net-tailscale' ? { ...def, setup(ctx) { setup(ctx); throw new Error('after setup failure'); } } : def);
    }
    f.network.bind(runtime); await runtime.start(); await tick();
    assert.equal(runtime.list().find(row => row.id === 'net-tailscale').state, 'failed');
    assert.equal(f.network.needsRecovery(), true);
    assert.equal(await (await f.network.fetch('https://models.example.test/')).text(), 'tailscale-response');
    assert.equal(f.lib.instances.length, 1);
    assert.equal(f.lib.log.filter(row => row[0] === 'logout').length, 0);
    const auth = createAuthHost({ call() { throw new Error('HTTP bridge recursion'); } }, {
      fetch: createSelectedFetch({ runtime: () => runtime, fallback: () => f.network.fetch })
    });
    assert.equal(await (await auth.fetch('https://auth.example.test/')).text(), 'tailscale-response');
  } finally { await runtime.close(); await f.network.dispose(); }
});

test('Tor selection/reselection, explicit worker Tor, status and selected raw TCP adjunct/cancel remain distinct from signout', async () => {
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' }); let composition;
  try {
    composition = await compose(f); await tick();
    const states = []; const off = await f.network.subscribe(s => states.push(s));
    assert.equal(await (await f.network.fetchTor('https://explicit.example.test/')).text(), 'explicit-tor');
    assert.equal((await f.network.getStatus()).mode, 'tailscale');
    assert.ok(f.lib.log.some(row => row[0] === 'explicitTor' && row[2] === 'tailscale'), 'explicit Tor did not select Tor/proxy mode');
    await f.network.setMode('tor'); await tick();
    const tor = f.lib.instances.find(net => net.owner === 'tor');
    tor.readyTor(); await tick();
    assert.equal(await (await f.network.fetch('https://models.example.test/')).text(), 'tor-response');
    const abort = new AbortController();
    const stream = await f.network.connect('guest.example.test', 443, { tls: false, signal: abort.signal, timeoutMs: 30000 });
    await stream.write(new Uint8Array([1, 2])); assert.deepEqual(await stream.read(), new Uint8Array([1]));
    abort.abort(); await tick(); assert.equal(await stream.read(), undefined);
    assert.ok(f.lib.log.some(row => row[0] === 'close' && row[1] === 'tor'));
    assert.equal((await f.network.preconnect('https://models.example.test/')).route, 'tor');
    await f.network.setMode('tailscale'); await tick();
    assert.ok(f.lib.log.some(row => row[0] === 'torStop')); assert.ok(f.lib.log.some(row => row[0] === 'proxyStop'));
    assert.equal(f.lib.log.filter(row => row[0] === 'logout').length, 0);
    await f.network.setMode('tor'); await tick(); tor.readyTor();
    assert.equal(f.lib.instances.filter(net => net.owner === 'tor').length, 1);
    assert.ok(states.some(s => s.mode === 'tor' && s.torState === 'ready')); off();
  } finally { await composition?.runtime.close(); await f.network.dispose(); }
});

test('saved unavailable/unknown intent never starts an arbitrary fallback; explicit page choice is the only external direct route', async () => {
  for (const id of ['net-tor', 'not-installed', 'core-net-page']) {
    const f = fixture({ [KEY]: id }); let composition;
    try {
      composition = await compose(f); await tick();
      assert.ok(!f.lib.instances.some(net => net.owner === 'tailscale'), 'does not start default on a saved different intent');
      if (id === 'core-net-page') {
        // core-net-page is deliberately ordinary global fetch; selection is explicit, not a fallback.
        const original = globalThis.fetch;
        globalThis.fetch = async () => new Response('explicit page');
        try { assert.equal(await (await f.network.fetch('https://external.example.test/')).text(), 'explicit page'); }
        finally { globalThis.fetch = original; }
      } else {
        await assert.rejects(f.network.fetch('https://external.example.test/'), /unavailable/);
        assert.equal(f.direct.length, 0);
      }
      assert.equal(f.storage.getItem(KEY), id);
    } finally { await composition?.runtime.close(); await f.network.dispose(); }
  }
});

test('essential setup failure uses owning recovery, but an intentionally stopped provider is not a failed composition', async () => {
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' }); let composition;
  try {
    composition = await compose(f); await tick();
    await composition.runtime.stop('net-tailscale');
    assert.equal(f.network.needsRecovery(), false);
    await assert.rejects(f.network.fetch('https://external.example.test/'), /not active/);
    await assert.rejects(f.network.warmUp(), /not active/);
    f.network.bind(null); // explicit full-composition fallback, not service unavailability
    assert.equal(await (await f.network.fetch('https://external.example.test/')).text(), 'tailscale-response');
    const failed = createPluginRuntime({ storage: f.storage });
    failed.register({ id: 'essential-broken', version: '1.0.0', essential: true, setup() { throw new Error('broken composition'); } });
    await failed.start(); f.network.bind(failed);
    assert.equal(f.network.needsRecovery(), true);
    assert.equal(await (await f.network.fetch('https://external.example.test/')).text(), 'tailscale-response');
    assert.equal(f.lib.instances.length, 1);
    f.network.bind(null); await failed.close();
  } finally { await composition?.runtime.close(); await f.network.dispose(); }
});

test('new runtime attachments reuse owner and remove scoped subscriptions without logout; late load cannot resurrect disposed controller', async () => {
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
  const runtimes = [];
  try {
    await f.network.warmUp();
    for (let i = 0; i < 3; i++) {
      const runtime = createPluginRuntime({ storage: f.storage }); runtimes.push(runtime);
      for (const def of builtins.createBuiltinPlugins({ sessions: null, net: { browser: true, routes: { controllers: f.network.controllers } } }).filter(row => row.provides.some(dep => dep.id === 'net.fetch'))) runtime.register(def);
      f.network.bind(runtime); await runtime.start();
      assert.equal(await (await f.network.fetch('https://external.example.test/')).text(), 'tailscale-response');
      f.network.bind(null); await runtime.close();
    }
    assert.equal(f.lib.instances.length, 1);
    assert.equal(f.lib.log.filter(row => row[0] === 'logout').length, 0);
  } finally { for (const runtime of runtimes) await runtime.close(); await f.network.dispose(); }
  let release, created = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const network = createBrowserNetwork({ storage: memory(), loadCorsRot: () => pending });
  const warming = network.warmUp();
  await network.dispose();
  release({ createCorsRot() { created++; throw new Error('must not resurrect'); } });
  await warming;
  assert.equal(created, 0);
});

test('actual VM TCP bridge closes a route stream when the guest cancels before connect resolves', async () => {
  const { createNetworkBridge } = await import('../plugins/exec-linux/web/browser/browser-v86-worker.js');
  const { EventEmitter } = await import('node:events');
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
  try {
    await f.network.warmUp();
    const adapter = { send() {}, receive() {} };
    const bridge = createNetworkBridge(adapter, (host, port, timeoutMs) => f.network.connect(host, port, { tls: false, timeoutMs }));
    const conn = new EventEmitter(); Object.assign(conn, { state: 'established', psrc: [203, 0, 113, 8], sport: 443,
      close() { this.emit('close'); }, write() { throw new Error('cancelled guest must not get data'); } });
    adapter.on_tcp_connection(conn, {}); conn.close(); await tick();
    assert.equal(bridge.stats().connections, 1);
    assert.ok(f.lib.log.some(row => row[0] === 'connect' && row[1] === 'tailscale' && row[2] === '203.0.113.8' && row[3] === 443));
    assert.ok(f.lib.log.some(row => row[0] === 'close' && row[1] === 'tailscale'));
  } finally { await f.network.dispose(); }
});


test('bundled recovery mounts the actual generic Providers selector and owner sign-in options, with no duplicate section after composition', async () => {
  const f = fixture(); let composition, unmountPanel, unmountOptions;
  const home = new El('div');
  const doc = { getElementById: () => home, createElement(tag) {
    if (tag !== 'template') return Object.assign(new El(tag), { ownerDocument: doc });
    const template = { content: { children: [] }, set innerHTML(html) {
      assert.match(html, /id="providers-settings"/);
      const details = Object.assign(new El('details'), { id: 'providers-settings', ownerDocument: doc });
      const summary = new El('summary'); summary.textContent = 'Providers'; details.append(summary);
      template.content.children = [details];
    } }; return template;
  } };
  try {
    await f.network.warmUp();
    const rows = f.network.settingsRuntime.contributions('settings.sections');
    const panel = rows.find(row => row.key === 'providers');
    assert.ok(panel, 'recovery still has generic Settings → Providers');
    const root = Object.assign(new El('div'), { ownerDocument: doc });
    unmountPanel = panel.value.mount(root);
    const select = all(root).find(node => node.id === 'net-route');
    assert.deepEqual(select.options.map(option => option.value), ['net-tailscale', 'core-net-page', 'net-tor']);
    assert.equal(select.value, 'net-tailscale');
    assert.match(all(root).find(node => node.id === 'net-route-status').textContent, /not available/);
    const ownerRoot = Object.assign(new El('div'), { ownerDocument: doc });
    unmountOptions = rows.find(row => row.providerId === 'net-tailscale').value.mount(ownerRoot);
    assert.equal(all(ownerRoot).find(node => node.id === 'net-tailscale-login').hidden, false, 'bundled recovery can sign in');
    select.value = 'net-tor'; await select.dispatch('change'); await tick();
    assert.equal((await f.network.getStatus()).mode, 'tor');
    assert.ok(f.lib.instances.some(net => net.owner === 'tor'));
    composition = await compose(f); await tick();
    const composedRows = f.network.settingsRuntime.contributions('settings.sections');
    assert.equal(composedRows.filter(row => row.providerId === 'net-tailscale').length, 1);
    assert.equal(composedRows.filter(row => row.key === 'providers').length, 1);
  } finally { unmountOptions?.(); unmountPanel?.(); await composition?.runtime.close(); await f.network.dispose(); }
});

test('real host HTTP stream framing/backpressure/cancel and auth consume the same owning selected controller', async () => {
  const { createBrowserHost } = await import('../apps/browser/browser-host.js');
  const { Vfs, MemoryBackend } = await import('../plugins/core-execution/web/browser/browser-vfs.js');
  const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
  const saved = globalThis.localStorage; globalThis.localStorage = f.storage;
  let host, composition;
  try {
    composition = await compose(f); await tick();
    let pulls = 0, cancelled = 0, signal;
    f.lib.instances[0].fetch = async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(150000).fill(65)); },
        cancel() { cancelled++; }
      }, { highWaterMark: 0 }), { headers: { 'x-route': 'owner' } });
    };
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    host = await createBrowserHost({ vfs, network: f.network });
    let seq = 0; const pending = new Map();
    host.transport.onmessage = ({ data }) => {
      const reply = JSON.parse(data), waiter = pending.get(reply.id);
      if (!waiter) return; pending.delete(reply.id);
      reply.ok ? waiter.resolve(reply.result) : waiter.reject(new Error(reply.error.message));
    };
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); host.transport.postMessage(JSON.stringify({ id, method, params }));
    });
    await call('http.open', { requestId: 'owner-stream', url: 'https://models.example.test/', method: 'GET' });
    assert.equal((await call('http.send', { requestId: 'owner-stream' })).status, 200);
    assert.equal(pulls, 0, 'headers do not prefetch response bytes');
    for (let i = 0; i < 2; i++) assert.equal(Buffer.from((await call('http.read', { requestId: 'owner-stream' })).data, 'base64').length, 65536);
    assert.equal(pulls, 1, 'bounded bridge reads drain existing upstream chunk');
    await call('http.cancel', { requestId: 'owner-stream' });
    assert.equal(cancelled, 1); assert.equal(signal.aborted, true);
    const auth = createAuthHost({ call() { throw new Error('auth HTTP must not recurse through bridge'); } }, { fetch: f.network.fetch });
    assert.equal(await (await auth.fetch('https://app.example.test/callback-helper')).text(), 'page');
    assert.equal(f.direct.length, 1);
    assert.equal(f.lib.instances.length, 1);
  } finally { host?.dispose(); await composition?.runtime.close(); await f.network.dispose(); if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved; }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('same-runtime essential failure cannot revive stopped/blocked selected provider or stopped default', async () => {
  for (const state of ['stopped', 'blocked']) {
    const f = fixture({ [NODE]: 'saved-state', [EXIT]: 'home' });
    const failed = deferred(), entered = deferred();
    const runtime = createPluginRuntime({ storage: f.storage });
    try {
      await f.network.warmUp();
      for (const def of builtins.createBuiltinPlugins({ sessions: null, net: { browser: true, routes: { controllers: f.network.controllers } } }).filter(row => row.provides.some(dep => dep.id === 'net.fetch'))) {
        runtime.register(def.id === 'net-tailscale' && state === 'blocked' ? { ...def, unavailable: 'deliberately blocked' }
          : def.id === 'net-tor' ? { ...def, setup() { throw new Error('Tor setup failed'); } } : def);
      }
      runtime.register({ id: 'essential-broken', version: '1.0.0', essential: true, async setup() { entered.resolve(); await failed.promise; } });
      f.network.bind(runtime);
      const starting = runtime.start(); await entered.promise;
      if (state === 'stopped') await runtime.stop('net-tailscale');
      assert.equal(f.network.controllers['net-tailscale'].service.available(), true, 'page node intentionally stays ready');
      failed.reject(new Error('unrelated essential failure')); await starting;
      assert.equal(runtime.list().find(row => row.id === 'net-tailscale').state, state);
      assert.equal(runtime.list().find(row => row.id === 'essential-broken').state, 'failed');
      assert.equal(f.network.needsRecovery(), false, 'explicit stop/block wins over essential failure IN THIS runtime');
      await assert.rejects(f.network.fetch('https://external.example.test/'), /not active/);
      await assert.rejects(f.network.connect('external.example.test', 443, {}), /not active/);
      runtime.selection.choose('net.fetch', 1, 'net-tor'); await tick();
      assert.equal(f.network.needsRecovery(), true, 'failed selected Tor can recover, but cannot use suppressed default');
      await assert.rejects(f.network.fetch('https://external.example.test/'), /unavailable/);
      await assert.rejects(f.network.connect('external.example.test', 443, {}), /unavailable/);
      assert.equal(f.lib.log.filter(row => ['fetch', 'connect'].includes(row[0])).length, 0);
      assert.equal(f.direct.length, 0);
    } finally { failed.resolve(); await runtime.close(); await f.network.dispose(); }
  }
});

test('both owners reconcile deselection-skip/reselection microtask before pending load finally, without retry loops on errors', async () => {
  for (const id of ['net-tailscale', 'net-tor']) {
    const { createController } = await import(`../plugins/${id}/web/index.js`);
    const lib = library(), loading = deferred(), entered = deferred(); let loads = 0;
    const controller = createController({ hostInfo: { platform: 'browser' }, loadCorsRot() { loads++; entered.resolve(); return loading.promise; } });
    try {
      controller.setSelected(true); await entered.promise;
      controller.setSelected(false);
      loading.resolve(await lib.loadCorsRot());
      // The await-load continuation checks !selected first. This reselection lands
      // BEFORE its catch/finally, when begin() still sees the pending attempt.
      queueMicrotask(() => controller.setSelected(true));
      await tick();
      assert.equal(lib.instances.length, 1, `${id} must not strand selected activation`);
      assert.equal(loads, 2, 'exactly one reconciliation after skipped activation');
      assert.ok(lib.log.some(row => row[0] === 'warmUp'));
    } finally { await controller.dispose(); }
    let failures = 0;
    const broken = createController({ loadCorsRot: async () => { failures++; throw new Error('real load error'); } });
    try {
      broken.setSelected(true); await tick(); await tick();
      assert.equal(failures, 1, 'no automatic genuine-error retry loop');
      broken.setSelected(false); broken.setSelected(true); await tick();
      assert.equal(failures, 2, 'explicit reselection can retry');
    } finally { await broken.dispose(); }
  }
});

test('explicit Tor demand survives joining a selection load then deselecting; cancellation/disposal withdraw demand', async () => {
  const { createController } = await import('../plugins/net-tor/web/index.js');
  for (const outcome of ['success', 'cancel', 'dispose']) {
    const lib = library(), loading = deferred(), entered = deferred();
    const controller = createController({ loadCorsRot() { entered.resolve(); return loading.promise; } });
    const abort = new AbortController();
    try {
      controller.setSelected(true); await entered.promise;
      const request = controller.service.transport.fetchTor('https://explicit.example.test/', { signal: abort.signal });
      controller.setSelected(false);
      if (outcome === 'cancel') abort.abort();
      if (outcome === 'dispose') await controller.dispose();
      if (outcome !== 'success') await assert.rejects(request, { name: 'AbortError' }); // rejects BEFORE loader release
      loading.resolve(await lib.loadCorsRot());
      if (outcome === 'success') {
        assert.equal(await (await request).text(), 'explicit-tor');
        assert.equal(lib.instances.length, 1);
        assert.equal(lib.instances[0].options.transport, 'tailscale', 'explicit Tor must not start selected-route proxy');
        assert.ok(lib.log.some(row => row[0] === 'explicitTor'));
        assert.ok(!lib.log.some(row => row[0] === 'warmUp'), 'no unused Tailscale start or Tor proxy warmup');
      } else {
        await tick(); assert.equal(lib.instances.length, 0, 'withdrawn explicit demand must not create a node');
        assert.ok(!lib.log.some(row => row[0] === 'explicitTor'));
      }
    } finally { loading.resolve(await lib.loadCorsRot()); await controller.dispose(); }
  }
});

test('browser persistence state and owner settings report absent/throwing storage honestly', async () => {
  const { createBrowserStorage, createController } = await import('../plugins/net-tailscale/web/index.js');
  for (const absent of [true, false]) {
    const underlying = memory({ [NODE]: 'saved-state', [EXIT]: 'home' });
    const backend = absent ? null : { getItem: underlying.getItem, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } };
    const browserStorage = createBrowserStorage(backend), lib = library();
    const controller = createController({ browserStorage, loadCorsRot: lib.loadCorsRot, hostInfo: { platform: 'browser' } });
    const doc = { createElement: tag => Object.assign(new El(tag), { ownerDocument: doc }) };
    const root = Object.assign(new El('div'), { ownerDocument: doc }); let unmount;
    try {
      controller.setSelected(true); await controller.service.transport.warmUp();
      unmount = controller.section.mount(root);
      if (!absent) await lib.instances[0].tailscale.setExitNode('home');
      assert.equal(browserStorage.state.persistent, false);
      assert.equal(browserStorage.state.lost, !absent);
      const note = all(root).find(row => row.id === 'net-tailscale-storage');
      assert.equal(note.hidden, false);
      assert.match(note.textContent, absent ? /No browser storage/ : /could not be saved or read in this browser/);
      assert.match(note.textContent, /only until this page closes/);
    } finally { unmount?.(); await controller.dispose(); }
  }
});

test('both routes pass a 10-minute inactivity limit (cors-rot restarts it on every chunk) and keep a 5-minute Tor bootstrap', async () => {
  const f = fixture();
  try {
    await f.network.warmUp().catch(() => {});                 // Tailscale (the default) creates its instance
    await f.network.fetchTor('https://check.example.test/').catch(() => {});   // explicit Tor creates the Tor one
    await tick();
    const byOwner = Object.fromEntries(f.lib.instances.map((net) => [net.owner, net.options]));
    for (const owner of ['tailscale', 'tor']) {
      assert.ok(byOwner[owner], `${owner} instance created`);
      assert.equal(byOwner[owner].timeoutMs, 10 * 60 * 1000, `${owner}: whole-exchange limit`);
      assert.equal(byOwner[owner].tor?.bootstrapTimeoutMs, 5 * 60 * 1000, `${owner}: bootstrap limit unchanged`);
    }
  } finally { await f.network.dispose(); }
});
