// Lifecycle + auth key: fake Tailscale/Tor clients and a fake DOM, no WASM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTailscaleManager } from '../tailscale.js';
import { createBrowserNetwork } from '../network.js';
import { createSnowflakeProxy } from '../snowflake.js';
import { createCorsRot } from '../index.js';

const KEY = 'tskey-auth-kTESTKEY123-abcdefSECRET';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function memoryStorage() {
  const store = {};
  return Object.defineProperties(store, {
    getItem: { value: (k) => (k in store ? store[k] : null) },
    setItem: { value: (k, v) => { store[k] = String(v); }, },
    removeItem: { value: (k) => { delete store[k]; } },
  });
}
/** A fake createTailscaleClient that records its options and what happens to it. */
function fakeTailscale({ fail, gate } = {}) {
  const created = [];
  const loadClient = async (options) => {
    if (gate) await gate.promise;
    if (fail) throw new Error(fail(options));
    const client = { options, closed: 0, close() { this.closed++; }, whenRunning: async () => {}, setExitNode: async () => {}, clearExitNode: async () => {}, login() {}, logout() {} };
    created.push(client);
    return client;
  };
  return { loadClient, created };
}

// ---- 1. auth key ----
test('authKey (string or function) reaches the Tailscale client; no key means interactive sign-in', async () => {
  const none = fakeTailscale();
  const a = createTailscaleManager({ storage: memoryStorage(), loadClient: none.loadClient });
  await a.start();
  assert.equal('authKey' in none.created[0].options, false);
  assert.equal(a.getStatus().usingAuthKey, false);

  const str = fakeTailscale();
  const b = createTailscaleManager({ storage: memoryStorage(), loadClient: str.loadClient, authKey: KEY });
  await b.start();
  assert.equal(str.created[0].options.authKey, KEY);

  const fn = fakeTailscale();
  const c = createTailscaleManager({ storage: memoryStorage(), loadClient: fn.loadClient, authKey: async () => KEY });
  await c.start();
  assert.equal(fn.created[0].options.authKey, KEY);

  const later = fakeTailscale();
  const d = createTailscaleManager({ storage: memoryStorage(), loadClient: later.loadClient });
  d.setAuthKey(KEY);
  await d.start();
  assert.equal(later.created[0].options.authKey, KEY);
});

test('the auth key never appears in the status, in notifications or in error text', async () => {
  const seen = [];
  const fake = fakeTailscale({ fail: (o) => `control rejected key ${o.authKey}` });
  const m = createTailscaleManager({ storage: memoryStorage(), loadClient: fake.loadClient, authKey: KEY });
  m.subscribe((s) => seen.push(JSON.stringify(s)));
  await assert.rejects(m.start(), (error) => !String(error.message).includes(KEY) && /\[auth key\]/.test(error.message));
  seen.push(JSON.stringify(m.getStatus()));
  assert.equal(m.getStatus().state, 'error');
  assert.equal(m.getStatus().usingAuthKey, true);
  assert.ok(seen.length >= 2);
  for (const text of seen) assert.equal(text.includes('tskey') || text.includes('SECRET'), false);
});

// ---- 2. stop / dispose: Tailscale ----
test('tailscale stop(): closes the node, resets status and stored state, and start() works again', async () => {
  const fake = fakeTailscale();
  const storage = memoryStorage();
  const m = createTailscaleManager({ storage, loadClient: fake.loadClient });
  storage.setItem('self-forming.tailscale.state.x', 'node-key');
  const states = [];
  m.subscribe((s) => states.push(s.state));
  await m.start();
  const first = fake.created[0];
  await m.stop();
  assert.equal(first.closed, 1);
  assert.equal(m.getStatus().state, 'off');
  assert.equal(m.readyClient(), undefined);
  assert.equal(storage.getItem('self-forming.tailscale.state.x'), null);
  await m.stop(); // idempotent
  assert.equal(first.closed, 1);
  await m.start();
  assert.equal(fake.created.length, 2);
  assert.notEqual(fake.created[1], first);
  assert.equal(states.at(-1), 'loading');
});

