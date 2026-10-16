import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';
import { El, all, installDom } from './plugin-p4-support.mjs';

// Step N3: net-tor and net-tailscale, providers of net.fetch@1 over libs/cors-rot. The REAL plugin-runtime.js selection,
// plugin-builtins.js and the two plugin files, against a FAKE cors-rot (injected through loadCorsRot; the real library
// and its WASM are not loaded), a fake bridge (auth.* = the plugin credentials lane) and a mocked DOM. Not on-device.
let app, runtimeModule, builtins, registry, defs, tor, tailscale;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  runtimeModule = await app.load('plugin-runtime.js');
  builtins = await app.load('plugin-builtins.js');
  registry = await app.load('builtin-plugins.js');
  defs = await app.load('builtin-definition.js');
  tor = await app.load('builtin/net-tor/web/index.js');
  tailscale = await app.load('builtin/net-tailscale/web/index.js');
});
after(async () => { await app?.remove(); });

const SECRET = 'SECRETNODEKEY-9f3a';
const LOGIN = 'https://login.tailscale.com/a/SECRETLOGINTOKEN-77';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};

// ---- fakes -------------------------------------------------------------------------------------------------------
function fakeCorsRot() {
  const log = { loads: 0, created: [], fetches: [], transports: [], warmUps: 0, starts: 0, exits: [], logins: 0, logouts: 0, stops: 0, torStops: 0, proxyStops: 0, authKeys: [], startFails: 0 };
  const fake = {
    log, torState: 'initializing', progress: { phase: 'directory' }, lastStartError: null, tailscaleStartError: undefined, failStart: null,
    ts: { state: 'NoState', loginURL: undefined, exitNodes: [], selectedExitNode: null, appliedExitNode: null, error: undefined },
    storage: null, net: null
  };
  fake.loadCorsRot = async () => {
    log.loads++;
    return {
      createCorsRot(options) {
        log.created.push({ transport: options.transport, authKey: options.tailscale?.authKey, tailscale: options.tailscale, document: options.document });
        const listeners = new Set(), tsListeners = new Set();
        let mode = options.transport;
        const snap = () => ({ transport: mode, mode, torState: fake.torState, progress: fake.progress, lastStartError: fake.lastStartError, tailscaleStartError: fake.tailscaleStartError });
        const tsView = () => ({ ...fake.ts, exitNodes: fake.ts.exitNodes.map((n) => ({ ...n })) });
        fake.storage = options.tailscale?.storage ?? null;
        fake.emit = () => { for (const l of listeners) l(snap()); for (const l of tsListeners) l(tsView()); };
        const net = {
          fetch: async (input, init) => { log.fetches.push([String(input), mode]); return { ok: true, via: mode, input }; },
          warmUp() {
            log.warmUps++;
            if (mode === 'tailscale') net.tailscale.start().catch((e) => { fake.tailscaleStartError = e.message; fake.emit(); }); // as cors-rot: never unhandled
            return snap();
          },
          setTransport(name) { mode = name; log.transports.push(name); for (const l of listeners) l(snap()); },
          getStatus: snap,
          subscribe(cb) { listeners.add(cb); cb(snap()); return () => listeners.delete(cb); },
          snowflakeProxy: { stop() { log.proxyStops++; }, getStatus: () => ({ state: mode === 'tor' ? 'running' : 'stopped', helped: 0 }), subscribe(cb) { cb({ state: mode === 'tor' ? 'running' : 'stopped', helped: 0 }); return () => {}; } },
          tor: { stop() { log.torStops++; } },
          tailscale: {
            async stop() { log.stops++; for (const key of Object.keys(fake.storage)) if (key.startsWith('self-forming.tailscale.state.')) fake.storage.removeItem(key); fake.ts = { ...fake.ts, state: 'off', loginURL: undefined, exitNodes: [], appliedExitNode: null }; fake.emit(); },
            setAuthKey(key) { log.authKeys.push(key); },
            async start() {
              log.starts++;
              if (fake.failStart) { log.startFails++; throw new Error(fake.failStart); }
              // As cors-rot: restores its state from the provided storage, asks for a login link when it has none.
              const stored = fake.storage?.getItem('self-forming.tailscale.state.node') ?? '';
              if (stored) { fake.ts.state = 'Running'; fake.restored = stored; } else { fake.ts.state = 'NeedsLogin'; fake.ts.loginURL = LOGIN; }
              const chosen = fake.storage?.getItem('self-forming.tailscale.exit-node');
              if (chosen) { fake.ts.selectedExitNode = chosen; fake.ts.appliedExitNode = chosen; }
              fake.ts.exitNodes = [{ id: 'n1', name: 'home-pi', ip: '100.1.1.1', online: true }, { id: 'n2', name: 'old-box', ip: '100.1.1.2', online: false }];
              fake.emit();
            },
            getStatus: tsView,
            subscribe(cb) { tsListeners.add(cb); cb(tsView()); return () => tsListeners.delete(cb); },
            async setExitNode(id) { log.exits.push(id); fake.storage.setItem('self-forming.tailscale.exit-node', id); fake.ts.selectedExitNode = id; fake.ts.appliedExitNode = id; fake.emit(); },
            login() { log.logins++; },
            async logout() {
              log.logouts++;
              for (const key of Object.keys(fake.storage)) if (key.startsWith('self-forming.tailscale.')) fake.storage.removeItem(key);
              fake.ts.state = 'NeedsLogin'; fake.ts.appliedExitNode = null; fake.ts.selectedExitNode = null; fake.emit();
            }
          },
          network: {}
        };
        fake.net = net;
        return net;
      }
    };
  };
  // The user signs in through the link: the node writes its keys to the provided storage and runs.
  fake.signIn = () => { fake.storage.setItem('self-forming.tailscale.state.node', SECRET); fake.ts.state = 'Running'; fake.ts.loginURL = undefined; fake.emit(); };
  return fake;
}

