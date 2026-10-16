import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, tick } from './plugin-agent-support.mjs';

// Step X4: fetch lives in core-net-native (plugins/core-net-native/web/native-fetch.js, hand-ported from
// packages/native-host/src/fetch.ts). The same scenarios run against the ported fetch and the
// createNativeFetch of the fixed native-host.js with a scripted fake host; the host calls
// (request IDs normalised), responses and errors must be identical. Also: net.fetch@1, the fallback
// chain (plugin module -> native-host.js) and the auth host. No device, no network.
const available = await import('node:fs').then((fs) => fs.existsSync(new URL('../dist/app/native-host.js', import.meta.url)));
const skip = available ? false : 'dist/app/native-host.js is not present';

let app, ported, original, net, authHost;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  ported = await app.load('builtin/core-net-native/web/native-fetch.js');
  original = await app.load('native-host.js');
  net = await app.load('builtin/core-net-native/web/index.js');
  authHost = await app.load('auth-host.js');
});
after(async () => { await app?.remove(); });

const URL_ = 'https://api.anthropic.com/v1/messages?beta=true';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Scripted host: handler(method, params, host) → value | throws | promise. Logs every call. */
function fakeHost(handler) {
  const calls = [];
  const listeners = new Set();
  const host = {
    closed: false, calls, url: URL_,
    async call(method, params = {}) {
      calls.push([method, structuredClone(params)]);
      if (method === 'http.open') host.url = params.url;
      if (handler) { const value = await handler(method, params, host); if (value !== undefined) return value; }
      if (method === 'http.send') return { status: 200, statusText: 'OK', headers: [['content-type', 'application/octet-stream']], url: host.url };
      if (method === 'http.read') return { data: '', done: true };
      return {};
    },
    onClose(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close(error = new Error('Fixture bridge closed')) { host.closed = true; for (const l of [...listeners]) l(error); },
    listeners
  };
  return host;
}
const normalise = (value) => {
  const ids = new Map();
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => { if (!ids.has(id)) ids.set(id, `id#${ids.size + 1}`); return ids.get(id); });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
};
const errorOf = async (promise) => { try { await promise; return 'resolved'; } catch (e) { return { name: e.name, message: e.message, type: e.constructor.name }; } };
// The clone is read too: an unread tee branch keeps Node 18's event loop alive.
const response = async (res) => { const clone = res.clone(); const text = await res.text(); return { status: res.status, statusText: res.statusText, url: res.url, cloneUrl: clone.url, headers: [...res.headers], text, cloneText: await clone.text() }; };