test('tailscale stop() during start() releases the late client; stale callbacks are ignored', async () => {
  const gate = deferred();
  const fake = fakeTailscale({ gate });
  const m = createTailscaleManager({ storage: memoryStorage(), loadClient: fake.loadClient });
  const starting = m.start();
  starting.catch(() => {});
  const stopping = m.stop();
  gate.resolve();
  await stopping;
  await assert.rejects(starting, /stopped while starting/);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].closed, 1);
  assert.equal(m.getStatus().state, 'off');
  fake.created[0].options.onStatus({ state: 'Running', exitNodes: [] }); // an old client reporting late
  assert.equal(m.getStatus().state, 'off');
  gate.resolve();
  await m.start();
  assert.equal(m.getStatus().state, 'loading');
});

test('tailscale dispose(): stops and drops listeners', async () => {
  const fake = fakeTailscale();
  const m = createTailscaleManager({ storage: memoryStorage(), loadClient: fake.loadClient });
  let calls = 0;
  m.subscribe(() => { calls++; });
  await m.start();
  await m.dispose();
  const before = calls;
  await m.start();
  assert.equal(calls, before, 'no listener after dispose');
  assert.equal(fake.created[0].closed, 1);
});

// ---- 2. stop / dispose: Tor ----
function torFixture(options = {}) {
  const clients = [];
  const createTorClient = async () => {
    const client = { closed: 0, freed: 0, async waitForCircuit() {}, close() { this.closed++; }, free() { this.freed++; }, async connectTls() { return { close() {}, read: async () => undefined, write: async () => {} }; } };
    clients.push(client);
    return client;
  };
  const network = createBrowserNetwork({ mode: 'tor', keepAlive: true, timeoutMs: 1000, nativeFetch: async () => { throw new Error('no native'); }, createTorClient, ...options });
  return { clients, network };
}

test('tor stopTor(): releases the client and the next start bootstraps a fresh one', async () => {
  const { clients, network } = torFixture();
  network.warmUp();
  await sleep(10);
  assert.equal(network.getStatus().torState, 'ready');
  await network.stopTor();
  assert.equal(clients[0].closed, 1);
  assert.equal(clients[0].freed, 1);
  assert.equal(network.getStatus().torState, 'idle');
  await network.stopTor(); // idempotent
  assert.equal(clients[0].freed, 1);
  network.warmUp();
  await sleep(10);
  assert.equal(clients.length, 2);
  assert.equal(network.getStatus().torState, 'ready');
});

test('tor stopTor() during bootstrap: the late client is released, state stays idle', async () => {
  const gate = deferred();
  const clients = [];
  const network = createBrowserNetwork({
    mode: 'tor', timeoutMs: 1000, nativeFetch: async () => {},
    createTorClient: async () => { await gate.promise; const c = { freed: 0, async waitForCircuit() {}, free() { this.freed++; } }; clients.push(c); return c; },
  });
  network.warmUp();
  await sleep(5);
  const stopping = network.stopTor();
  gate.resolve();
  await stopping;
  await sleep(5);
  assert.equal(clients[0].freed, 1);
  assert.equal(network.getStatus().torState, 'idle');
});

test('network dispose(): stops Tor, closes pooled streams, forgets listeners', async () => {
  const { clients, network } = torFixture();
  let calls = 0;
  network.subscribe(() => { calls++; });
  network.warmUp();
  await sleep(10);
  await network.dispose();
  assert.equal(clients[0].freed, 1);
  const before = calls;
  network.setMode('tailscale');
  assert.equal(calls, before);
});

// ---- 2. stop / dispose: Snowflake proxy frame ----
function fakeDom() {
  const frames = [];
  const document = {
    body: { append(frame) { frame.attached = true; frames.push(frame); } },
    createElement() { return { attached: false, style: {}, setAttribute() {}, remove() { this.attached = false; }, contentWindow: { postMessage() {} } }; },
  };
  const listeners = new Set();
  globalThis.addEventListener = (type, fn) => { if (type === 'message') listeners.add(fn); };
  globalThis.removeEventListener = (type, fn) => { listeners.delete(fn); };
  return { document, frames, listeners };
}
function fakeNetwork(initial) {
  let status = initial; const subs = new Set();
  return {
    getStatus: async () => status,
    subscribe(cb) { subs.add(cb); cb(status); return () => subs.delete(cb); },
    set(next) { status = next; for (const cb of subs) cb(status); },
    subs,
  };
}