function fakeBridge({ pluginCredentials = true, records = {}, failLoad = false } = {}) {
  const calls = [];
  return {
    calls, records, closed: false,
    call: async (method, input) => {
      calls.push([method, input.provider, input.record ? JSON.parse(JSON.stringify(input.record)) : undefined]);
      if (failLoad && method === 'auth.load') throw new Error('keystore locked');
      if (method === 'auth.load') return records[input.provider] ?? null;
      if (method === 'auth.save') { records[input.provider] = input.record; return null; }
      if (method === 'auth.clear') { delete records[input.provider]; return null; }
      throw new Error(`unexpected ${method}`);
    },
    hostInfo: { platform: 'android', capabilities: { pluginCredentials } }
  };
}

const native = { id: 'net-native-stub', version: '1.0.0', name: 'Native network', provides: [{ id: 'net.fetch', version: 1, default: true }], setup(ctx) { ctx.provide('net.fetch', 1, Object.assign(() => 'native', {})); } };

async function compose({ fake = fakeCorsRot(), bridge = fakeBridge(), saved = {}, loadCorsRot, defaultRoute } = {}) {
  const storage = memory(saved);
  const runtime = runtimeModule.createPluginRuntime({ storage, onError: (error) => { throw error; } });
  const routes = { selection: runtime.selection, subscribe: (l) => runtime.subscribe(l), refresh: () => runtime.service('net.fetch', 1), bridge, hostInfo: bridge.hostInfo, loadCorsRot: loadCorsRot ?? fake.loadCorsRot };
  runtime.register(defaultRoute ? { ...native, provides: [{ id: 'net.fetch', version: 1 }] } : native);
  for (const id of ['net-tor', 'net-tailscale']) {
    const options = id === defaultRoute ? { provides: [{ id: 'net.fetch', version: 1, default: true }] } : {};
    runtime.register({ ...defs.definitionShell(id, options), ...registry.builtinPlugin(id).entry.create(routes) });
  }
  await runtime.start();
  return { runtime, storage, fake, bridge };
}
const sections = (runtime, id) => runtime.contributions('settings.sections').filter((c) => c.providerId === id);
function mountSection(runtime, id) {
  const [entry] = sections(runtime, id);
  const el = new El('div');
  const dispose = entry.value.mount(el, { id, key: entry.key, title: entry.value.title, signal: new AbortController().signal });
  return { entry, el, dispose, byId: (x) => all(el).find((n) => n.id === x), text: () => all(el).map((n) => n._text).join('|') };
}
let consoleLines, restoreConsole, d;
function captureConsole() {
  consoleLines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { saved[level] = console[level]; console[level] = (...args) => consoleLines.push(args.map(String).join(' ')); }
  restoreConsole = () => { for (const level of Object.keys(saved)) console[level] = saved[level]; };
}
const setup = () => {
  d = installDom({});
  captureConsole();
  // localStorage must never be used for the node's keys: any use fails the test.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error('localStorage written'); }, removeItem: () => {} } });
};
const teardown = () => { restoreConsole(); delete globalThis.localStorage; d.restore(); };