async function scenarios(createNativeFetch) {
  const out = [];
  const run = async (label, handler, work, { keepOpen = false } = {}) => {
    const host = fakeHost(handler);
    let result;
    try { result = await work(createNativeFetch(host), host); } catch (error) { result = { threw: { name: error.name, message: error.message } }; }
    await tick(); await tick();
    out.push([label, normalise({ result, calls: host.calls, listeners: host.listeners.size })]);
  };
  const chunks = (parts) => { let i = 0; return (method) => { if (method === 'http.read') { const data = parts[i++] ?? ''; return { data: data ? b64(Buffer.from(data)) : '', done: i >= parts.length }; } }; };

  await run('simple get, streamed body', chunks(['hello ', 'world']), async (f) => response(await f(URL_)));
  await run('post string body + managed headers', undefined, async (f) => response(await f(URL_, { method: 'POST', body: 'x', headers: { authorization: 'Bearer dummy', 'x-a': '1', origin: 'https://o', cookie: 'c', 'sec-fetch-mode': 'cors', 'proxy-x': '1', 'accept-encoding': 'gzip', 'anthropic-dangerous-direct-browser-access': 'true', 'content-length': '9' } })));
  await run('large binary upload split in 64 KiB frames', undefined, async (f, host) => {
    const body = new Uint8Array(150 * 1024 + 3).map((_, i) => i % 253);
    const res = await f(URL_, { method: 'PUT', body });
    return { res: await response(res), writes: host.calls.filter(([m]) => m === 'http.write').map(([, p]) => p.data.length) };
  });
  await run('request object with init override', undefined, async (f) => response(await f(new Request(URL_, { method: 'POST', body: 'a' }), { method: 'PUT', body: new Uint8Array([0, 255, 1]) })));
  await run('HEAD has no body and cancels', undefined, async (f) => response(await f(URL_, { method: 'HEAD' })));
  await run('204 has no body', (m, p, host) => m === 'http.send' ? { status: 204, statusText: 'No Content', headers: [], url: host.url } : undefined, async (f) => response(await f(URL_)));
  await run('http is refused', undefined, async (f) => errorOf(f('http://api.anthropic.com/')));
  await run('redirect is refused', (m, p, host) => m === 'http.send' ? { status: 302, statusText: 'Found', headers: [['location', 'https://x']], url: host.url } : undefined, async (f) => errorOf(f(URL_)));
  const bad = [
    ['status 100', { status: 100, statusText: 'x', headers: [], url: URL_ }],
    ['status 600', { status: 600, statusText: 'x', headers: [], url: URL_ }],
    ['url mismatch', { status: 200, statusText: 'x', headers: [], url: 'https://other.example/' }],
    ['bad headers', { status: 200, statusText: 'x', headers: [['a']], url: URL_ }],
    ['bad header name', { status: 200, statusText: 'x', headers: [['bad name', 'v']], url: URL_ }],
    ['not a record', null]
  ];
  for (const [label, head] of bad) await run(`protocol: ${label}`, (m) => m === 'http.send' ? (head === null ? null : head) : undefined, async (f) => errorOf(f(URL_)));
  const badChunks = [['not an object', null], ['data not string', { data: 5, done: true }], ['bad base64', { data: '@@@@', done: true }], ['empty not done', { data: '', done: false }], ['oversized', { data: 'A'.repeat(100000), done: true }]];
  for (const [label, chunk] of badChunks) await run(`chunk: ${label}`, (m) => m === 'http.read' ? chunk : undefined, async (f) => errorOf(f(URL_).then((r) => r.text())));
  await run('host error on open', (m) => { if (m === 'http.open') throw new Error('refused'); }, async (f) => errorOf(f(URL_)));
  await run('aborted before start', undefined, async (f) => errorOf(f(URL_, { signal: AbortSignal.abort() })));
  await run('aborted with reason', undefined, async (f) => errorOf(f(URL_, { signal: AbortSignal.abort(new TypeError('custom')) })));
  await run('abort while reading', (m) => m === 'http.read' ? new Promise(() => {}) : undefined, async (f) => {
    const controller = new AbortController();
    const res = await f(URL_, { signal: controller.signal });
    const reading = errorOf(res.text());
    await tick(); controller.abort();
    return reading;
  });
  await run('abort during upload', (m) => m === 'http.write' ? new Promise(() => {}) : undefined, async (f) => {
    const controller = new AbortController();
    const pending = errorOf(f(URL_, { method: 'POST', body: new Uint8Array(10), signal: controller.signal }));
    await tick(); controller.abort();
    return pending;
  });
  await run('body cancel cancels the native request', (m) => m === 'http.read' ? new Promise(() => {}) : undefined, async (f) => {
    const res = await f(URL_);
    await res.body.cancel('stop');
    return 'cancelled';
  });
  await run('closed bridge before start', undefined, async (f, host) => { host.closed = true; return errorOf(f(URL_)); });
  await run('bridge closes mid stream', (m) => m === 'http.read' ? new Promise(() => {}) : undefined, async (f, host) => {
    const res = await f(URL_);
    const reading = errorOf(res.text());
    await tick(); host.close(new Error('lost'));
    return reading;
  });
  return out;
}

test('ported fetch and the compiled fetch behave identically (calls, responses, errors)', { skip }, async () => {
  const left = await scenarios(ported.createNativeFetch);
  const right = await scenarios(original.createNativeFetch);
  assert.ok(left.length >= 25);
  assert.deepEqual(left.map(([label]) => label), right.map(([label]) => label));
  for (let i = 0; i < left.length; i++) assert.deepEqual(left[i], right[i], left[i][0]);
  // Spot checks that the scenarios really exercised the interesting paths.
  const find = (label) => left.find(([l]) => l === label)[1];
  assert.equal(find('simple get, streamed body').result.text, 'hello world');
  assert.equal(find('http is refused').result.message, 'Native HTTP requires HTTPS.');
  assert.ok(find('abort while reading').calls.some(([m]) => m === 'http.cancel'));
});