test('snowflake proxy stop(): frame removed and stays down; returns when Tor is re-selected; dispose detaches', async () => {
  const dom = fakeDom();
  const net = fakeNetwork({ mode: 'tor', torState: 'idle' });
  const proxy = createSnowflakeProxy({ network: net, document: dom.document });
  assert.equal(dom.frames.length, 1);
  assert.equal(dom.frames[0].attached, true);
  proxy.stop();
  assert.equal(dom.frames[0].attached, false);
  assert.equal(proxy.getStatus().state, 'stopped');
  net.set({ mode: 'tor', torState: 'idle' });     // unrelated status change: stays down
  assert.equal(dom.frames.length, 1);
  net.set({ mode: 'tailscale' });
  net.set({ mode: 'tor', torState: 'idle' });     // Tor selected again: runs again
  assert.equal(dom.frames.length, 2);
  assert.equal(dom.frames[1].attached, true);
  proxy.dispose();
  assert.equal(dom.frames[1].attached, false);
  assert.equal(net.subs.size, 0);
  assert.equal(dom.listeners.size, 0);
  net.set({ mode: 'tailscale' }); net.set({ mode: 'tor' });
  assert.equal(dom.frames.length, 2, 'disposed proxy never starts again');
  delete globalThis.addEventListener; delete globalThis.removeEventListener;
});

test('createCorsRot stop() releases Tor, the Tailscale node and the proxy frame; dispose() leaves nothing subscribed', async () => {
  const dom = fakeDom();
  const ts = fakeTailscale();
  const torClients = [];
  const net = createCorsRot({
    transport: 'tor', document: dom.document, nativeFetch: async () => {},
    tailscale: { storage: memoryStorage(), loadClient: ts.loadClient, authKey: KEY },
    tor: { createTorClient: async () => { const c = { freed: 0, async waitForCircuit() {}, free() { this.freed++; } }; torClients.push(c); return c; } },
  });
  net.warmUp();
  await net.tailscale.start();
  await sleep(10);
  assert.equal(dom.frames.at(-1).attached, true);
  assert.equal(ts.created[0].options.authKey, KEY);
  await net.stop();
  assert.equal(torClients[0].freed, 1);
  assert.equal(ts.created[0].closed, 1);
  assert.equal(dom.frames.at(-1).attached, false);
  assert.equal(net.getStatus().torState, 'idle');
  net.warmUp(); await sleep(10);            // a later start works again
  assert.equal(torClients.length, 2);
  assert.equal(dom.frames.at(-1).attached, true);
  await net.dispose();
  assert.equal(torClients[1].freed, 1);
  assert.equal(dom.frames.at(-1).attached, false);
  assert.equal(dom.listeners.size, 0);
  delete globalThis.addEventListener; delete globalThis.removeEventListener;
});

// ---- 3. warmUp() with a failing start() ----
test('warmUp() in tailscale mode: a rejecting start() is reported in the status, not as an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failing = { start: () => Promise.reject(new Error('wasm failed to load')), readyClient: () => undefined };
    const seen = [];
    const network = createBrowserNetwork({ mode: 'tailscale', tailscale: failing, nativeFetch: async () => {}, onStatus: (s) => seen.push(s.tailscaleStartError) });
    assert.equal(network.getStatus().tailscaleStartError, null);
    network.warmUp();
    await sleep(20);
    assert.equal(network.getStatus().tailscaleStartError, 'wasm failed to load');
    assert.ok(seen.includes('wasm failed to load'), 'status observers were notified');

    const throwing = createBrowserNetwork({ mode: 'tailscale', tailscale: { start() { throw new Error('sync boom'); } }, nativeFetch: async () => {} });
    throwing.warmUp();
    assert.equal(throwing.getStatus().tailscaleStartError, 'sync boom');

    // a later successful start clears the error
    let ok = false;
    const flaky = createBrowserNetwork({ mode: 'tailscale', tailscale: { start: async () => { if (!ok) throw new Error('first try'); } }, nativeFetch: async () => {} });
    flaky.warmUp(); await sleep(10);
    assert.equal(flaky.getStatus().tailscaleStartError, 'first try');
    ok = true; flaky.warmUp(); await sleep(10);
    assert.equal(flaky.getStatus().tailscaleStartError, null);

    // the real manager: its own status carries the error as well
    const fake = fakeTailscale({ fail: () => 'no wasm' });
    const m = createTailscaleManager({ storage: memoryStorage(), loadClient: fake.loadClient });
    createBrowserNetwork({ mode: 'tailscale', tailscale: m, nativeFetch: async () => {} }).warmUp();
    await sleep(20);
    assert.equal(m.getStatus().state, 'error');
    assert.equal(m.getStatus().error, 'no wasm');
    await sleep(20);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
