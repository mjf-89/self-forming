// Transport plumbing only: injected network, no Tor/WASM, no public requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';
import { createBrowserHost } from '../apps/browser/browser-host.js';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createSelectedFetch } from '../apps/common/auth-host.js';

class WebWorker {
  constructor(url) {
    this.worker = new NodeWorker(`
      const {parentPort, workerData} = require('node:worker_threads');
      globalThis.self = globalThis;
      globalThis.addEventListener = () => {};
      globalThis.postMessage = m => parentPort.postMessage(m);
      const queue = [];
      parentPort.on('message', data => globalThis.onmessage ? globalThis.onmessage({data}) : queue.push(data));
      import(workerData.url).then(() => { for (const data of queue) globalThis.onmessage({data}); });
    `, { eval: true, workerData: { url: String(url) } });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message }));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { void this.worker.terminate(); }
}
globalThis.Worker = WebWorker;
globalThis.crypto ??= webcrypto;
const records = new Map();
globalThis.localStorage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function open(network) {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const host = await createBrowserHost({ vfs, network });
  let seq = 0;
  let out = '';
  const pending = new Map();
  host.transport.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.event === 'env.output') out += Buffer.from(m.data, 'base64').toString();
    else if (pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    host.transport.postMessage(JSON.stringify({ id, method, params }));
  });
  return { host, call, output: () => out, exec: command => call('env.exec', { id: 'run', owner: 'test', shell: 'javascript', command, timeout: 3 }) };
}
function streaming() {
  const state = { pulls: 0, cancelled: 0, signal: null };
  const fetch = async (_input, init) => {
    state.signal = init.signal;
    return new Response(new ReadableStream({
      pull(controller) { state.pulls++; controller.enqueue(new Uint8Array(150000).fill(65)); },
      cancel() { state.cancelled++; },
    }, { highWaterMark: 0 }), { headers: { 'x-test': 'stream' } });
  };
  return { state, network: { fetch, fetchTor: fetch } };
}

test('worker and HTTP compatibility consumers fail closed until the selected provider is ready; explicit fetchTor stays separate', async () => {
  let ready = false, selectedCalls = 0, torCalls = 0, bypasses = 0;
  const runtime = createPluginRuntime({ storage: { getItem: () => null } });
  runtime.register({ id: 'selected-route', version: '1.0.0', provides: [{ id: 'net.fetch', version: 1, default: true }], setup(ctx) {
    ctx.provide('net.fetch', 1, Object.assign(async () => { selectedCalls++; return new Response('selected-response'); }, { available: () => ready }));
  } });
  await runtime.start();
  const routed = createSelectedFetch({ runtime: () => runtime, fallback: () => { bypasses++; throw new Error('selection bypass'); } });
  const { host, exec, call, output } = await open({
    fetch: routed,
    // Explicit Tor is a distinct injected transport contract, not a rewrite of the selected fetch.
    fetchTor: async () => { torCalls++; return new Response('explicit-tor-response'); }
  });
  const original = globalThis.fetch;
  globalThis.fetch = () => { bypasses++; throw new Error('direct leak'); };
  try {
    assert.equal((await exec(`try { await fetch('https://example.test/'); } catch(e) { console.log(e.message); }`)).exitCode, 0);
    assert.match(output(), /Network is unavailable/);
    assert.equal(selectedCalls, 0);
    ready = true;
    assert.equal((await exec(`console.log(await (await fetch('https://example.test/')).text()); console.log(await (await fetchTor('https://example.test/')).text());`)).exitCode, 0);
    assert.match(output(), /selected-response/);
    assert.match(output(), /explicit-tor-response/);
    assert.equal(selectedCalls, 1);
    assert.equal(torCalls, 1);
    ready = false;
    await call('http.open', { requestId: 'unready', url: 'https://example.test/', method: 'GET' });
    await assert.rejects(call('http.send', { requestId: 'unready' }), /Network is unavailable/);
    assert.equal(selectedCalls, 1);
    assert.equal(bypasses, 0, 'no direct fetch, bundled bypass or repeated HTTP re-entry');
  } finally { globalThis.fetch = original; host.dispose(); await runtime.close(); }
});

test('worker response uses demand pulls, bounded chunks and stream cancellation', async () => {
  const { state, network } = streaming();
  const { host, exec, output } = await open(network);
  try {
    const result = exec(`const r = await fetch('https://example.test/'); console.log('headers'); await sleep(150); const reader = r.body.getReader(); console.log((await reader.read()).value.length); console.log((await reader.read()).value.length); await reader.cancel();`);
    for (let i = 0; i < 200 && !output().includes('headers'); i++) await pause(5);
    assert.match(output(), /headers/);
    assert.equal(state.pulls, 0, 'metadata does not consume response body');
    assert.equal((await result).exitCode, 0);
    assert.match(output(), /65536\n65536/);
    assert.equal(state.pulls, 1, 'second RPC pull drains remainder, not another upstream read');
    assert.equal(state.cancelled, 1);
    assert.equal(state.signal.aborted, true);
  } finally { host.dispose(); }
});

test('worker AbortSignal cancels fetch while headers are pending', async () => {
  let aborted = false;
  const network = { fetch: (_input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
  }) };
  const { host, exec, output } = await open(network);
  try {
    assert.equal((await exec(`const c = new AbortController(); const p = fetch('https://example.test/', {signal:c.signal}); setTimeout(() => c.abort(), 60); try { await p; } catch(e) { console.log(e.name); }`)).exitCode, 0);
    assert.equal(aborted, true);
    assert.match(output(), /AbortError/);
  } finally { host.dispose(); }
});

