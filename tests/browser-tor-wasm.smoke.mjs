// Node 18 + ws harness ONLY. Not browser validation or Tor anonymity validation.
// Build test adapters: scripts/build-webtor-wasm.sh --smoke
// Run: node tests/browser-tor-wasm.smoke.mjs
// Optional live public-only Tor probe: add --tor (needs a currently valid snapshot).
// Neither mode unlocks the production application's Tor security gate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, deflateSync, gzipSync } from 'node:zlib';
import { webcrypto, X509Certificate, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import net from 'node:net';
const require = createRequire(import.meta.url);
const { WebSocket: NodeWebSocket, WebSocketServer } = require('ws');
// Browser semantics: close() while CONNECTING just aborts. Node's ws instead emits an
// 'error' event, which crashes the process when the client has already detached its
// handlers (our pre-open cancellation path does exactly that). Keep a no-op listener.
class WebSocket extends NodeWebSocket {
  constructor(...args) { super(...args); this.on('error', () => {}); }
}
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, '../build/webtor-rs');
const smokeDir = resolve(source, 'target/recovery-smoke');
assert(existsSync(join(smokeDir, 'webtor_wasm.js')), 'Build --smoke first; no prebuilt fallback');
globalThis.crypto = webcrypto;
globalThis.WebSocket = WebSocket;
// Explicit emulation, not a claim about WebView/browser globals.
globalThis.Window = class Window {};
globalThis.window = new Window();
window.performance = globalThis.performance;
window.crypto = webcrypto;
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
const realNow = Date.now;
const fixture = name => readFileSync(join(root, 'third-party/webtor-rs', name));
const consensus = brotliDecompressSync(fixture('fixtures/consensus.txt.br')).toString();
const certificates = fixture('authority-certificates.txt').toString();
const manifest = JSON.parse(fixture('fixtures/snapshot-manifest.json'));
const va = Date.parse(manifest.validAfter), vu = Date.parse(manifest.validUntil);
const prod = await import(pathToFileURL(join(root, 'libs/cors-rot/vendor/webtor/webtor_wasm.js')));
await prod.default({ module_or_path: readFileSync(join(root, 'libs/cors-rot/vendor/webtor/webtor_wasm_bg.wasm')) });
{
  // Production module surface must equal the reviewed allowlist (third-party/webtor-rs/production-exports.js.txt).
  const allowed = readFileSync(join(root, 'third-party/webtor-rs/production-exports.js.txt'), 'utf8')
    .split('\n').filter(Boolean).flatMap(line => line.startsWith('export {') ? line.slice(8, -1).split(',').map(s => s.trim()) : [line.split(' ').pop()]);
  assert.deepEqual(Object.keys(prod).filter(k => k !== 'default').sort(), allowed.sort(), 'Production exports differ from reviewed allowlist');
}
let checks = 0;
function check(name, fn) { fn(); ++checks; console.log(`ok ${checks} - ${name}`); }
async function bounded(promise, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function checkAsync(name, fn, ms = 12000) { await bounded(fn(), ms); ++checks; console.log(`ok ${checks} - ${name}`); }
const authFails = (c, a = certificates) => assert.throws(() => prod.validateDirectory(c, a));
try {
  // Freeze only this process's test clock. Production always uses current Date.now.
  Date.now = () => va + 60000;
  check('real Tor consensus authenticates with pinned authority quorum', () => {
    assert.equal(prod.validateDirectory(consensus, certificates), manifest.microdescriptorCount);
  });
  check('no certificates fails closed', () => authFails(consensus, ''));
  check('tampered consensus fails cryptographic verification', () => {
    authFails(consensus.replace(/^r (\S)/m, (_, c) => `r ${c === 'Z' ? 'Y' : 'Z'}`));
  });
  const marker = consensus.indexOf('\ndirectory-signature ') + 1;
  const header = consensus.slice(0, marker);
  const sigs = consensus.slice(marker).split(/(?=^directory-signature )/m).filter(Boolean);
  assert(sigs.length >= 5);
  check('only four authority signatures cannot form quorum', () => authFails(header + sigs.slice(0, 4).join('')));
  check('duplicated authority signatures cannot manufacture quorum', () => authFails(header + sigs[0].repeat(9)));
  check('changed authority certificate signatures fail closed', () => {
    authFails(consensus, certificates.replace(/(-----BEGIN SIGNATURE-----\n)[A-Za-z0-9+/]/g, '$1!'));
  });
  check('future consensus rejected', () => { Date.now = () => va - 60000; authFails(consensus); });
  check('expired consensus rejected', () => { Date.now = () => vu + 60000; authFails(consensus); });
  check('oversized authority input rejected', () => { Date.now = () => va + 60000; authFails(consensus, ' '.repeat(1048577)); });
} finally { Date.now = realNow; }

const m = await import(pathToFileURL(join(smokeDir, 'webtor_wasm.js')));
await m.default({ module_or_path: readFileSync(join(smokeDir, 'webtor_wasm_bg.wasm')) });
const errorText = error => error?.get?.('message') ?? error?.message ?? String(error);
const selectionConsensus = brotliDecompressSync(fixture('fixtures/selection-consensus.txt.br')).toString();
const selectionDescriptors = brotliDecompressSync(fixture('fixtures/selection-microdescriptors.txt.br')).toString();
const selectionManifest = JSON.parse(fixture('fixtures/selection-manifest.json'));
const sva = Date.parse(selectionManifest.validAfter), svu = Date.parse(selectionManifest.validUntil);
try {
  Date.now = () => sva + 60000;
  const blocks = selectionDescriptors.split(/(?=^onion-key\n)/m).filter(Boolean);
  const a = new m.SmokeDirectory(selectionConsensus, selectionDescriptors, certificates);
  const b = new m.SmokeDirectory(selectionConsensus, blocks.toReversed ? blocks.toReversed().join('') : [...blocks].reverse().join(''), certificates);
  const c = new m.SmokeDirectory(selectionConsensus, selectionDescriptors + blocks[0].repeat(10), certificates);
  await checkAsync('descriptor permutation/duplicates produce identical identity-indexed weights and draws', async () => {
    const summaries = await Promise.all([a.relays(), b.relays(), c.relays()]);
    for (const list of summaries) for (const relay of list) relay.flags.sort();
    assert.deepEqual(summaries[0], summaries[1]); assert.deepEqual(summaries[0], summaries[2]);
    const samples = await Promise.all([a.sample(17, 128), b.sample(17, 128), c.sample(17, 128)]);
    assert.deepEqual(samples[0], samples[1]); assert.deepEqual(samples[0], samples[2]);
    assert(new Set(samples[0]).size > 10, 'selection still restricted to top ten');
    const byId = new Map(summaries[0].map(r => [r.fingerprint, r]));
    assert(summaries[0].some(r => r.consensus_weight > 0));
    assert(summaries[0].some(r => r.middle_weight !== r.consensus_weight), 'Arti role weights unused');
    for (const id of samples[0]) assert(byId.get(id).middle_weight > 0);
    const eligible = summaries[0].filter(r => ['Fast','Stable','V2Dir'].every(f=>r.flags.includes(f)) && r.middle_weight>0);
    eligible.sort((a,b)=>b.middle_weight-a.middle_weight);
    const heavy = new Set(eligible.slice(0, Math.ceil(eligible.length/10)).map(r=>r.fingerprint));
    const expected = eligible.filter(r=>heavy.has(r.fingerprint)).reduce((n,r)=>n+r.middle_weight,0) / eligible.reduce((n,r)=>n+r.middle_weight,0);
    const observed = samples[0].filter(id=>heavy.has(id)).length/samples[0].length;
    assert(expected>0.3, 'fixture does not distinguish uniform from weighted selection');
    assert(Math.abs(observed-expected)<0.15, 'draw frequency inconsistent with signed weights');
  });
  // Exit selection must honour the signed microdescriptor `p` policy summary:
  // picking exits that reject the target port produced END/RESOLVEFAILED.
  const policyByDigest = new Map(blocks.map(block => [
    createHash('sha256').update(block).digest('hex'),
    block.split(String.fromCharCode(10)).find(line => line.startsWith('p ')) ?? 'p reject 1-65535',
  ]));
  const policyAllows = (line, port) => {
    const [, kind, list] = line.match(/^p (accept|reject) (.*)$/);
    const listed = list.split(',').some(item => {
      const [lo, hi = lo] = item.split('-').map(Number);
      return port >= lo && port <= hi;
    });
    return kind === 'accept' ? listed : !listed;
  };
  await checkAsync('signed exit policy summary is parsed per relay and constrains exit draws', async () => {
    const relays = await a.relays();
    assert(relays.length > 0);
    for (const relay of relays) {
      const line = policyByDigest.get(relay.microdescriptor_hash);
      assert(line, `no fixture descriptor for ${relay.fingerprint}`);
      assert(Array.isArray(relay.exit_ports), 'exit policy summary not retained');
      const covers = port => relay.exit_ports.some(([lo, hi]) => port >= lo && port <= hi);
      for (const port of [80, 443, 22, 6667, 9999]) {
        assert.equal(covers(port), policyAllows(line, port), `${relay.fingerprint} port ${port}`);
      }
    }
    const exits = new Map(relays.map(r => [r.fingerprint, r]));
    for (const port of [443, 80]) {
      const drawn = await a.exitSample(5, 48, port);
      assert.equal(drawn.length, 48);
      for (const id of drawn) {
        const relay = exits.get(id);
        assert(relay.flags.includes('Exit') && !relay.flags.includes('BadExit'));
        assert(policyAllows(policyByDigest.get(relay.microdescriptor_hash), port),
          `drew exit ${id} that rejects port ${port}`);
      }
    }
    // A port no fixture exit accepts must fail selection, not silently pick one.
    const closedPort = [...Array(64).keys()].map(i => 10000 + i)
      .find(port => ![...exits.values()].some(r => r.flags.includes('Exit') && policyAllows(policyByDigest.get(r.microdescriptor_hash), port)));
    if (closedPort !== undefined) await assert.rejects(a.exitSample(5, 1, closedPort));
  });
  await checkAsync('circuit builder slots are released on every failure path', async () => {
    // One manager, 16-circuit/2-builder budgets shared. Every attempt fails
    // (no channel); none may be rejected for capacity, which would mean a
    // builder slot or circuit slot leaked on the failure path.
    const messages = [];
    for (let i = 0; i < 6; ++i) messages.push(await a.circuitAttempt().then(() => 'ok', e => errorText(e)));
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => a.circuitAttempt().then(() => 'ok', e => errorText(e))));
    for (const message of [...messages, ...concurrent]) {
      assert.match(message, /Channel not established/, message);
      assert.doesNotMatch(message, /capacity/i);
    }
  });
  check('one omitted descriptor rejects the whole directory', () => assert.throws(() => new m.SmokeDirectory(selectionConsensus, blocks.slice(1).join(''), certificates), e => /coverage/.test(errorText(e))));
  check('arbitrarily repeated tiny subset cannot satisfy coverage', () => assert.throws(() => new m.SmokeDirectory(selectionConsensus, blocks[0].repeat(20), certificates)));
  await checkAsync('already-loaded directory cannot select or begin a NEW circuit after expiry', async () => {
    Date.now = () => svu;
    await assert.rejects(a.sample(17, 1), e => /valid authenticated directory/.test(errorText(e)));
    await assert.rejects(a.circuitAttempt(), e => /valid authenticated directory/.test(errorText(e)));
  });
  const firstCert = certificates.split(/(?=^dir-key-certificate-version )/m).filter(Boolean)[0];
  const certTime = key => Date.parse(firstCert.match(new RegExp('^'+key+' (.*)$', 'm'))[1].replace(' ', 'T')+'Z');
  check('well-formed altered authority signature fails signature verification', () => {
    Date.now = () => certTime('dir-key-published') + 60000;
    const bad = firstCert.replace(/(dir-key-certification\n-----BEGIN SIGNATURE-----\n)([A-Za-z0-9+/])/, (_, p, c) => p+(c==='A'?'B':'A'));
    assert.notEqual(bad, firstCert);
    assert.throws(() => m.smokeAuthority(bad), e => /signature/i.test(errorText(e)));
  });
  check('cryptographically signed but expired pinned authority certificate rejected', () => {
    Date.now = () => certTime('dir-key-expires') + 60000;
    assert.throws(() => m.smokeAuthority(firstCert), e => /validity/i.test(errorText(e)));
  });
  check('valid self-signed unpinned authority certificate rejected', () => {
    const unpinned = fixture('fixtures/unpinned-authcert.txt').toString();
    Date.now = () => Date.parse(unpinned.match(/^dir-key-published (.*)$/m)[1].replace(' ', 'T')+'Z') + 60000;
    assert.throws(() => m.smokeAuthority(unpinned), e => /unpinned/i.test(errorText(e)));
  });
  a.free(); b.free(); c.free();
} finally { Date.now = realNow; }
const nativeFetch = globalThis.fetch;
await checkAsync('directory fetch enforces streamed size cap and cancels reader', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(512)); }, cancel() { cancelled = true; }
  }));
  try { await assert.rejects(m.smokeFetch('https://fixture.invalid'), e => /size limit/.test(errorText(e))); assert(cancelled); }
  finally { globalThis.fetch = nativeFetch; }
});
await checkAsync('dropping pending directory fetch aborts network request', async () => {
  let aborted = false;
  globalThis.fetch = (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  try { await assert.rejects(m.smokeCancelledFetch('https://fixture.invalid')); await new Promise(r => setTimeout(r, 20)); assert(aborted); }
  finally { globalThis.fetch = nativeFetch; }
});
await checkAsync('cancelling pre-open WebSocket detaches handlers and releases socket budget', async () => {
  let socket;
  class HangingSocket { constructor() { socket = this; this.bufferedAmount = 0; this.readyState = 0; } close() { this.closed = true; } }
  globalThis.WebSocket = HangingSocket;
  try {
    const before = m.smokeSocketCount(); await assert.rejects(m.smokeCancelledOpen('ws://fixture.invalid'));
    assert(socket.closed); for (const key of ['onopen','onclose','onerror','onmessage']) assert(socket[key] == null, `${key} callback retained`);
    assert.equal(m.smokeSocketCount(), before);
  } finally { globalThis.WebSocket = WebSocket; }
});
await checkAsync('Turbo/SMUX/KCP retain exact bytes across Pending and partial writes', () => m.smokePartialFraming());
await checkAsync('1 MiB upload survives the full Turbo/KCP/SMUX stack: one datagram per packet, window backpressure', async () => {
  // Regression for lost uploads: KCP datagrams used to be concatenated into
  // one oversized packet (dropped by the bridge), and a full KCP send queue or
  // an exhausted SMUX peer window used to fail the write instead of blocking.
  const report = await bounded(m.smokeStackUpload(1024 * 1024, 64 * 1024), 60000);
  const stats = report instanceof Map ? Object.fromEntries(report) : report;
  assert.deepEqual(stats.problems, [], `stack reported: ${JSON.stringify(stats.problems)}`);
  assert.equal(stats.sent, 1024 * 1024);
  assert.equal(stats.received, 1024 * 1024, 'bridge did not receive every uploaded byte');
  assert(stats.datagrams > 700, `expected per-datagram writes, got ${stats.datagrams}`);
  assert(stats.maxDatagram <= 1500, `datagram of ${stats.maxDatagram} bytes exceeds the packet limit`);
});
const servers = [], sockets = new Set();
async function wsServer(handler) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  server.on('connection', ws => {
    sockets.add(ws); ws.on('close', () => sockets.delete(ws)); ws.on('error', () => {}); handler(ws);
  });
  await once(server, 'listening');
  return `ws://127.0.0.1:${server.address().port}`;
}
let tmp;
try {
  const echo = await wsServer(ws => ws.on('message', data => ws.send(data)));
  await checkAsync('pending read does not block write; multiple streams independent', async () => {
    const a = await m.smokeStream(echo), b = await m.smokeStream(echo);
    try {
      const ar = a.read(), br = b.read();
      await Promise.all([a.write(Uint8Array.of(1, 2, 3)), b.write(Uint8Array.of(9, 8))]);
      assert.deepEqual([...await ar], [1, 2, 3]);
      assert.deepEqual([...await br], [9, 8]);
    } finally { await Promise.all([a.close(), b.close()]); }
  });
  await checkAsync('close cancels pending and queued reads; idempotent; rejects later writes', async () => {
    const s = await m.smokeStream(echo);
    const reads = [s.read(), s.read(), s.read()];
    await new Promise(r => setTimeout(r, 20));
    await s.close(); await s.close();
    assert.deepEqual(await Promise.all(reads), [undefined, undefined, undefined]);
    await assert.rejects(s.write(Uint8Array.of(1)));
  });
  const eof = await wsServer(ws => { ws.send(Buffer.alloc(0)); ws.send(Buffer.from([4, 5])); ws.close(1000); });
  await checkAsync('empty frames do not strand queued data; clean peer close yields EOF', async () => {
    const s = await m.smokeStream(eof);
    try { assert.deepEqual([...await s.read()], [4, 5]); assert.equal(await s.read(), undefined); }
    finally { await s.close(); }
  });
  await checkAsync('large writes preserve bytes over chunked reads', async () => {
    const s = await m.smokeStream(echo);
    const bytes = Uint8Array.from({ length: 150000 }, (_, i) => i % 251);
    try {
      await s.write(bytes);
      const parts = []; let count = 0;
      while (count < bytes.length) { const p = await s.read(); assert(p); parts.push(Buffer.from(p)); count += p.length; }
      assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes));
    } finally { await s.close(); }
  });
  const flood = await wsServer(ws => ws.send(Buffer.alloc(300 * 1024)));
  await checkAsync('oversized WebSocket message fails closed before WASM copy', async () => {
    const stream = await m.smokeStream(flood);
    try { await assert.rejects(stream.read(), e => /receive limit/.test(errorText(e))); }
    finally { await stream.close(); }
  });
  await checkAsync('write/read reservations reject unbounded queues; backpressure is cancellable', async () => {
    let socket;
    class BlockedSocket {
      constructor() { socket = this; this.bufferedAmount = 0; this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
      send(bytes) { this.bufferedAmount += bytes.length; assert(this.bufferedAmount <= 256 * 1024); }
      close() { this.readyState = 3; }
    }
    globalThis.WebSocket = BlockedSocket;
    try {
      const stream = await m.smokeStream('ws://fixture.invalid');
      await assert.rejects(stream.write(new Uint8Array(256 * 1024 + 1)), e => /capacity/.test(errorText(e)));
      const writes = Array.from({length:4}, () => stream.write(new Uint8Array(1024)));
      const settled = Promise.allSettled(writes);
      await assert.rejects(stream.write(new Uint8Array(1)), e => /capacity/.test(errorText(e)));
      const reads = Array.from({length:4}, () => stream.read());
      const readResults = Promise.all(reads);
      await assert.rejects(stream.read(), e => /capacity/.test(errorText(e)));
      await new Promise(r => setTimeout(r, 30));
      assert(socket.bufferedAmount > 0, 'write never reached backpressure');
      await stream.close();
      assert((await settled).every(r => r.status==='rejected'));
      assert.deepEqual(await readResults, [undefined,undefined,undefined,undefined]);
      assert.equal(socket.readyState, 3);
    } finally { globalThis.WebSocket = WebSocket; }
  });
  await checkAsync('client close cancels and releases its pending streams; freshness is retained', async () => {
    const previousFetch = globalThis.fetch;
    Date.now = () => sva + 60000;
    globalThis.fetch = async url => {
      const name = new URL(typeof url==='string'?url:url.url).pathname.split('/').pop();
      const data = name==='consensus.txt.br' ? fixture('fixtures/selection-consensus.txt.br') :
        name==='microdescriptors.txt.br' ? fixture('fixtures/selection-microdescriptors.txt.br') : fixture('authority-certificates.txt');
      return new Response(data);
    };
    let client;
    try {
      const opts = new m.TorClientOptions('wss://unused.invalid/').withCreateCircuitEarly(false)
        .withConsensusBaseUrl('https://snapshot.invalid/tor');
      client = await new m.TorClient(opts);
      assert.equal(m.smokeNeedsRefresh(client), false);
      Date.now = () => Date.parse(selectionManifest.freshUntil)+1;
      assert.equal(m.smokeNeedsRefresh(client), true);
      const a = await m.smokeOwnedStream(client, echo), b = await m.smokeOwnedStream(client, echo);
      const pending = Promise.all([a.read(), b.read()]);
      await client.close();
      assert.deepEqual(await pending, [undefined,undefined]);
      await assert.rejects(a.write(Uint8Array.of(1)));
      await a.close(); await b.close();
    } finally { if (client) await client.close(); globalThis.fetch = previousFetch; Date.now = realNow; }
  });
  // Byte-exact large upload through the stream wrapper, raw and over TLS, in
  // the 64 KiB pieces the browser HTTP adapter uses. The counter server
  // replies with the total it received once it has `expect` bytes, so a lost
  // or unflushed tail fails instead of silently truncating the request.
  const uploadTotal = 1024 * 1024;
  const countingHandler = (socket, expect) => {
    let total = 0;
    return data => {
      total += data.length;
      if (total >= expect) socket(`COUNT ${total}`);
    };
  };
  const counterWs = await wsServer(ws => {
    const onData = countingHandler(text => ws.send(Buffer.from(text)), uploadTotal);
    ws.on('message', data => onData(Buffer.from(data)));
  });
  const sendInPieces = async (stream, bytes) => {
    for (let off = 0; off < bytes.length; off += 65536) {
      await stream.write(bytes.subarray(off, Math.min(off + 65536, bytes.length)));
    }
  };
  const readCount = async stream => {
    let text = '';
    while (!text.includes('\n') && !/COUNT \d+/.test(text)) {
      const chunk = await stream.read();
      if (!chunk) break;
      text += Buffer.from(chunk).toString('latin1');
      if (/COUNT \d+/.test(text)) break;
    }
    return Number(/COUNT (\d+)/.exec(text)?.[1] ?? -1);
  };
  const payload = Buffer.from(Uint8Array.from({ length: uploadTotal }, (_, i) => i % 251));
  await checkAsync('1 MiB raw upload in 64 KiB pieces arrives byte-complete', async () => {
    const stream = await m.smokeStream(counterWs);
    try {
      await sendInPieces(stream, payload);
      assert.equal(await readCount(stream), uploadTotal);
    } finally { await stream.close(); }
  }, 30000);
  const fixtureDirectoryFetch = async url => {
    const name = new URL(typeof url === 'string' ? url : url.url).pathname.split('/').pop();
    const data = name === 'consensus.txt.br' ? fixture('fixtures/selection-consensus.txt.br') :
      name === 'microdescriptors.txt.br' ? fixture('fixtures/selection-microdescriptors.txt.br') : fixture('authority-certificates.txt');
    return new Response(data);
  };
  const withFixtureClient = async body => {
    const previousFetch = globalThis.fetch;
    Date.now = () => sva + 60000;
    globalThis.fetch = fixtureDirectoryFetch;
    let client;
    try {
      client = await new m.TorClient(new m.TorClientOptions('wss://unused.invalid/')
        .withCreateCircuitEarly(false).withConsensusBaseUrl('https://snapshot.invalid/tor'));
      await body(client);
    } finally {
      if (client) await client.close();
      globalThis.fetch = previousFetch;
      Date.now = realNow;
    }
  };
  await checkAsync('stream slot is released when a stream errors instead of being closed', async () => {
    await withFixtureClient(async client => {
      assert.equal(m.smokeStreamSlots(client), 0);
      const stream = await m.smokeOwnedStream(client, flood);
      assert.equal(m.smokeStreamSlots(client), 1);
      // A terminal IO error must release the client's stream slot: an errored
      // stream that JS never closes used to occupy one of the 16 slots.
      await assert.rejects(stream.read(), e => /receive limit/.test(errorText(e)));
      assert.equal(m.smokeStreamSlots(client), 0, 'errored stream kept its slot');
      await stream.close();
      assert.equal(m.smokeStreamSlots(client), 0);
    });
  });
  await checkAsync('a retired circuit keeps carrying its open streams; only idle ones are torn down', async () => {
    await withFixtureClient(async client => {
      // Regression: retiring/sweeping a circuit used to terminate its tunnel,
      // which killed long-lived quiet streams (SSE) whenever an unrelated
      // connect attempt failed.
      const busy = await m.smokeTrackDeadCircuit(client, 'example.com', true);
      assert.equal(busy.holdsStream, true);
      await client.getCircuitStatus();            // sweeps
      await client.connect('example.com', 443, 500).then(() => {}, () => {});
      assert.equal(busy.terminated, false, 'circuit with an open stream was terminated');
      busy.releaseStream();

      const idle = await m.smokeTrackDeadCircuit(client, 'example.com', false);
      await client.getCircuitStatus();
      assert.equal(idle.terminated, true, 'retired circuit without streams should be torn down');
    });
  });
  await checkAsync('idle client streams survive silence and failing connects', async () => {
    await withFixtureClient(async client => {
      const idleA = await m.smokeOwnedStream(client, echo);
      const idleB = await m.smokeOwnedStream(client, echo);
      const busy = await m.smokeOwnedStream(client, echo);
      try {
        // Silence on the idle streams while another stream does traffic and
        // several connects fail: nothing may close the quiet streams.
        for (let i = 0; i < 3; ++i) {
          await client.connect('example.com', 443, 300).then(() => {}, () => {});
          await busy.write(Uint8Array.of(i));
          assert.deepEqual([...await busy.read()], [i]);
        }
        await new Promise(r => setTimeout(r, 3000));
        assert.equal(m.smokeStreamSlots(client), 3, 'idle streams lost their slots');
        for (const [index, stream] of [idleA, idleB].entries()) {
          await stream.write(Uint8Array.of(90 + index));
          assert.deepEqual([...await stream.read()], [90 + index], 'idle stream broke during silence');
        }
      } finally {
        await Promise.all([idleA.close(), idleB.close(), busy.close()]);
      }
    });
  }, 20000);
  // Directory source order (seed -> snapshot base URL -> bridge over Tor).
  // Every source goes through the same authentication; a bad or expired source
  // is logged and skipped, never trusted, and never downgrades the checks.
  try { m.init(); } catch { /* already initialised */ }
  // init() installs the WASM tracing layer, which also mirrors every line to
  // the console. Keep the harness output readable (WEBTOR_SMOKE_VERBOSE=1 shows it).
  if (!process.env.WEBTOR_SMOKE_VERBOSE) {
    const realLog = console.log;
    console.log = (...args) => { if (!/^(INFO|DEBUG|TRACE|WARN)\s/.test(String(args[0] ?? ''))) realLog(...args); };
  }
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tamperedConsensus = selectionConsensus.replace(/^r (\S)/m, (_, c) => `r ${c === 'Z' ? 'Y' : 'Z'}`);
  const seedOptions = () => new m.TorClientOptions('wss://unused.invalid/')
    .withCreateCircuitEarly(false).withConnectionTimeout(2000);
  const withDirectoryEnv = async (clock, fetchImpl, body) => {
    const previousFetch = globalThis.fetch;
    const logs = [];
    Date.now = () => clock;
    globalThis.fetch = fetchImpl;
    m.setLogCallback((_level, _target, message) => { if (logs.length < 4000) logs.push(message); });
    try { return await body(logs); }
    finally { globalThis.fetch = previousFetch; Date.now = realNow; }
  };
  const rejectingFetch = calls => async url => { calls.push(String(typeof url === 'string' ? url : url.url)); throw new Error('no snapshot available'); };
  await checkAsync('valid directory seed is authenticated and used before the snapshot URL', async () => {
    const fetched = [];
    await withDirectoryEnv(sva + 60000, rejectingFetch(fetched), async () => {
      let client;
      try {
        client = await new m.TorClient(seedOptions()
          .withConsensusBaseUrl('https://snapshot.invalid/tor')
          .withDirectorySeed(selectionConsensus, selectionDescriptors, certificates));
        assert.deepEqual(fetched, [], 'seed did not take precedence over the snapshot');
        const exported = client.exportDirectory();
        assert.equal(exported.consensus, selectionConsensus);
        assert.equal(exported.microdescriptors, selectionDescriptors);
        assert.equal(exported.certificates, certificates);
        assert.equal(exported.validAfter, iso(sva));
        assert.equal(exported.freshUntil, iso(Date.parse(selectionManifest.freshUntil)));
        assert.equal(exported.validUntil, iso(svu));
        assert.equal(client.directoryValidAfter(), exported.validAfter);
      } finally { if (client) await client.close(); }
    });
  });
  await checkAsync('bad seed is logged, ignored and the snapshot is used instead', async () => {
    await withDirectoryEnv(sva + 60000, fixtureDirectoryFetch, async logs => {
      let client;
      try {
        client = await new m.TorClient(seedOptions()
          .withConsensusBaseUrl('https://snapshot.invalid/tor')
          .withDirectorySeed(tamperedConsensus, selectionDescriptors, certificates));
        assert.equal(client.exportDirectory().consensus, selectionConsensus, 'tampered seed was installed');
        assert(logs.some(l => /Ignoring directory seed/.test(l)), logs.join(' | '));
      } finally { if (client) await client.close(); }
    });
  });
  await checkAsync('expired seed is ignored and the next source is used', async () => {
    const fetched = [];
    await withDirectoryEnv(svu + 60000, rejectingFetch(fetched), async logs => {
      // Past valid-until: the seed must be refused on lifetime grounds and the
      // bridge tried instead (which fails here: the bridge URL is invalid).
      await assert.rejects(new m.TorClient(seedOptions()
        .withDirectorySeed(selectionConsensus, selectionDescriptors, certificates)));
      assert(logs.some(l => /Ignoring directory seed/.test(l) && /validity|expired|outside/i.test(l)), logs.join(' | '));
      assert.deepEqual(fetched, [], 'an unconfigured snapshot URL was fetched');
    });
  });
  await checkAsync('no seed and no snapshot URL goes straight to the bridge, with no built-in default URL', async () => {
    const fetched = [];
    await withDirectoryEnv(sva + 60000, rejectingFetch(fetched), async logs => {
      await assert.rejects(new m.TorClient(seedOptions()));
      assert.deepEqual(fetched, [], `client fetched ${fetched.join(',')} instead of using the bridge`);
      assert(logs.some(l => /Bridge directory download failed/.test(l)), logs.join(' | '));
    });
  });
  await checkAsync('bad snapshot is logged, ignored and falls through to the bridge download', async () => {
    const badSnapshotFetch = async url => {
      const name = new URL(typeof url === 'string' ? url : url.url).pathname.split('/').pop();
      if (name === 'consensus.txt.br') return new Response(brotliCompressSync(Buffer.from(tamperedConsensus)));
      if (name === 'microdescriptors.txt.br') return new Response(fixture('fixtures/selection-microdescriptors.txt.br'));
      return new Response(fixture('authority-certificates.txt'));
    };
    await withDirectoryEnv(sva + 60000, badSnapshotFetch, async logs => {
      await assert.rejects(new m.TorClient(seedOptions().withConsensusBaseUrl('https://snapshot.invalid/tor')));
      assert(logs.some(l => /Ignoring directory snapshot/.test(l)), logs.join(' | '));
      assert(logs.some(l => /Bridge directory download failed/.test(l)), logs.join(' | '));
    });
  });
  await checkAsync('exported documents round-trip as a seed and authenticate without any fetch', async () => {
    await withDirectoryEnv(sva + 60000, fixtureDirectoryFetch, async () => {
      let a, b;
      try {
        a = await new m.TorClient(seedOptions().withConsensusBaseUrl('https://snapshot.invalid/tor'));
        const exported = a.exportDirectory();
        globalThis.fetch = async () => { throw new Error('seeded client must not fetch'); };
        b = await new m.TorClient(seedOptions()
          .withDirectorySeed(exported.consensus, exported.microdescriptors, exported.certificates));
        assert.deepEqual(b.exportDirectory(), exported);
        assert.equal(b.directoryValidAfter(), exported.validAfter);
      } finally { if (a) await a.close(); if (b) await b.close(); }
    });
  });
  // Bridge directory HTTP response decode: compression, bounds, bomb rejection.
  const dirResponse = (body, encoding) => {
    const headers = ['HTTP/1.0 200 OK', 'Date: now', 'Content-Type: text/plain'];
    let payload;
    if (encoding === 'deflate') { payload = deflateSync(Buffer.from(body)); headers.push('Content-Encoding: deflate'); }
    else if (encoding === 'gzip') { payload = gzipSync(Buffer.from(body)); headers.push('Content-Encoding: gzip'); }
    else payload = Buffer.from(body);
    return Buffer.concat([Buffer.from(headers.join('\r\n') + '\r\n\r\n'), payload]);
  };
  check('bridge directory response decode: deflate/gzip/identity round-trip under the output cap', () => {
    const text = 'router onion-key signing-key\n'.repeat(5000); // ~145 KiB plain, highly compressible
    for (const enc of ['deflate', 'gzip', 'identity']) {
      const resp = dirResponse(text, enc);
      if (enc !== 'identity') assert(resp.length < text.length / 4, `${enc} did not actually compress`);
      assert.equal(m.smokeDecodeDirectory(resp, 1 << 20), text, `${enc} decode mismatch`);
    }
  });
  check('bridge directory response decode rejects a decompression bomb and a non-200 status', () => {
    const huge = 'A'.repeat(2 * 1024 * 1024); // 2 MiB that deflates to a few KiB
    const bomb = dirResponse(huge, 'deflate');
    assert(bomb.length < 64 * 1024, 'bomb body should be tiny on the wire');
    assert.throws(() => m.smokeDecodeDirectory(bomb, 256 * 1024), e => /decompression limit/i.test(errorText(e)));
    assert.equal(m.smokeDecodeDirectory(bomb, 4 * 1024 * 1024).length, huge.length, 'fits under a larger cap');
    const notFound = Buffer.from('HTTP/1.0 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope');
    assert.throws(() => m.smokeDecodeDirectory(notFound, 1 << 20), e => /404|status/i.test(errorText(e)));
    const headerless = Buffer.from('no headers at all');
    assert.throws(() => m.smokeDecodeDirectory(headerless, 1 << 20), e => /header/i.test(errorText(e)));
  });
  check('raised directory document limits are consistent (24 / 96 / 1 MiB)', () => {
    const [consensus, microdesc, cert] = m.smokeDocumentLimits();
    assert.equal(consensus, 24 * 1024 * 1024, 'consensus cap');
    assert.equal(microdesc, 96 * 1024 * 1024, 'microdescriptor aggregate cap');
    assert.equal(cert, 1 * 1024 * 1024, 'certificate cap');
  });
  await checkAsync('bridge directory download retries on a retryable failure with a fresh channel, bounded', async () => {
    // Two retryable failures then success: 3 ops, a fresh (forced) acquire before each retry.
    const ok = await m.smokeRetryFresh(3, 2);
    assert.equal(ok.ok, true, 'should succeed on the third attempt');
    assert.equal(ok.opCalls, 3);
    assert.deepEqual(ok.acquireForce, [false, true, true], 'retries must force a fresh channel');
    // Bounded: more failures than attempts gives up without exceeding the bound.
    const fail = await m.smokeRetryFresh(3, 5);
    assert.equal(fail.ok, false, 'should give up after the bounded attempts');
    assert.equal(fail.opCalls, 3, 'must not exceed the attempt bound');
    assert.deepEqual(fail.acquireForce, [false, true, true]);
  });
  check('transport flow-control windows raised to match Snowflake; memory caps consistent and bounded', () => {
    const w = m.smokeTransportWindows();
    // KCP 128 -> 1024 packets each way; SMUX 64 KiB -> 1 MiB (Snowflake
    // StreamSize). Validated on a real device (~36 s cold start); see
    // FOLLOWUP-REMEDIATION section 9.
    assert.equal(w.kcpSndWnd, 1024, 'KCP send window');
    assert.equal(w.kcpRcvWnd, 1024, 'KCP receive window');
    assert.equal(w.smuxWindow, 1024 * 1024, 'SMUX stream window');
    // Caps must accommodate the windows so nothing is refused/overrun:
    assert(w.kcpWaitSnd > w.kcpSndWnd, `wait_snd ${w.kcpWaitSnd} must exceed snd_wnd ${w.kcpSndWnd}`);
    assert(w.kcpOutputBytes >= w.kcpSndWnd * 1376, 'output collector must hold one full window flush');
    assert(w.wsReceiveBytes >= w.smuxWindow, 'WebSocket receive queue must hold >= one SMUX window');
    // ...but every one stays explicitly bounded (<= 8 MiB per channel).
    for (const [k, v] of Object.entries(w)) assert(v <= 8 * 1024 * 1024, `${k} not bounded: ${v}`);
  });
  await checkAsync('2 MiB upload survives the raised-window stack with peer-window backpressure (byte-complete)', async () => {
    // Twice the 1 MiB SMUX window, so multiple peer-window grant cycles are
    // exercised under the raised KCP/SMUX windows and the raised queue caps.
    const report = await bounded(m.smokeStackUpload(2 * 1024 * 1024, 64 * 1024), 90000);
    const stats = report instanceof Map ? Object.fromEntries(report) : report;
    assert.deepEqual(stats.problems, [], `stack reported: ${JSON.stringify(stats.problems)}`);
    assert.equal(stats.received, 2 * 1024 * 1024, 'bridge did not receive every uploaded byte');
    assert(stats.maxDatagram <= 1500, `datagram of ${stats.maxDatagram} bytes exceeds the packet limit`);
  }, 100000);
  check('init() caps logging at INFO: a TRACE/DEBUG burst makes no console output above the cap', () => {
    // getVersionInfo advertises the cap so the page knows init() is safe.
    const version = m.getVersionInfo();
    const token = JSON.stringify(version instanceof Map ? Object.fromEntries(version) : version);
    assert(token.includes('log-capped'), 'getVersionInfo missing the log-capped token');
    const methods = ['log', 'debug', 'info', 'warn', 'error', 'trace'];
    const real = {};
    const grab = sink => { for (const n of methods) { real[n] = console[n]; console[n] = (...a) => sink.push(String(a[0] ?? '')); } };
    const restore = () => { for (const n of methods) console[n] = real[n]; };
    const aboveCap = l => /^(DEBUG|TRACE)\b/.test(l) && l.includes('LOGCAP_MARKER');
    // Debug OFF: a 200x TRACE+DEBUG burst must not reach the console; the INFO
    // line still does (the cap is at INFO, not below).
    const off = [];
    grab(off);
    try { m.setDebugEnabled(false); m.smokeLogBurst(200, 'LOGCAP_MARKER'); } finally { restore(); }
    assert.equal(off.filter(aboveCap).length, 0, `console flooded with DEBUG/TRACE: ${off.filter(aboveCap)[0]}`);
    assert(off.some(l => l.includes('LOGCAP_MARKER')), 'INFO marker suppressed — cap too aggressive');
    // Debug ON: DEBUG/TRACE go to the setLogCallback progress stream, still not the console.
    const on = [], cbLevels = [];
    grab(on);
    m.setLogCallback((level, _t, msg) => { if (String(msg).includes('LOGCAP_MARKER')) cbLevels.push(level); });
    try { m.setDebugEnabled(true); m.smokeLogBurst(5, 'LOGCAP_MARKER'); } finally { m.setDebugEnabled(false); restore(); m.setLogCallback(() => {}); }
    assert(cbLevels.includes('TRACE') && cbLevels.includes('DEBUG'), `debug mode did not route TRACE/DEBUG to the callback: ${cbLevels}`);
    assert.equal(on.filter(aboveCap).length, 0, 'WASMLayer leaked DEBUG/TRACE to the console even with the INFO cap');
  });
  await checkAsync('on-demand refresh excludes the seed, tries the bridge, and keeps the still-valid directory', async () => {
    const fetched = [];
    await withDirectoryEnv(sva + 60000, rejectingFetch(fetched), async logs => {
      let client;
      try {
        client = await new m.TorClient(seedOptions()
          .withDirectorySeed(selectionConsensus, selectionDescriptors, certificates));
        const installed = client.directoryValidAfter();
        assert.equal(m.smokeNeedsRefresh(client), false);
        Date.now = () => Date.parse(selectionManifest.freshUntil) + 1;
        assert.equal(m.smokeNeedsRefresh(client), true);
        logs.length = 0;
        await client.connect('example.com', 443, 1500).then(() => {}, () => {});
        assert(logs.some(l => /Bridge directory download failed/.test(l)), logs.join(' | '));
        assert(!logs.some(l => /Directory seed accepted/.test(l)), 'refresh reused the cached seed');
        assert.deepEqual(fetched, []);
        assert.equal(client.directoryValidAfter(), installed, 'still-valid directory was dropped');
      } finally { if (client) await client.close(); }
    });
  }, 20000);
  await checkAsync('dead Ready circuit is neither reported ready nor reused, and connect fails fast', async () => {
    await withFixtureClient(async client => {
      const dead = await m.smokeInsertDeadCircuit(client, 'example.com', 443);
      assert.deepEqual((await m.smokeCircuitIds(client)).map(([id]) => id), [dead]);
      const status = await client.getCircuitStatus();
      assert.equal(status.ready_circuits, 0, 'dead circuit still counted ready');
      assert.equal(status.has_ready_circuits, false);
      assert.equal(await client.getCircuitStatusString(), 'None');
      assert.deepEqual(await m.smokeCircuitIds(client), [], 'dead circuit retained');

      // Reinsert and make a real connect attempt: it must not be handed the
      // dead circuit, must give up well inside the caller's budget, and must
      // not report a capacity failure.
      await m.smokeInsertDeadCircuit(client, 'example.com', 443);
      const started = realNow();
      const message = await client.connect('example.com', 443, 2000).then(() => 'resolved', e => errorText(e));
      assert.notEqual(message, 'resolved');
      assert.doesNotMatch(message, /capacity/i, message);
      assert(realNow() - started < 6000, `connect took ${realNow() - started}ms`);
      assert.deepEqual(await m.smokeCircuitIds(client), [], 'dead circuit survived a connect attempt');
    });
  });
  // Temporary test-only self-signed certificate and key. Never real credentials.
  tmp = mkdtempSync(join(source, 'target/recovery-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth',
    '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')], { stdio: 'ignore' });
  for (const version of ['TLSv1.3', 'TLSv1.2']) {
    const server = tls.createServer({ key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')),
      minVersion: version, maxVersion: version }, socket => socket.end('DUMMY ONLY'));
    servers.push(server); server.on('tlsClientError', () => {});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const tunnel = await wsServer(ws => {
      const tcp = net.connect(server.address().port, '127.0.0.1');
      sockets.add(tcp); tcp.on('close', () => { sockets.delete(tcp); ws.close(); });
      tcp.on('error', () => ws.close());
      ws.on('message', data => tcp.write(data));
      tcp.on('data', data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
      ws.on('close', () => tcp.destroy());
    });
    await checkAsync(version === 'TLSv1.3' ? 'application TLS rejects untrusted self-signed root' : 'TLS1.2-only server rejected; no downgrade', async () => {
      await assert.rejects(bounded(m.smokeTls(tunnel, 'localhost')), error => {
        const message = error?.get?.('message') ?? error?.message ?? String(error);
        assert(!/deadline/.test(message), message);
        assert.match(message, version === 'TLSv1.3' ? /UnknownIssuer|unknown issuer/i : /ProtocolVersion|protocol version/i);
        return true;
      });
    });
  }
  // A real generated CA + signed leaf, trusted ONLY in the test-feature connector.
  // This is not an accept-any verifier and no test roots exist in production.
  const openssl = args => execFileSync('openssl', args, {stdio:'ignore'});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','10','-subj','/CN=Recovery Test CA',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',join(tmp,'ca.key'),'-out',join(tmp,'ca.pem')]);
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost',
    '-keyout',join(tmp,'leaf.key'),'-out',join(tmp,'leaf.csr')]);
  writeFileSync(join(tmp,'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  openssl(['x509','-req','-in',join(tmp,'leaf.csr'),'-CA',join(tmp,'ca.pem'),'-CAkey',join(tmp,'ca.key'),
    '-set_serial','42','-days','1','-extfile',join(tmp,'extensions'),'-out',join(tmp,'leaf.pem')]);
  const rootDer = new X509Certificate(readFileSync(join(tmp,'ca.pem'))).raw;
  const leafCert = new X509Certificate(readFileSync(join(tmp,'leaf.pem')));
  const trustedServer = tls.createServer({key:readFileSync(join(tmp,'leaf.key')),cert:readFileSync(join(tmp,'leaf.pem')),
    minVersion:'TLSv1.3',maxVersion:'TLSv1.3'}, socket => socket.end('DUMMY ONLY'));
  servers.push(trustedServer); trustedServer.on('tlsClientError',()=>{});
  trustedServer.listen(0,'127.0.0.1'); await once(trustedServer,'listening');
  const trustedTunnel = await wsServer(ws => {
    const tcp = net.connect(trustedServer.address().port,'127.0.0.1');
    sockets.add(tcp); tcp.on('close',()=>{ sockets.delete(tcp); ws.close(); });
    tcp.on('error',()=>ws.close()); ws.on('message',data=>tcp.write(data));
    tcp.on('data',data=>{ if(ws.readyState===WebSocket.OPEN) ws.send(data); }); ws.on('close',()=>tcp.destroy());
  });
  await checkAsync('trusted valid leaf succeeds with the same webpki verifier configuration',async()=>{
    const stream=await m.smokeTlsWithRoot(trustedTunnel,'localhost',rootDer);
    try { assert.equal(new TextDecoder().decode(await stream.read()),'DUMMY ONLY'); }
    finally { await stream.close(); }
  });
  await checkAsync('trusted-chain wrong hostname rejected',async()=>{
    await assert.rejects(m.smokeTlsWithRoot(trustedTunnel,'wrong.invalid',rootDer),e=>/NotValidForName|not valid for name/i.test(errorText(e)));
  });
  for (const [name, clock, pattern] of [
    ['expired', Date.parse(leafCert.validTo)+60000, /Expired|expired/],
    ['not-yet-valid', Date.parse(leafCert.validFrom)-60000, /NotValidYet|not valid yet/]
  ]) await checkAsync('trusted-chain '+name+' leaf rejected',async()=>{
    Date.now=()=>clock;
    try { await assert.rejects(m.smokeTlsWithRoot(trustedTunnel,'localhost',rootDer),e=>pattern.test(errorText(e))); }
    finally { Date.now=realNow; }
  });
  {
    // TLS 1.3 sink using the generated test CA, reached through a ws tunnel.
    const tlsCounter = tls.createServer({ key: readFileSync(join(tmp, 'leaf.key')), cert: readFileSync(join(tmp, 'leaf.pem')),
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
      const onData = countingHandler(text => socket.write(text), uploadTotal);
      socket.on('data', onData); socket.on('error', () => {});
    });
    servers.push(tlsCounter); tlsCounter.on('tlsClientError', () => {});
    tlsCounter.listen(0, '127.0.0.1'); await once(tlsCounter, 'listening');
    const tunnel = await wsServer(ws => {
      const tcp = net.connect(tlsCounter.address().port, '127.0.0.1');
      sockets.add(tcp); tcp.on('close', () => { sockets.delete(tcp); ws.close(); });
      tcp.on('error', () => ws.close());
      ws.on('message', data => tcp.write(data));
      tcp.on('data', data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
      ws.on('close', () => tcp.destroy());
    });
    await checkAsync('1 MiB TLS1.3 upload in 64 KiB pieces arrives byte-complete', async () => {
      const stream = await m.smokeTlsWithRoot(tunnel, 'localhost', rootDer);
      try {
        await sendInPieces(stream, payload);
        assert.equal(await readCount(stream), uploadTotal);
      } finally { await stream.close(); }
    }, 60000);
  }

} finally {
  for (const socket of sockets) socket.terminate ? socket.terminate() : socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
console.log(`PASS ${checks} fixture checks. Node18/ws only; not browser validation. Security gate stays closed.`);

if (process.argv.includes('--tor')) {
  // Explicit opt-in to public network traffic, NOT an insecure TLS opt-in.
  // Serve only the three bootstrap assets to the WASM fetch shim.
  globalThis.fetch = window.fetch = async request => {
    const name = new URL(typeof request === 'string' ? request : request.url).pathname.split('/').pop();
    assert(['authority-certificates.txt', 'consensus.txt.br', 'microdescriptors.txt.br'].includes(name));
    const path = name === 'authority-certificates.txt' ? `third-party/webtor-rs/${name}` : `apps/browser/tor/${name}`;
    return new Response(readFileSync(join(root, path)));
  };
  let client;
  let liveSockets = 0;
  // Wire-byte accounting for the bridge transport, so the bootstrap probe can
  // report what a directory download actually costs over Snowflake.
  const wire = { sent: 0, received: 0 };
  globalThis.WebSocket = class extends WebSocket {
    constructor(...args) {
      super(...args);
      ++liveSockets;
      this.once('close', () => --liveSockets);
      this.on('message', data => { wire.received += data.byteLength ?? data.length ?? 0; });
    }
    send(data, ...rest) { wire.sent += data.byteLength ?? data.length ?? 0; return super.send(data, ...rest); }
  };
  const httpGetOverTor = async (torClient, host, path) => {
    const stream = await torClient.connectTls(host, 443, 60000);
    try {
      const pending = (async () => {
        let text = '';
        for (;;) {
          const chunk = await stream.read();
          if (!chunk) return text;
          text += Buffer.from(chunk).toString('latin1');
          if (text.length > 262144) return text;
        }
      })();
      await stream.write(new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      return await bounded(pending, 90000);
    } finally { await stream.close().catch(() => {}); }
  };

  // Bridge bootstrap probe: NO seed and NO snapshot base URL, so the client
  // must fetch and authenticate its whole directory from the Snowflake bridge
  // over Tor (one-hop BEGIN_DIR streams), then prove the circuit works.
  let bridgeClient, seededClient;
  try {
    wire.sent = wire.received = 0;
    const bridgeStarted = realNow();
    bridgeClient = await bounded(new prod.TorClient(new prod.TorClientOptions('wss://snowflake.torproject.net/')
      .withConnectionTimeout(30000).withCircuitTimeout(60000).withCircuitUpdateInterval(undefined)), 240000);
    const bootstrapMs = Math.round(realNow() - bridgeStarted);
    const bridgeWire = { ...wire };
    const exported = bridgeClient.exportDirectory();
    assert(exported, 'no directory exported after the bridge bootstrap');
    console.log(`LIVE BRIDGE BOOTSTRAP: ${bootstrapMs} ms, bridge WebSocket wire bytes `
      + `${bridgeWire.received} in / ${bridgeWire.sent} out; documents: consensus `
      + `${exported.consensus.length} B, microdescriptors ${exported.microdescriptors.length} B, certificates `
      + `${exported.certificates.length} B, valid ${exported.validAfter} .. ${exported.validUntil}`);
    assert.equal(bridgeClient.directoryValidAfter(), exported.validAfter);
    await bounded(bridgeClient.waitForCircuit(), 120000);
    const page = await httpGetOverTor(bridgeClient, 'example.com', '/');
    assert(page.startsWith('HTTP/'), page.slice(0, 60));
    const isTor = await httpGetOverTor(bridgeClient, 'check.torproject.org', '/api/ip');
    assert(/"IsTor"\s*:\s*true/.test(isTor), `check.torproject.org did not confirm Tor: ${isTor.slice(-200)}`);
    console.log('PASS live Node/ws: bridge-bootstrapped directory, example.com over TLS, check.torproject.org IsTor');
    const seedStarted = realNow();
    const seedWireBefore = { ...wire };
    seededClient = await bounded(new prod.TorClient(new prod.TorClientOptions('wss://snowflake.torproject.net/')
      .withConnectionTimeout(30000).withCircuitTimeout(60000).withCircuitUpdateInterval(undefined)
      .withDirectorySeed(exported.consensus, exported.microdescriptors, exported.certificates)), 120000);
    console.log(`LIVE SEEDED BOOTSTRAP: ${Math.round(realNow() - seedStarted)} ms, wire bytes `
      + `${wire.received - seedWireBefore.received} in / ${wire.sent - seedWireBefore.sent} out `
      + '(directory from the exported seed)');
    assert.equal(seededClient.directoryValidAfter(), exported.validAfter);
    await bounded(seededClient.waitForCircuit(), 90000);
    assert((await httpGetOverTor(seededClient, 'example.com', '/')).startsWith('HTTP/'));
    console.log('PASS live Node/ws: exportDirectory -> withDirectorySeed round trip bootstraps and fetches over Tor');
  } finally {
    if (bridgeClient) await bridgeClient.close();
    if (seededClient) await seededClient.close();
  }

  const streams = [];
  try {
    await bounded((async () => {
      const options = new prod.TorClientOptions('wss://snowflake.torproject.net/')
        .withConsensusBaseUrl('https://snapshot.invalid/tor')
        .withConnectionTimeout(30000).withCircuitTimeout(45000)
        .withCircuitUpdateInterval(undefined);
      const badOptions = new prod.TorClientOptions('wss://snowflake.torproject.net/')
        .withConsensusBaseUrl('https://snapshot.invalid/tor').withConnectionTimeout(30000)
        .withBridgeFingerprint('2B280B23E1107BB62ABFC40DDCC8824814F80A73');
      await assert.rejects(new prod.TorClient(badOptions), e=>/handshake check|identity|match/i.test(errorText(e)));
      console.log('PASS live Node/ws: wrong pinned bridge identity rejected');
      client = await new prod.TorClient(options);
      await client.waitForCircuit();
      const raw = await client.connect('example.com', 80, 30000); streams.push(raw);
      const pendingRaw = raw.read();
      // A second stream and TLS handshake must work while the first read waits.
      const secure = await client.connectTls('example.com', 443, 30000); streams.push(secure);
      const request = new TextEncoder().encode('GET / HTTP/1.0\r\nHost: example.com\r\nConnection: close\r\n\r\n');
      const pendingTls = secure.read();
      await secure.write(request);
      const tlsBytes = await pendingTls;
      assert(tlsBytes && new TextDecoder().decode(tlsBytes).startsWith('HTTP/'));
      await secure.close();
      await raw.write(request);
      const rawBytes = await pendingRaw;
      assert(rawBytes && new TextDecoder().decode(rawBytes).startsWith('HTTP/'));
      await raw.close();
      console.log('PASS live Node/ws: authenticated directory, circuit, simultaneous raw TCP and TLS1.3 public HTTP streams');
      const idle = await client.connect('example.com',80,30000); streams.push(idle);
      const waiting = idle.read(); await client.close(); assert.equal(await waiting, undefined);
      await bounded((async()=>{ while(liveSockets!==0) await new Promise(r=>setTimeout(r,20)); })(),5000);
      console.log('PASS live Node/ws: client close ends pending Tor IO and closes underlying WebSocket');
    })(), 120000);
  } finally {
    await Promise.all(streams.map(stream => stream.close()));
    if (client) await client.close();
  }

  // Upload probe: POST bodies of several sizes through one client, written in
  // the same 64 KiB pieces the browser HTTP adapter uses. Public endpoints
  // only; the OpenAI call carries a deliberately invalid dummy bearer and is
  // expected to answer 401.
  let uploadClient;
  try {
    await bounded((async () => {
      uploadClient = await new prod.TorClient(new prod.TorClientOptions('wss://snowflake.torproject.net/')
        .withConsensusBaseUrl('https://snapshot.invalid/tor')
        .withConnectionTimeout(30000).withCircuitTimeout(60000)
        .withCircuitUpdateInterval(undefined));
      await uploadClient.waitForCircuit();
      const post = async (host, path, size, expect) => {
        const started = realNow();
        const body = new Uint8Array(size).fill(0x41);
        const head = new TextEncoder().encode(`POST ${path} HTTP/1.1\r\nHost: ${host}\r\n`
          + `Authorization: Bearer dummy-not-a-credential\r\nContent-Type: application/json\r\n`
          + `Content-Length: ${size}\r\nConnection: close\r\n\r\n`);
        let stream;
        try {
          stream = await uploadClient.connectTls(host, 443, 60000);
          let text = '';
          const reader = (async () => {
            for (;;) {
              const chunk = await stream.read();
              if (!chunk) return text;
              text += Buffer.from(chunk).toString('latin1');
              if (text.includes('\r\n\r\n')) return text;
            }
          })();
          await stream.write(head);
          for (let off = 0; off < size; off += 65536) {
            await stream.write(body.subarray(off, Math.min(off + 65536, size)));
          }
          const response = await bounded(reader, 60000);
          const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(response)?.[1] ?? 0);
          const ms = Math.round(realNow() - started);
          console.log(`  upload ${host} ${size}B -> HTTP ${status} in ${ms}ms (${Math.round(size / 1024 / (ms / 1000))} KiB/s)`);
          assert.equal(status, expect, `${host} ${size}B returned ${status}: ${response.slice(0, 80)}`);
        } finally { if (stream) await stream.close().catch(() => {}); }
      };
      for (const size of [10 * 1024, 150 * 1024, 1024 * 1024]) {
        await post('api.openai.com', '/v1/responses', size, 401);
      }
      for (const size of [10 * 1024, 150 * 1024]) {
        await post('postman-echo.com', '/post', size, 200);
      }
      console.log('PASS live Node/ws: 10 KiB / 150 KiB / 1 MiB POST bodies arrive complete (401 from OpenAI, 200 from postman-echo)');
    })(), 420000);
  } finally {
    if (uploadClient) await uploadClient.close();
  }

  // Idle-stream probe: an established TLS stream must survive minutes of
  // silence and still work, while other streams do traffic.
  let idleClient;
  try {
    await bounded((async () => {
      const idleSeconds = Number(process.env.WEBTOR_PROBE_IDLE ?? 90);
      idleClient = await new prod.TorClient(new prod.TorClientOptions('wss://snowflake.torproject.net/')
        .withConsensusBaseUrl('https://snapshot.invalid/tor')
        .withConnectionTimeout(30000).withCircuitTimeout(60000)
        .withCircuitUpdateInterval(undefined));
      await idleClient.waitForCircuit();
      // www.wikipedia.org keeps an idle TLS session open for minutes;
      // example.com closes it after ~15 s on the server side, which would
      // measure the site, not the Tor client.
      const host = 'www.wikipedia.org';
      const request = new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      const open = async () => {
        const stream = await idleClient.connectTls(host, 443, 60000);
        return { stream, pending: stream.read().then(b => ({ b }), e => ({ e })) };
      };
      const idleA = await open(), idleB = await open();
      const settledEarly = [];
      for (const [name, s] of [['A', idleA], ['B', idleB]]) {
        s.pending.then(r => settledEarly.push(`${name}: ${r.e ? errorText(r.e) : `${r.b?.length ?? 0} bytes`}`));
      }
      // A third stream does traffic while the other two stay silent.
      const busy = await idleClient.connectTls(host, 443, 60000);
      const busyPending = busy.read();
      await busy.write(request);
      assert((await busyPending) !== undefined, 'traffic stream failed');
      await busy.close();
      const started = realNow();
      for (let waited = 0; waited < idleSeconds; waited += 10) {
        await new Promise(r => setTimeout(r, 10000));
        assert.deepEqual(settledEarly, [], `idle stream died after ${Math.round((realNow() - started) / 1000)}s: ${settledEarly.join(' | ')}`);
      }
      assert.equal(await idleClient.getCircuitStatusString(), 'Ready');
      for (const [name, s] of [['A', idleA], ['B', idleB]]) {
        await s.stream.write(request);
        const result = await bounded(s.pending, 60000);
        assert(!result.e, `idle stream ${name} failed after silence: ${result.e ? errorText(result.e) : ''}`);
        const text = new TextDecoder().decode(result.b);
        assert(text.startsWith('HTTP/'), `idle stream ${name} returned ${text.slice(0, 40)}`);
        await s.stream.close();
      }
      console.log(`PASS live Node/ws: two TLS streams idle ${idleSeconds}s (with traffic on a third) still complete their requests`);
    })(), 360000);
  } finally {
    if (idleClient) await idleClient.close();
  }

  // Reliability load probe: many streams on ONE client, as the browser does.
  // Public HTTP GET to example.com only; reports success rate and timings.
  const sequentialCount = Number(process.env.WEBTOR_PROBE_SEQUENTIAL ?? 20);
  const concurrentCount = Number(process.env.WEBTOR_PROBE_CONCURRENT ?? 3);
  let probeClient;
  try {
    const request = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    const attempt = async label => {
      const started = realNow();
      let stream;
      try {
        stream = await probeClient.connectTls('example.com', 443, 45000);
        const pending = stream.read();
        await stream.write(request);
        const bytes = await pending;
        const text = bytes ? new TextDecoder().decode(bytes) : '';
        if (!text.startsWith('HTTP/')) throw new Error(`no HTTP response (${text.length} bytes)`);
        return { label, ok: true, ms: Math.round(realNow() - started) };
      } catch (error) {
        return { label, ok: false, ms: Math.round(realNow() - started), error: errorText(error) };
      } finally {
        if (stream) await stream.close().catch(() => {});
      }
    };
    const summary = results => {
      const times = results.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
      const pick = q => times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : NaN;
      return `${results.filter(r => r.ok).length}/${results.length} ok` +
        (times.length ? `, min ${times[0]}ms median ${pick(0.5)}ms p95 ${pick(0.95)}ms max ${times[times.length - 1]}ms` : '');
    };
    const sequential = [], concurrent = [];
    await bounded((async () => {
      probeClient = await new prod.TorClient(new prod.TorClientOptions('wss://snowflake.torproject.net/')
        .withConsensusBaseUrl('https://snapshot.invalid/tor')
        .withConnectionTimeout(30000).withCircuitTimeout(45000)
        .withCircuitUpdateInterval(undefined));
      await probeClient.waitForCircuit();
      for (let i = 1; i <= sequentialCount; ++i) {
        const result = await attempt(`seq-${i}`);
        sequential.push(result);
        console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.label} ${result.ms}ms ${result.error ?? ''}`.trimEnd());
      }
      concurrent.push(...await Promise.all(Array.from({ length: concurrentCount }, (_, i) => attempt(`conc-${i + 1}`))));
      for (const result of concurrent) {
        console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.label} ${result.ms}ms ${result.error ?? ''}`.trimEnd());
      }
      console.log(`LIVE PROBE sequential: ${summary(sequential)}`);
      console.log(`LIVE PROBE concurrent: ${summary(concurrent)}`);
      console.log(`LIVE PROBE circuit status after load: ${await probeClient.getCircuitStatusString()}`);
      const failures = [...sequential, ...concurrent].filter(r => !r.ok);
      if (failures.length) console.log(`LIVE PROBE failures: ${failures.map(f => `${f.label}: ${f.error}`).join(' | ')}`);
      // Network-dependent floors: the probe reports the real rate above, and
      // only fails the run if reliability collapses.
      assert(sequential.filter(r => r.ok).length >= Math.ceil(sequentialCount * 0.8),
        `sequential success rate too low: ${summary(sequential)}`);
      assert(concurrent.some(r => r.ok), `all ${concurrentCount} concurrent streams failed`);
    })(), 600000);
  } finally {
    if (probeClient) await probeClient.close();
    globalThis.WebSocket = WebSocket;
  }
}