// ---- tests -------------------------------------------------------------------------------------------------------
test('registry: two built-ins in bundle self-forming-net, not essential, not default, providing net.fetch@1', () => {
  for (const id of ['net-tor', 'net-tailscale']) {
    const { manifest } = registry.builtinPlugin(id);
    assert.equal(manifest.bundle, 'self-forming-net');
    assert.equal(manifest.essential, false);
    assert.deepEqual(manifest.provides, [{ id: 'net.fetch', version: 1 }]);
  }
});

test('createBuiltinPlugins: the route providers come only with net.routes (Android page), never otherwise', () => {
  const ids = (options) => builtins.createBuiltinPlugins({ net: { bridge: {} }, sessions: null, ...options }).map((x) => x.id);
  assert.ok(!ids({}).includes('net-tor'));
  const withRoutes = ids({ net: { bridge: {}, routes: {} } });
  assert.ok(withRoutes.includes('net-tor') && withRoutes.includes('net-tailscale'));
  assert.ok(withRoutes.includes('core-net-native') && withRoutes.includes('core-net-page'));
});

test('lazy: nothing is imported, created, started or read from the credentials lane until a provider is selected', async () => {
  setup();
  const { runtime, fake, bridge } = await compose();
  try {
    assert.deepEqual(runtime.list().filter((r) => ['net-tor', 'net-tailscale'].includes(r.id)).map((r) => r.state), ['active', 'active']);
    mountSection(runtime, 'net-tor'); mountSection(runtime, 'net-tailscale');
    await tick();
    assert.equal(fake.log.loads, 0);
    assert.equal(fake.log.created.length, 0);
    assert.deepEqual(bridge.calls, []);
    const list = runtime.selection.providers('net.fetch', 1);
    assert.deepEqual(list.map((p) => [p.id, p.name, p.available]), [['net-native-stub', 'Native network', true], ['net-tailscale', 'Tailscale exit node', false], ['net-tor', 'Tor (Snowflake)', false]]);
    assert.ok(list.find((p) => p.id === 'net-tor').hint.includes('Snowflake proxy'));
    assert.match(list.find((p) => p.id === 'net-tailscale').hint, /exit node/);
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
  } finally { await runtime.close(); teardown(); }
});