test('net.fetch@1: a fetch over the page bridge with describe(); createFetch(host) over another host', { skip }, async () => {
  const provided = [];
  const bridge = fakeHost(undefined);
  const ctx = { signal: new AbortController().signal, contribute() {}, cleanup() {}, provide: (id, version, value) => provided.push([id, version, value]) };
  net.create({ bridge }).setup(ctx);
  assert.deepEqual(provided.map(([id, version]) => [id, version]), [['net.fetch', 1]]);
  const service = provided[0][2];
  assert.equal(typeof service, 'function');
  assert.equal(await (await service(URL_)).text(), '');
  assert.equal(bridge.calls[0][0], 'http.open');
  const info = service.describe();
  assert.deepEqual([info.id, info.label, info.reaches, info.private, info.persistent, info.status], ['core-net-native', 'Native HTTP', 'allow-list', false, true, 'ready']);
  assert.equal(await info.ready(), true);
  const other = fakeHost(undefined);
  await (await service.createFetch(other)(URL_)).text();
  assert.equal(other.calls[0][0], 'http.open');
  assert.throws(() => service.createFetch({}), TypeError);
  // No bridge: nothing is provided (callers use the browser's fetch).
  const bare = [];
  net.create({}).setup({ signal: ctx.signal, provide: (...args) => bare.push(args) });
  assert.deepEqual(bare, []);
  // A stopped plugin refuses.
  const stop = new AbortController();
  const stopped = [];
  net.create({ bridge }).setup({ signal: stop.signal, contribute() {}, cleanup() {}, provide: (...args) => stopped.push(args) });
  stop.abort();
  await assert.rejects(stopped[0][2](URL_), /stopped/);
  assert.throws(() => stopped[0][2].createFetch(bridge), /stopped/);
  const manifest = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(new URL('../plugins/core-net-native/plugin.json', import.meta.url), 'utf8')));
  assert.deepEqual([manifest.id, manifest.essential, manifest.bundle, manifest.provides], ['core-net-native', true, 'self-forming-core', [{ id: 'net.fetch', version: 1, default: true }]]);
});

test('fallback: native-host.js createNativeFetch is used only when native-fetch.js cannot load', { skip }, async () => {
  const errors = [];
  const original_ = console.error; console.error = (...args) => errors.push(args);
  try {
    const used = await net.loadNativeFetch({ load: () => Promise.reject(new Error('broken module')) });
    assert.equal(used, original.createNativeFetch);
    const malformed = await net.loadNativeFetch({ load: async () => ({}) });
    assert.equal(malformed, original.createNativeFetch);
  } finally { console.error = original_; }
  assert.equal(errors.length, 2);
  assert.equal(await net.loadNativeFetch(), ported.createNativeFetch, 'normally the plugin implementation');
  // createNet over a broken loader still fetches through the fallback.
  const host = fakeHost(undefined);
  console.error = () => {};
  try {
    const bundled = net.createNet({ bridge: host, loaded: () => net.loadNativeFetch({ load: () => Promise.reject(new Error('x')) }) });
    assert.equal(await (await bundled.fetch(URL_)).text(), '');
    assert.equal(net.createNet({}).fetch, undefined);
  } finally { console.error = original_; }
  assert.equal(host.calls[0][0], 'http.open');
});

test('auth host: bridge fetch comes from core-net; native-host.js is the last resort without it', { skip }, async () => {
  const viaNet = fakeHost(undefined);
  const withNet = authHost.createAuthHost(viaNet, { createFetch: net.createNet({ bridge: viaNet }).createFetch });
  await (await withNet.fetch(URL_)).text();
  assert.equal(viaNet.calls[0][0], 'http.open');
  await withNet.call('auth.info');
  assert.equal(viaNet.calls.at(-1)[0], 'auth.info');
  const last = fakeHost(undefined);
  const without = authHost.createAuthHost(last);
  await (await without.fetch(URL_)).text();
  assert.equal(last.calls[0][0], 'http.open');
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../apps/common/auth-host.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /^import .*native-host/m, 'no static native-host.js import');
});