test('normal worker completion cancels unconsumed response resources', async () => {
  const { state, network } = streaming();
  const { host, exec } = await open(network);
  try {
    assert.equal((await exec(`await fetch('https://example.test/'); return 'done';`)).exitCode, 0);
    assert.equal(state.pulls, 0);
    assert.equal(state.cancelled, 1);
    assert.equal(state.signal.aborted, true);
  } finally { host.dispose(); }
});

test('forced termination cancels in-flight main-thread fetch', async () => {
  let started = false, aborted = false;
  const network = { fetch: (_input, { signal }) => new Promise((_resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); });
  }) };
  const { host, exec, call } = await open(network);
  try {
    const result = exec(`await fetch('https://example.test/');`).catch(error => error);
    for (let i = 0; i < 200 && !started; i++) await pause(5);
    assert.equal(started, true);
    await call('env.exec.cancel', { id: 'run' });
    assert.equal((await result).code, 'aborted');
    assert.equal(aborted, true);
  } finally { host.dispose(); }
});

test('host HTTP routes injected fetch, streams and cancels; empty responses finish', async () => {
  const { state, network } = streaming();
  const { host, call } = await open(network);
  try {
    await call('http.open', { requestId: 'r', url: 'https://example.test/', method: 'GET' });
    assert.equal((await call('http.send', { requestId: 'r' })).status, 200);
    assert.equal(state.pulls, 0);
    const chunk = await call('http.read', { requestId: 'r' });
    assert.equal(Buffer.from(chunk.data, 'base64').length, 65536);
    await call('http.cancel', { requestId: 'r' });
    assert.equal(state.cancelled, 1);
    network.fetch = async () => new Response(null, { status: 204 });
    await call('http.open', { requestId: 'empty', url: 'https://example.test/', method: 'GET' });
    await call('http.send', { requestId: 'empty' });
    assert.deepEqual(await call('http.read', { requestId: 'empty' }), { data: '', done: true });
  } finally { host.dispose(); }
});

test('console git is bound to worker fs/cwd and local operations need no network', async () => {
  let requests = 0;
  const { host, exec, output } = await open({ fetch: async () => { requests++; throw new Error('Offline'); } });
  try {
    const result = await exec(`await fs.mkdir('repo'); process.chdir('repo'); await git.init({defaultBranch:'main'}); await fs.writeFile('/workspace/repo/note.txt','hello'); await git.add({filepath:'note.txt'}); const oid = await git.commit({message:'test', author:{name:'Test User',email:'test@example.invalid'}}); console.log(oid.length, await git.currentBranch()); console.log(await git.status({filepath:'note.txt'}));`);
    assert.equal(result.exitCode, 0, output());
    assert.match(output(), /40 main/);
    assert.match(output(), /unmodified/);
    assert.equal(requests, 0);
  } finally { host.dispose(); }
});

test('default host is lazy: Tailscale route by default, Tor idle until used, only tailscale/tor offered, choice persisted', async () => {
  for (const key of ['self-forming.browser.network-mode', 'self-forming.net.route', 'self-forming.browser.network-mode.migrated']) globalThis.localStorage?.removeItem(key);
  const { host } = await open();
  try {
    const status = await host.network.getStatus();
    assert.equal(status.mode, 'tailscale');
    assert.equal(status.torState, 'idle', 'no Tor WASM/bootstrap in Tailscale mode');
    assert.equal((await host.network.setMode('tor')).mode, 'tor');
    assert.equal(globalThis.localStorage?.getItem('self-forming.net.route'), 'net-tor');
    assert.equal(globalThis.localStorage?.getItem('self-forming.browser.network-mode'), null, 'legacy key is read-only compatibility');
    await assert.rejects(host.network.setMode('direct'), /tailscale or tor/);
    await assert.rejects(host.network.setMode('auto'), /tailscale or tor/);
    assert.equal(globalThis.localStorage?.getItem('self-forming.net.route'), 'net-tor');
    assert.equal(globalThis.localStorage?.getItem('self-forming.browser.network-mode'), null, 'legacy key is read-only compatibility');
  } finally { host.dispose(); }
  // An old saved choice cannot override the canonical choice after migration.
  globalThis.localStorage?.setItem('self-forming.browser.network-mode', 'auto');
  const { host: again } = await open();
  try { assert.equal((await again.network.getStatus()).mode, 'tor'); }
  finally { again.dispose(); for (const key of ['self-forming.browser.network-mode', 'self-forming.net.route', 'self-forming.browser.network-mode.migrated']) globalThis.localStorage?.removeItem(key); }
});

test('worker AbortSignal errors a pending body read and cancels upstream', async () => {
  let cancelled = false;
  const network = { fetch: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) };
  const { host, exec, output } = await open(network);
  try {
    const result = await exec(`const c = new AbortController(); const r = await fetch('https://example.test/', {signal:c.signal}); setTimeout(() => c.abort(), 50); try { await r.text(); } catch(e) { console.log(e.name); }`);
    assert.equal(result.exitCode, 0, output());
    assert.match(output(), /AbortError/);
    assert.equal(cancelled, true);
  } finally { host.dispose(); }
});

test('worker abort during buffered upload cancels the source before any network request', async () => {
  let requests = 0;
  const { host, exec, output } = await open({ fetch: async () => { requests++; throw new Error('Unexpected network'); } });
  try {
    const result = await exec(`let cancelled = false; const body = new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}},{highWaterMark:0}); const c = new AbortController(); const p = fetch('https://example.test/', {method:'POST',body,duplex:'half',signal:c.signal}); setTimeout(()=>c.abort(),50); try {await p;} catch(e){console.log(e.name,cancelled);}`);
    assert.equal(result.exitCode, 0, output());
    assert.match(output(), /AbortError true/);
    assert.equal(requests, 0);
  } finally { host.dispose(); }
});