test('a lazy default activates without a saved choice; readiness does not select Native or deadlock activation', async () => {
  for (const defaultRoute of ['net-tailscale', 'net-tor']) {
    setup();
    const { runtime, fake, storage } = await compose({ defaultRoute });
    try {
      await tick();
      assert.equal(storage.getItem('self-forming.net.route'), null);
      assert.equal(runtime.selection.choice('net.fetch', 1), null);
      assert.equal(runtime.selection.resolve('net.fetch', 1).default, defaultRoute);
      assert.equal(fake.log.loads, 1, 'only the intended default starts');
      assert.deepEqual(fake.log.created.map((c) => c.transport), [defaultRoute === 'net-tor' ? 'tor' : 'tailscale']);
      assert.equal(runtime.service('net.fetch', 1), null, 'unready default does not fall through to ready Native');
      assert.match(runtime.selection.resolve('net.fetch', 1).status, /is not available\.$/);
      assert.doesNotMatch(runtime.selection.resolve('net.fetch', 1).status, /[Uu]sing/);
      if (defaultRoute === 'net-tor') { fake.torState = 'ready'; fake.emit(); }
      else { fake.signIn(); await fake.net.tailscale.setExitNode('n1'); }
      await tick();
      assert.equal(runtime.service('net.fetch', 1).describe().id, defaultRoute);
      assert.equal((await runtime.service('net.fetch', 1)('https://example.org/')).via, defaultRoute === 'net-tor' ? 'tor' : 'tailscale');
      assert.equal(runtime.selection.choose('net.fetch', 1, 'net-native-stub'), true);
      await tick();
      if (defaultRoute === 'net-tor') {
        assert.equal(fake.log.torStops, 1);
        assert.equal(fake.log.proxyStops, 1);
      } else assert.equal(fake.log.stops, 0, 'deselection is not sign out');
      assert.equal(runtime.selection.choose('net.fetch', 1, defaultRoute), true);
      await tick();
      assert.equal(storage.getItem('self-forming.net.route'), null, 'selecting default clears the saved choice');
      assert.equal(fake.log.loads, 1, 'reuses the owning route instance');
      if (defaultRoute === 'net-tor') assert.deepEqual(fake.log.transports, ['tailscale', 'tor']);
      else assert.equal(runtime.service('net.fetch', 1).describe().id, 'net-tailscale');
    } finally { await runtime.close(); teardown(); }
  }
});

test('a saved intended choice suppresses lazy default activation even while choice is unready', async () => {
  setup();
  const { runtime, fake } = await compose({ defaultRoute: 'net-tailscale', saved: { 'self-forming.net.route': 'net-tor' } });
  try {
    await tick();
    assert.deepEqual(fake.log.created.map((c) => c.transport), ['tor']);
    assert.equal(runtime.service('net.fetch', 1), null);
    assert.equal(runtime.selection.resolve('net.fetch', 1).choice, 'net-tor');
    assert.equal(runtime.selection.resolve('net.fetch', 1).default, 'net-tailscale');
  } finally { await runtime.close(); teardown(); }
});

test('Tor: selecting starts it (Snowflake proxy with it); until connected the runtime uses Native with a visible reason; then Tor carries requests', async () => {
  setup();
  const { runtime, fake, storage } = await compose();
  try {
    const view = mountSection(runtime, 'net-tor');
    assert.equal(view.entry.value.slot, 'provider:net.fetch@1');
    assert.match(view.byId('net-tor-status').textContent, /not running/);
    assert.match(view.byId('net-tor-proxy').textContent, /Snowflake proxy/);
    const seen = [];
    runtime.subscribe(() => seen.push(runtime.selection.resolve('net.fetch', 1).reason));
    assert.equal(runtime.selection.choose('net.fetch', 1, 'net-tor'), true);
    await tick();
    assert.equal(fake.log.loads, 1);
    assert.deepEqual(fake.log.created.map((c) => c.transport), ['tor'], 'only Tor is created; no Tailscale instance');
    assert.equal(fake.log.warmUps, 1);
    assert.equal(runtime.service('net.fetch', 1)(), 'native', 'falls back while Tor bootstraps');
    assert.equal(runtime.selection.resolve('net.fetch', 1).reason, 'Tor (Snowflake) is not available; using Native network instead.');
    assert.match(view.byId('net-tor-status').textContent, /Starting Tor: downloading the Tor directory/);
    assert.match(view.byId('net-tor-proxy').textContent, /also runs a Snowflake proxy/);
    // Connected: the status line of the selector is refreshed by the plugin and requests go through Tor.
    fake.torState = 'ready'; fake.progress = null; fake.emit();
    await tick();
    assert.ok(seen.includes(null), 'selector listeners were told that Tor became available');
    const route = runtime.service('net.fetch', 1);
    assert.equal(await route('https://example.org/').then((r) => r.via), 'tor');
    assert.equal(route.describe().id, 'net-tor');
    assert.match(view.byId('net-tor-status').textContent, /Connected to Tor/);
    // Another provider again: the Snowflake proxy is stopped (cors-rot follows its transport) and Native is used.
    runtime.selection.choose('net.fetch', 1, null);
    await tick();
    assert.deepEqual(fake.log.transports, ['tailscale']);
    assert.equal(fake.log.torStops, 1, 'the Tor client is stopped');
    assert.equal(fake.log.proxyStops, 1, 'the Snowflake proxy is stopped');
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
    // Selecting Tor again re-uses the instance and brings the proxy back; no second bootstrap.
    runtime.selection.choose('net.fetch', 1, 'net-tor');
    await tick();
    assert.deepEqual(fake.log.transports, ['tailscale', 'tor']);
    assert.equal(fake.log.created.length, 1);
    assert.equal(storage.getItem('self-forming.net.route'), 'net-tor');
  } finally { await runtime.close(); teardown(); }
});

test('Tor: a failed start is shown, Native is used, Retry warms it up again; a library that cannot load is shown too', async () => {
  setup();
  const { runtime, fake } = await compose();
  try {
    const view = mountSection(runtime, 'net-tor');
    runtime.selection.choose('net.fetch', 1, 'net-tor');
    await tick();
    assert.equal(view.byId('net-tor-retry').hidden, true);
    fake.torState = 'error'; fake.lastStartError = 'bridge unreachable'; fake.emit();
    assert.match(view.byId('net-tor-status').textContent, /Tor could not connect: bridge unreachable/);
    assert.equal(view.byId('net-tor-retry').hidden, false);
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
    await view.byId('net-tor-retry').click();
    assert.equal(fake.log.warmUps, 2);
  } finally { await runtime.close(); teardown(); }
  setup();
  const broken = await compose({ loadCorsRot: async () => { throw new Error('cors-rot/index.js was not served'); } });
  try {
    const view = mountSection(broken.runtime, 'net-tor');
    broken.runtime.selection.choose('net.fetch', 1, 'net-tor');
    await tick();
    assert.match(view.byId('net-tor-status').textContent, /Tor could not start: cors-rot\/index.js was not served/);
    assert.equal(broken.runtime.service('net.fetch', 1)(), 'native');
    assert.match(broken.runtime.selection.resolve('net.fetch', 1).status, /not available; using Native network instead/);
  } finally { await broken.runtime.close(); teardown(); }
});

test('a saved choice starts the provider at the next page load, and only that one', async () => {
  setup();
  const { runtime, fake } = await compose({ saved: { 'self-forming.net.route': 'net-tor' } });
  try {
    await tick();
    assert.deepEqual(fake.log.created.map((c) => c.transport), ['tor']);
  } finally { await runtime.close(); teardown(); }
});

test('Tailscale: sign-in link, credentials only through the plugin lane (plugin:net-tailscale:state), exit node, availability and fallback', async () => {
  setup();
  const bridge = fakeBridge();
  const { runtime, fake, storage } = await compose({ bridge });
  try {
    const view = mountSection(runtime, 'net-tailscale');
    assert.match(view.byId('net-tailscale-status').textContent, /not running/);
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    // Credentials were read from the lane BEFORE the library was created; the node got our storage, not localStorage.
    assert.deepEqual(bridge.calls[0], ['auth.load', 'plugin:net-tailscale:state', undefined]);
    assert.deepEqual(fake.log.created.map((c) => c.transport), ['tailscale']);
    assert.equal(fake.log.created[0].tailscale.hostname, 'self-forming-android');
    assert.notEqual(fake.log.created[0].tailscale.storage, globalThis.localStorage);
    assert.equal(fake.log.starts, 1);
    assert.equal(fake.log.warmUps, 1, 'started through warmUp, not an own start().catch');
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
    assert.match(runtime.selection.resolve('net.fetch', 1).reason, /Tailscale exit node is not available; using Native network instead/);
    // Needs login: the link is offered (as a link, not in the text).
    assert.match(view.byId('net-tailscale-status').textContent, /Sign in to Tailscale with the link below/);
    const link = view.byId('net-tailscale-login');
    assert.equal(link.hidden, false);
    assert.equal(link.href, LOGIN);
    assert.ok(!view.text().includes('SECRETLOGINTOKEN'));
    assert.equal(view.byId('net-tailscale-signout').hidden, true);
    // Signed in: the node's keys are saved through the lane, as one record, never localStorage.
    fake.signIn();
    await tick();
    const saves = bridge.calls.filter(([m]) => m === 'auth.save');
    assert.ok(saves.length >= 1);
    assert.equal(saves.at(-1)[1], 'plugin:net-tailscale:state');
    assert.deepEqual(saves.at(-1)[2], { v: 1, items: { 'self-forming.tailscale.state.node': SECRET } });
    assert.equal(link.hidden, true);
    // Running without an exit node: still unavailable, and the section says what to do.
    assert.match(view.byId('net-tailscale-status').textContent, /Choose an exit node below/);
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
    const exit = view.byId('net-tailscale-exit');
    assert.deepEqual(exit.options.map((o) => o.textContent), ['Choose…', 'home-pi', 'old-box (offline)']);
    exit.value = 'n1';
    await exit.dispatch('change');
    await tick();
    assert.deepEqual(fake.log.exits, ['n1']);
    assert.match(view.byId('net-tailscale-status').textContent, /Connected through your exit node/);
    const route = runtime.service('net.fetch', 1);
    assert.equal(route.describe().id, 'net-tailscale');
    assert.equal((await route('https://example.org/')).via, 'tailscale');
    // The exit node choice is kept in the same credential record.
    assert.equal(bridge.records['plugin:net-tailscale:state'].items['self-forming.tailscale.exit-node'], 'n1');
    // Switching away keeps the node running and the record.
    runtime.selection.choose('net.fetch', 1, null);
    await tick();
    assert.equal(fake.log.stops, 0);
    assert.ok(bridge.records['plugin:net-tailscale:state']);
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    assert.equal(fake.log.created.length, 1);
    // Sign out: stop() (logs the node out), the lane record is cleared.
    await view.byId('net-tailscale-signout').click();
    await tick();
    assert.equal(fake.log.stops, 1);
    assert.ok(bridge.calls.some(([m, p]) => m === 'auth.clear' && p === 'plugin:net-tailscale:state'));
    assert.equal(bridge.records['plugin:net-tailscale:state'], undefined);
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
    assert.equal(storage.getItem('self-forming.net.route'), 'net-tailscale');
  } finally { await runtime.close(); teardown(); }
});

test('Tailscale: the next page load restores the node from the lane (no sign-in again); an unreadable lane stays in memory and never overwrites', async () => {
  setup();
  const records = { 'plugin:net-tailscale:state': { v: 1, items: { 'self-forming.tailscale.state.node': SECRET, 'self-forming.tailscale.exit-node': 'n1' } } };
  const bridge = fakeBridge({ records });
  const again = await compose({ bridge, saved: { 'self-forming.net.route': 'net-tailscale' } });
  try {
    await tick();
    assert.equal(again.fake.restored, SECRET);
    assert.equal(again.runtime.service('net.fetch', 1).describe().id, 'net-tailscale', 'available at once: signed in and exit node applied');
  } finally { await again.runtime.close(); teardown(); }
  setup();
  const locked = fakeBridge({ records, failLoad: true });
  const l = await compose({ bridge: locked, saved: { 'self-forming.net.route': 'net-tailscale' } });
  try {
    const view = mountSection(l.runtime, 'net-tailscale');
    await tick();
    assert.equal(l.fake.restored, undefined);
    l.fake.signIn();
    await tick();
    assert.ok(!locked.calls.some(([m]) => m === 'auth.save' || m === 'auth.clear'), 'a failed read never overwrites the saved record');
    assert.match(view.byId('net-tailscale-storage').textContent, /could not be saved or read securely/);
  } finally { await l.runtime.close(); teardown(); }
});

test('Tailscale without the credentials capability: memory only, said in the section, no auth.* call', async () => {
  setup();
  const bridge = fakeBridge({ pluginCredentials: false });
  const { runtime, fake } = await compose({ bridge });
  try {
    const view = mountSection(runtime, 'net-tailscale');
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    fake.signIn();
    await tick();
    assert.deepEqual(bridge.calls, []);
    assert.match(view.byId('net-tailscale-storage').textContent, /No secure credential storage on this device/);
  } finally { await runtime.close(); teardown(); }
});

test('only the selected route runs; the other is never created', async () => {
  setup();
  const { runtime, fake } = await compose();
  try {
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    runtime.selection.choose('net.fetch', 1, 'net-tor');
    await tick();
    assert.deepEqual(fake.log.created.map((c) => c.transport), ['tailscale', 'tor']);
    assert.deepEqual(fake.log.transports, [], 'Tor created in tor mode, Tailscale nothing to stop');
  } finally { await runtime.close(); teardown(); }
});

test('no secrets in logs, snapshots, status lines or storage', async () => {
  setup();
  const bridge = fakeBridge();
  const { runtime, fake, storage } = await compose({ bridge });
  try {
    const tsView = mountSection(runtime, 'net-tailscale'), torView = mountSection(runtime, 'net-tor');
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    fake.signIn();
    await tick();
    const everything = JSON.stringify([
      runtime.list(), runtime.selection.providers('net.fetch', 1), runtime.selection.resolve('net.fetch', 1), runtime.selection.services(),
      [...storage.data], tsView.text(), torView.text(), consoleLines,
      all(tsView.el).map((n) => [n.tag, n.id, n.textContent, n.hidden, n.disabled])
    ]);
    assert.ok(!everything.includes(SECRET), 'node key');
    assert.ok(!everything.includes('SECRETLOGINTOKEN'), 'login link token');
    assert.deepEqual(consoleLines, []);
    // The only place the secret is allowed to travel is the credentials lane.
    assert.ok(JSON.stringify(bridge.records).includes(SECRET));
  } finally { await runtime.close(); teardown(); }
});

test('Tailscale: a failing start shows tailscaleStartError in the status line; no unhandled rejection', async () => {
  setup();
  const { runtime, fake } = await compose();
  try {
    fake.failStart = 'control server unreachable';
    const view = mountSection(runtime, 'net-tailscale');
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    assert.match(view.byId('net-tailscale-status').textContent, /Tailscale could not start: control server unreachable/);
    assert.equal(runtime.service('net.fetch', 1)(), 'native');
  } finally { await runtime.close(); teardown(); }
});

test('Tailscale auth key: stored only in its own credential record, passed to cors-rot, masked, never logged; removable', async () => {
  setup();
  const KEY = 'tskey-auth-SECRETAUTHKEY1234567890';
  const bridge = fakeBridge();
  const { runtime, fake } = await compose({ bridge });
  try {
    const view = mountSection(runtime, 'net-tailscale');
    runtime.selection.choose('net.fetch', 1, 'net-tailscale');
    await tick();
    assert.equal(fake.log.created[0].authKey, undefined);
    view.byId('net-tailscale-authkey').value = KEY;
    await view.byId('net-tailscale-authkey-save').click();
    await tick();
    assert.deepEqual(bridge.records['plugin:net-tailscale:authkey'], { v: 1, key: KEY });
    assert.deepEqual(fake.log.authKeys, [KEY]);
    assert.equal(view.byId('net-tailscale-authkey').value, '', 'the field is cleared');
    assert.ok(!view.text().includes(KEY) && !JSON.stringify(all(view.el).map((n) => [n.textContent, n.placeholder])).includes(KEY));
    assert.match(view.byId('net-tailscale-authkey-status').textContent, /Auth key saved \(tsk…7890\)/);
    assert.ok(!JSON.stringify(bridge.records['plugin:net-tailscale:state'] ?? {}).includes(KEY));
    assert.deepEqual(consoleLines, []);
    await view.byId('net-tailscale-authkey-remove').click();
    await tick();
    assert.equal(bridge.records['plugin:net-tailscale:authkey'], undefined);
    assert.deepEqual(fake.log.authKeys, [KEY, undefined]);
  } finally { await runtime.close(); teardown(); }
  setup();
  const again = await compose({ bridge: fakeBridge({ records: { 'plugin:net-tailscale:authkey': { v: 1, key: KEY } } }), saved: { 'self-forming.net.route': 'net-tailscale' } });
  try {
    await tick();
    assert.equal(again.fake.log.created[0].authKey, KEY, 'loaded from the record and passed as authKey');
  } finally { await again.runtime.close(); teardown(); }
});
