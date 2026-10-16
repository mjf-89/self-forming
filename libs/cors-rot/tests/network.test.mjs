// cors-rot network + HTTP layer: fake Tor/Tailscale clients, no WASM, no public requests.
// Two transports only (tailscale|tor); there is no direct/auto route to test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserNetwork, createTorClientOptions } from '../network.js';
import { readFile } from 'node:fs/promises';
import { requestHttp } from '../http-stream.js';

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function stream(parts, { stall = false, write = null } = {}) {
  const queue = parts.map((part) => typeof part === 'string' ? encode(part) : part);
  return {
    writes: [], closed: 0, reads: 0,
    async read() { this.reads++; return queue.length ? queue.shift() : stall ? never() : undefined; },
    async write(bytes) { this.writes.push(bytes.slice()); if (write) return write(bytes); },
    close() { this.closed++; },
    get sent() { return this.writes.map(decode).join(''); },
  };
}
function clientFor(streams) {
  return {
    calls: [], circuits: 0,
    async waitForCircuit() { this.circuits++; },
    async connect(host, port, timeout) { this.calls.push({ tls: false, host, port, timeout }); return streams.shift(); },
    async connectTls(host, port, timeout) { this.calls.push({ tls: true, host, port, timeout }); return streams.shift(); },
  };
}
function setup(streams, options = {}) {
  const client = clientFor([...streams]);
  let created = 0;
  // keepAlive off by default: most tests check per-exchange framing/closing. Pool tests opt in.
  const network = createBrowserNetwork({ mode: 'tor', timeoutMs: 1000, keepAlive: false, nativeFetch: async () => { throw new Error('Unexpected native fetch'); }, createTorClient: async () => { created++; return client; }, ...options });
  return { client, network, get created() { return created; } };
}
const ok = (body = 'ok') => `HTTP/1.1 200 OK\r\nContent-Length: ${encode(body).length}\r\n\r\n${body}`;

test('chunked framing works at every split, including zero chunk and trailers', async () => {
  const wire = 'HTTP/1.1 100 Continue\r\nX-Interim: yes\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;foo="a\\\"b"\r\nWiki\r\n5\r\npedia\r\n0;done=yes\r\nX-Final: ignored\r\n\r\n';
  for (let split = 1; split < wire.length; split++) {
    const s = stream([wire.slice(0, split), wire.slice(split)], { stall: true });
    const { network } = setup([s]);
    const response = await network.fetchTor('https://example.com/');
    assert.equal(await response.text(), 'Wikipedia', `split ${split}`);
    assert.equal(s.closed, 1);
    assert.equal(response.headers.has('x-interim'), false);
    assert.equal(response.headers.has('x-final'), false);
  }
});

test('single byte boundaries, non-ASCII body, content-length and EOF framing', async () => {
  const bytes = encode(ok('héllo'));
  const s = stream([...bytes].map((b) => Uint8Array.of(b)));
  const eof = stream(['HTTP/1.0 200 OK\r\nX-Test: yes\r\n\r\n', 'one', '', 'two']);
  const { network } = setup([s, eof]);
  assert.equal(await (await network.fetchTor('https://example.com')).text(), 'héllo');
  assert.equal(await (await network.fetchTor('http://example.com')).text(), 'onetwo');
  assert.equal(s.closed, 1);
  assert.equal(eof.closed, 1);
});

test('streaming response resolves at headers, pulls body on demand, uses TLS exclusively', async () => {
  const s = stream(['HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n', 'ab', 'cd'], { stall: true });
  const { network, client } = setup([s]);
  const response = await network.fetchTor('https://example.com:8443/path?a=b#fragment');
  assert.equal(s.reads, 1);
  assert.equal(response.url, 'https://example.com:8443/path?a=b');
  assert.equal(response.redirected, false);
  assert.deepEqual(client.calls.map(({ tls, host, port }) => ({ tls, host, port })), [{ tls: true, host: 'example.com', port: 8443 }]);
  assert.match(s.sent, /^GET \/path\?a=b HTTP\/1.1\r\n/);
  assert.match(s.sent, /accept-encoding: identity\r\n/);
  assert.match(s.sent, /host: example.com:8443\r\n/);
  assert.match(s.sent, /connection: close\r\n/);
  const reader = response.body.getReader();
  assert.equal(decode((await reader.read()).value), 'ab');
  assert.equal(decode((await reader.read()).value), 'cd');
  assert.equal((await reader.read()).done, true);
  assert.equal(s.closed, 1);
  const insecure = { connect() { assert.fail('must never downgrade'); } };
  await assert.rejects(requestHttp(insecure, { url: 'https://example.com' }), /requires TLS/);
});

test('HEAD and no-body statuses close without waiting for a body', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304]]) {
    const s = stream([`HTTP/1.1 ${status} Test\r\nContent-Length: 42\r\nContent-Encoding: gzip\r\n\r\n`], { stall: true });
    const { network } = setup([s]);
    const response = await network.fetchTor('https://example.com', { method });
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
    assert.equal(s.closed, 1);
  }
});

test('cancelling a body, including a pending read, closes its stream', async () => {
  const s = stream(['HTTP/1.1 200 OK\r\n\r\n'], { stall: true });
  const { network } = setup([s]);
  const reader = (await network.fetchTor('https://example.com')).body.getReader();
  const pending = reader.read();
  await reader.cancel();
  assert.equal((await pending).done, true);
  assert.equal(s.closed, 1);
});

test('abort closes the stream before headers and during a body', async () => {
  for (const withHeaders of [false, true]) {
    const s = stream(withHeaders ? ['HTTP/1.1 200 OK\r\n\r\n'] : [], { stall: true });
    const { network } = setup([s]);
    const controller = new AbortController();
    const response = network.fetchTor('https://example.com', { signal: controller.signal });
    if (withHeaders) {
      const reader = (await response).body.getReader();
      const pending = reader.read();
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    } else {
      const rejection = assert.rejects(response, { name: 'AbortError' });
      await sleep(1);
      controller.abort();
      await rejection;
    }
    assert.equal(s.closed, 1);
  }
});

test('timeouts close stalled reads, writes, and unread streaming bodies', async () => {
  for (const kind of ['headers', 'write', 'body']) {
    const s = stream(kind === 'body' ? ['HTTP/1.1 200 OK\r\n\r\n'] : [], { stall: true, write: kind === 'write' ? never : null });
    const { network } = setup([s], { timeoutMs: 25 });
    const pending = network.fetchTor('https://example.com');
    if (kind === 'body') {
      const response = await pending;
      await sleep(40); // no read is outstanding; deadline must still close it
      await assert.rejects(response.text(), { name: 'TimeoutError' });
    } else await assert.rejects(pending, { name: 'TimeoutError' });
    assert.equal(s.closed, 1, kind);
  }
});

test('the HTTP timeout is an inactivity limit: a body that keeps streaming outlives it, a silent one fails naming the transport', async () => {
  // 40 body pieces 10 ms apart (>= 400 ms in total) with timeoutMs 200: never 200 ms without data.
  const pieces = Array.from({ length: 40 }, (_, i) => String(i % 10));
  const paced = (parts, gapMs, stallAtEnd = false) => {
    const queue = parts.map((part) => encode(part));
    return { writes: [], closed: 0, async read() { if (!queue.length) return stallAtEnd ? never() : undefined; await sleep(gapMs); return queue.shift(); },
      async write(bytes) { this.writes.push(bytes.slice()); }, close() { this.closed++; } };
  };
  const s = paced([`HTTP/1.1 200 OK\r\nContent-Length: ${pieces.length}\r\n\r\n`, ...pieces], 10);
  const { network } = setup([s], { timeoutMs: 200 });
  const started = Date.now();
  const response = await network.fetchTor('https://example.com');
  assert.equal(await response.text(), pieces.join(''));
  assert.ok(Date.now() - started >= 400, 'the exchange lasted longer than timeoutMs');
  // Silence after the head: TimeoutError, naming the route the request took.
  const stalled = stream(['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab'], { stall: true });
  const tor = setup([stalled], { timeoutMs: 30 });
  const body = (await tor.network.fetchTor('https://example.com')).text();
  await assert.rejects(body, (error) => error.name === 'TimeoutError' && /^Tor HTTP request timed out \(no data for 30 ms\)$/.test(error.message));
  assert.equal(stalled.closed, 1);
  const quiet = stream([], { stall: true });
  await assert.rejects(requestHttp({ connectTls: async () => quiet }, { url: 'https://example.com' }, { timeoutMs: 20, label: 'Tailscale' }),
    (error) => error.name === 'TimeoutError' && error.message === 'Tailscale HTTP request timed out (no data for 20 ms)');
});

test('a connect completing after timeout is closed, not leaked', async () => {
  const connect = deferred();
  const s = stream([ok()]);
  const client = { connectTls: () => connect.promise };
  await assert.rejects(requestHttp(client, { url: 'https://example.com' }, { timeoutMs: 20 }), { name: 'TimeoutError' });
  connect.resolve(s);
  await sleep(0);
  assert.equal(s.closed, 1);
  assert.equal(s.writes.length, 0);
});

test('cross-origin redirects strip credentials, custom API keys and referrers; POST 302 becomes GET', async () => {
  const first = stream(['HTTP/1.1 302 Found\r\nLocation: https://other.test/result\r\nContent-Length: 999\r\n\r\n'], { stall: true });
  const second = stream([ok()]);
  const { network } = setup([first, second]);
  const response = await network.fetchTor('https://example.com/post', {
    method: 'POST', body: 'payload', headers: {
      Authorization: 'Bearer dummy-test-only', Cookie: 'dummy=value', 'X-Api-Key': 'dummy-key',
      'X-Custom-Secret': 'dummy', Referer: 'https://example.com/private', 'Content-Type': 'application/json', Accept: 'text/plain',
    },
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(response.url, 'https://other.test/result');
  assert.equal(response.redirected, true);
  assert.match(first.sent, /POST \/post/);
  assert.match(first.sent, /content-length: 7/);
  assert.match(second.sent, /^GET \/result/);
  assert.doesNotMatch(second.sent, /authorization|cookie|api-key|custom-secret|referer|content-type|payload/i);
  assert.match(second.sent, /accept: text\/plain/);
  assert.equal(first.closed, 1);
});

test('307 preserves method/body and same-origin credentials; 303 preserves HEAD', async () => {
  const first = stream(['HTTP/1.1 307 Temporary Redirect\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n']);
  const second = stream([ok()]);
  const { network } = setup([first, second]);
  assert.equal(await (await network.fetchTor('https://example.com', { method: 'PUT', body: 'bytes', headers: { Authorization: 'dummy' } })).text(), 'ok');
  assert.match(second.sent, /^PUT \/next/);
  assert.match(second.sent, /authorization: dummy/);
  assert.ok(second.sent.endsWith('\r\n\r\nbytes'));
  const head1 = stream(['HTTP/1.1 303 See Other\r\nLocation: /next\r\n\r\n']);
  const head2 = stream(['HTTP/1.1 200 OK\r\n\r\n']);
  const pair = setup([head1, head2]);
  assert.equal((await pair.network.fetchTor('https://example.com', { method: 'HEAD' })).body, null);
  assert.match(head2.sent, /^HEAD \/next/);
});

test('redirect limits, manual/error policy, invalid location and HTTPS downgrade close intermediates', async () => {
  for (const [location, config, init, pattern] of [
    ['/next', { maxRedirects: 0 }, {}, /Too many redirects/],
    ['/next', {}, { redirect: 'error' }, /Redirect rejected/],
    ['file:///etc/passwd', {}, {}, /Only HTTP/],
    ['http://example.com/', {}, {}, /HTTPS to HTTP/],
    ['https://dummy:dummy@other.test/', {}, {}, /URL credentials/],
  ]) {
    const s = stream([`HTTP/1.1 302 Found\r\nLocation: ${location}\r\n\r\n`], { stall: true });
    const { network } = setup([s], config);
    await assert.rejects(network.fetchTor('https://example.com', init), pattern);
    assert.equal(s.closed, 1);
  }
  const s = stream(['HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n']);
  const { network } = setup([s]);
  const response = await network.fetchTor('https://example.com', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/next');
  assert.equal(s.closed, 1);
});

test('concurrent requests share initialization but never share stream reads', async () => {
  const gate = deferred();
  const slow = stream(['HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n']);
  const read = slow.read.bind(slow);
  slow.read = async () => slow.reads === 0 ? read() : gate.promise;
  const fast = stream([ok('fast')]);
  const fixture = setup([slow, fast]);
  assert.equal(fixture.created, 0);
  const [a, b] = await Promise.all([fixture.network.fetchTor('https://a.test'), fixture.network.fetchTor('https://b.test')]);
  const aText = a.text();
  assert.equal(await b.text(), 'fast');
  gate.resolve(encode('slow'));
  assert.equal(await aText, 'slow');
  assert.equal(fixture.created, 1);
  assert.equal(fixture.client.circuits, 1);
  assert.equal(slow.closed, 1);
  assert.equal(fast.closed, 1);
});

test('malformed or ambiguous response headers fail closed', async () => {
  const cases = [
    'NOT HTTP\r\n\r\n', 'HTTP/2 200 OK\r\n\r\n', 'HTTP/1.1 200 OK\n\n',
    'HTTP/1.1 101 Upgrade\r\n\r\n', 'HTTP/1.1 200 OK\r\n Fold: value\r\n\r\n',
    'HTTP/1.1 200 OK\r\nBad : value\r\n\r\n', 'HTTP/1.1 200 OK\r\nX: a\rb\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 9007199254740992\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n',
    'HTTP/1.1 100 Continue\r\n\r\n'.repeat(18),
    'HTTP/1.1 200 OK\r\nX: incomplete',
  ];
  for (const wire of cases) {
    const s = stream([wire]);
    const { network } = setup([s]);
    await assert.rejects(network.fetchTor('https://example.com'), /Invalid HTTP response/);
    assert.equal(s.closed, 1, wire);
  }
  const oversized = stream(['HTTP/1.1 200 OK\r\nX: ' + 'a'.repeat(100) + '\r\n\r\n']);
  await assert.rejects(setup([oversized], { maxHeaderBytes: 110 }).network.fetchTor('https://x.test'), /size limit/);
  assert.equal(oversized.closed, 1);
});

test('malformed/truncated chunks, forbidden trailers, and truncated content-length error the body', async () => {
  for (const payload of ['z\r\n', '-1\r\n', '1;bad="unterminated\r\n', '1\r\naX\r\n0\r\n\r\n', '5\r\nab', '1\r\na\r\n', '0\r\nContent-Length: 4\r\n\r\n', '0\r\n Bad: trailer\r\n\r\n', '0\r\nX: unfinished', '20000000000000\r\n']) {
    const s = stream(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + payload]);
    const response = await setup([s]).network.fetchTor('https://example.com');
    await assert.rejects(response.text(), /Invalid HTTP response/);
    assert.equal(s.closed, 1, payload);
  }
  const s = stream(['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab']);
  await assert.rejects((await setup([s]).network.fetchTor('https://example.com')).text(), /truncated content-length/);
  assert.equal(s.closed, 1);
});

test('reject URL/header injection, unsupported schemes, managed headers and oversized uploads', async () => {
  const fixture = setup([]);
  for (const url of ['ftp://example.com', 'https://example.com/\r\nInjected', 'https://dummy:dummy@example.com']) {
    await assert.rejects(fixture.network.fetchTor(url), TypeError);
  }
  for (const headers of [{ 'X-Test': 'value\r\nInjected: yes' }, { 'X-Test': 'value\n' }, { 'Bad Name': 'value' }]) {
    await assert.rejects(fixture.network.fetchTor('https://example.com', { headers }), TypeError);
  }
  assert.equal(fixture.created, 0);
  for (const header of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Expect', 'Proxy-Authorization']) {
    await assert.rejects(fixture.network.fetchTor('https://example.com', { headers: { [header]: 'dummy' } }), /Transport-managed/);
  }
  assert.equal(fixture.client.calls.length, 0);
  const limited = setup([], { maxRequestBodyBytes: 2 });
  await assert.rejects(limited.network.fetchTor('https://example.com', { method: 'POST', body: 'long' }), /buffer limit/);
  assert.equal(limited.created, 0);
});

test('only tailscale and tor transports are accepted; getStatus reports the selected one', () => {
  const network = createBrowserNetwork({ nativeFetch: async () => new Response('x') });
  assert.equal(network.getStatus().mode, 'tailscale');
  assert.equal(network.getStatus().transport, 'tailscale');
  assert.equal(network.setMode('tor').mode, 'tor');
  assert.equal(network.setTransport('tailscale').transport, 'tailscale');
  assert.throws(() => network.setMode('direct'), /tailscale or tor/);
  assert.throws(() => network.setMode('auto'), /tailscale or tor/);
  assert.throws(() => createBrowserNetwork({ mode: 'direct' }), /tailscale or tor/);
});

test('pre-aborted requests and initialization deadlines never connect', async () => {
  const fixture = setup([]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.network.fetchTor('https://example.com', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fixture.created, 0);
  const network = createBrowserNetwork({ mode: 'tor', createTorClient: never, timeoutMs: 20 });
  await assert.rejects(network.fetchTor('https://example.com'), { name: 'TimeoutError' });
});

test('production Tor is enabled but lazy; creating the network never bootstraps; a failed start fetches nothing', async () => {
  let calls = 0;
  const urls = [];
  const nativeFetch = async (input) => { calls++; urls.push(String(input instanceof Request ? input.url : input)); return new Response('x'); };
  const network = createBrowserNetwork({ mode: 'tor', nativeFetch });
  assert.equal(network.getStatus().torState, 'idle');
  assert.equal(network.getStatus().torAvailable, true);
  // Tor bootstrap fails closed before the WASM module or any destination is touched (here, in
  // Node with file: URLs, on the same-origin HTTP(S) asset rule). No hosted directory is fetched.
  await assert.rejects(network.fetch('https://example.com/secret', { headers: { Authorization: 'dummy-test-only' } }), /HTTP\(S\)/);
  assert.deepEqual(urls, [], 'nothing fetched: ' + urls.join(', '));
  assert.equal(network.getStatus().torState, 'error');
});

test('oversized trailers and chunk-size lines error and close the stream', async () => {
  for (const payload of ['0\r\nX-Large: ' + 'a'.repeat(140) + '\r\n\r\n', '1;ext=' + 'a'.repeat(8192) + '\r\na\r\n0\r\n\r\n']) {
    const s = stream(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + payload]);
    const { network } = setup([s], { maxHeaderBytes: 128 });
    const response = await network.fetchTor('https://example.com');
    await assert.rejects(response.text(), /size limit/);
    assert.equal(s.closed, 1);
  }
});

test('failed non-idempotent writes are never replayed', async () => {
  const s = stream([], { write: () => { throw new TypeError('mock failed write'); } });
  const fixture = setup([s]);
  await assert.rejects(fixture.network.fetchTor('https://example.com', { method: 'POST', body: 'dummy' }), /mock failed write/);
  assert.equal(fixture.client.calls.length, 1);
  assert.equal(s.closed, 1);
});

test('chunk extensions allow RFC whitespace and payloads are length-delimited, not marker-delimited', async () => {
  const payload = 'a\r\n0\r\n\r\nb';
  const wire = `HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\n\r\n${payload.length.toString(16)} \t; name \t= "value"; flag\r\n${payload}\r\n0\r\n\r\n`;
  const s = stream([...encode(wire)].map((b) => Uint8Array.of(b)), { stall: true });
  assert.equal(await (await setup([s]).network.fetchTor('https://example.com')).text(), payload);
  assert.equal(s.closed, 1);
});

test('one-shot header iterables are validated once and not silently discarded', async () => {
  function* headers() { yield ['X-Test', 'kept']; }
  const s = stream([ok()]);
  const { network } = setup([s]);
  await (await network.fetchTor('https://example.com', { headers: headers() })).text();
  assert.match(s.sent, /x-test: kept\r\n/);
  await assert.rejects(network.fetchTor('https://example.com', { headers: new Map([['X-Test', 'bad\n']]) }), /Invalid HTTP header/);
});

test('pathological empty stream reads are bounded instead of starving deadlines', async () => {
  const s = stream([]);
  s.read = async () => new Uint8Array();
  await assert.rejects(setup([s]).network.fetchTor('https://example.com'), /too many empty stream reads/);
  assert.equal(s.closed, 1);
});

test('offline production WASM loader options supply a Snowflake URL and retain the consumed builder result', async () => {
  // Read the actual browser deployment artifacts. No smoke/test WASM adapters,
  // no TorClient construction, no gate override, and no network are involved.
  const binary = await readFile(new URL('../vendor/webtor/webtor_wasm_bg.wasm', import.meta.url));
  const saved = new Map(['fetch', 'WebSocket', 'RTCPeerConnection'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let networkAttempts = 0;
  function denyNetwork() { networkAttempts++; throw new Error('Offline option regression attempted network access'); }
  let options, configured;
  try {
    for (const name of saved.keys()) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: denyNetwork });
    const module = await import('../vendor/webtor/webtor_wasm.js');
    assert.equal('smokeStream' in module, false);
    assert.equal('smokeTls' in module, false);
    await module.default({ module_or_path: binary });

    // This is the exact shared helper called by defaultClient, with the REAL
    // production constructor/builder and real allocated WASM options objects.
    options = createTorClientOptions(module);
    assert.ok(options instanceof module.TorClientOptions);
    assert.ok(options.__wbg_ptr > 0, 'loader must return the live builder result');
    configured = options.withConnectionTimeout(30000);
    assert.equal(options.__wbg_ptr, 0, 'the real wasm-bindgen builder consumes its receiver');
    assert.ok(configured instanceof module.TorClientOptions);
    assert.notEqual(configured, options);
    assert.ok(configured.__wbg_ptr > 0, 'returned loader options must remain usable');

    const network = createBrowserNetwork({ mode: 'tor', nativeFetch: denyNetwork });
    assert.equal(network.getStatus().torAvailable, true);
    assert.equal(network.getStatus().torState, 'idle', 'creating the network does not bootstrap Tor');
    assert.equal(networkAttempts, 0);
  } finally {
    if (options?.__wbg_ptr) options.free();
    if (configured?.__wbg_ptr) configured.free();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('large request bodies are written in pieces within the stream 256 KiB write limit', async () => {
  const limit = 256 * 1024;
  const s = stream(['HTTP/1.1 204 No Content\r\n\r\n'], { write: (bytes) => { if (bytes.length > limit) throw new RangeError('write exceeds stream limit'); } });
  const body = new Uint8Array(3 * 1024 * 1024 + 7).map((_, i) => i & 0xff);
  const response = await setup([s]).network.fetchTor('https://example.com/upload', { method: 'PUT', body });
  assert.equal(response.status, 204);
  assert.ok(s.writes.every((w) => w.length <= limit));
  const sent = new Uint8Array(s.writes.reduce((n, w) => n + w.length, 0));
  let offset = 0; for (const w of s.writes) { sent.set(w, offset); offset += w.length; }
  const headEnd = sent.findIndex((_, i) => sent[i] === 13 && sent[i + 1] === 10 && sent[i + 2] === 13 && sent[i + 3] === 10) + 4;
  assert.deepEqual(sent.subarray(headEnd), body);
});

test('keep-alive: a finished response returns its connection; the next request to the origin reuses it', async () => {
  const timings = [];
  const s = stream([ok('one'), ok('two')], { stall: true });
  const fixture = setup([s], { keepAlive: true, onStatus: (st) => { if (st.recentTorRequests?.length) timings.push(st.recentTorRequests[0]); } });
  assert.equal(await (await fixture.network.fetchTor('https://api.example.test/a')).text(), 'one');
  assert.equal(await (await fixture.network.fetchTor('https://api.example.test/b', { method: 'POST', body: 'x' })).text(), 'two');
  assert.equal(fixture.client.calls.length, 1, 'one Tor stream + TLS handshake for both requests');
  assert.doesNotMatch(s.sent, /connection: close/i);
  assert.match(s.sent, /GET \/a HTTP\/1\.1[\s\S]*POST \/b HTTP\/1\.1/);
  assert.equal(s.closed, 0, 'kept open in the pool');
  const last = fixture.network.getStatus().recentTorRequests[0];
  assert.equal(last.reused, true);
  assert.equal(last.origin, 'https://api.example.test');
});

test('keep-alive: a reused connection closed by the server is retried once on a fresh connection (no response bytes seen)', async () => {
  const first = stream([ok('one')]);          // EOF after the first response: server closed it while idle
  const second = stream([ok('two')], { stall: true });
  const fixture = setup([first, second], { keepAlive: true });
  assert.equal(await (await fixture.network.fetchTor('https://api.example.test/a')).text(), 'one');
  const response = await fixture.network.fetchTor('https://api.example.test/b', { method: 'POST', body: 'payload' });
  assert.equal(await response.text(), 'two');
  assert.equal(fixture.client.calls.length, 2);
  assert.equal(first.closed, 1);
  assert.match(second.sent, /POST \/b[\s\S]*payload$/);
  // But a fresh connection is never retried.
  const partial = stream(['HTTP/1.1 200 OK\r\nContent-Le']);
  const broken = setup([partial], { keepAlive: true });
  await assert.rejects(broken.network.fetchTor('https://h.test/', { method: 'POST', body: 'x' }));
  assert.equal(broken.client.calls.length, 1, 'fresh connections are never retried');
});

test('keep-alive: not reused for Connection: close, HTTP/1.0, EOF-delimited bodies, leftovers or cancelled bodies', async () => {
  const cases = [
    'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok',
    'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok',
  ];
  for (const wire of cases) {
    const a = stream([wire], { stall: true });
    const b = stream([ok('next')], { stall: true });
    const fx = setup([a, b], { keepAlive: true });
    assert.equal(await (await fx.network.fetchTor('https://k.test/')).text(), 'ok');
    assert.equal(a.closed, 1, wire.split('\r\n')[0]);
    assert.equal(await (await fx.network.fetchTor('https://k.test/')).text(), 'next');
    assert.equal(fx.client.calls.length, 2);
  }
  // EOF-delimited body: connection ends with the body.
  const eof = stream(['HTTP/1.1 200 OK\r\n\r\nbody']);
  const fx1 = setup([eof, stream([ok('next')], { stall: true })], { keepAlive: true });
  assert.equal(await (await fx1.network.fetchTor('https://k.test/')).text(), 'body');
  assert.equal(await (await fx1.network.fetchTor('https://k.test/')).text(), 'next');
  assert.equal(fx1.client.calls.length, 2);
  // Extra bytes after the framed body: not trusted for reuse.
  const extra = stream([ok('a') + 'GARBAGE'], { stall: true });
  const fx2 = setup([extra, stream([ok('b')], { stall: true })], { keepAlive: true });
  assert.equal(await (await fx2.network.fetchTor('https://k.test/')).text(), 'a');
  assert.equal(extra.closed, 1);
  // Body cancelled before the end: closed, not pooled.
  const big = stream(['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n12345'], { stall: true });
  const fx3 = setup([big, stream([ok('c')], { stall: true })], { keepAlive: true });
  const r = await fx3.network.fetchTor('https://k.test/');
  await r.body.cancel();
  assert.equal(big.closed, 1);
  assert.equal(await (await fx3.network.fetchTor('https://k.test/')).text(), 'c');
  assert.equal(fx3.client.calls.length, 2);
  // Different origins never share a connection.
  const o1 = stream([ok('1')], { stall: true });
  const fx4 = setup([o1, stream([ok('2')], { stall: true })], { keepAlive: true });
  await (await fx4.network.fetchTor('https://one.test/')).text();
  assert.equal(await (await fx4.network.fetchTor('https://two.test/')).text(), '2');
  assert.equal(fx4.client.calls.length, 2);
});

test('preconnect: warms a Tor-routed origin into the pool; the next request uses it; a not-started Tor is left alone', async () => {
  const s = stream([ok('warm hit')], { stall: true });
  const fixture = setup([s], { keepAlive: true, mode: 'tor' });
  assert.equal((await fixture.network.preconnect('https://api.example.test')).reason, 'tor-not-started', 'never starts Tor by itself');
  assert.equal(fixture.client.calls.length, 0);
  fixture.network.warmUp();
  const warm = await fixture.network.preconnect('https://api.example.test/v1/messages');
  assert.equal(warm.route, 'tor');
  assert.equal(warm.warmed, true);
  assert.equal(fixture.client.calls.length, 1);
  assert.equal((await fixture.network.preconnect('https://api.example.test')).reason, 'already-warm');
  assert.equal(fixture.client.calls.length, 1, 'no second connection while one is warm');
  const response = await fixture.network.fetch('https://api.example.test/v1/messages', { method: 'POST', body: 'x' });
  assert.equal(await response.text(), 'warm hit');
  assert.equal(fixture.client.calls.length, 1, 'request used the warmed connection');
  assert.equal(fixture.network.getStatus().recentTorRequests[0].reused, true);
});

test('connect(): opens a raw stream through the selected transport', async () => {
  const s = stream([ok()]);
  const fixture = setup([s], { mode: 'tor' });
  const raw = await fixture.network.connect('example.com', 443, { tls: true });
  assert.equal(raw, s);
  assert.deepEqual(fixture.client.calls, [{ tls: true, host: 'example.com', port: 443, timeout: 1000 }]);
});

test('tailscale mode: requests go through the Tailscale client (own keep-alive pool), never Tor; clear errors when not ready', async () => {
  const s = stream([ok('via exit'), ok('again')], { stall: true });
  const tsClient = clientFor([s]);
  let ready = false;
  const tailscale = {
    start() {},
    readyClient: () => (ready ? tsClient : undefined),
    async getClient() { if (!ready) throw Object.assign(new Error('Sign in to Tailscale in Settings → Network first.'), { code: 'TAILSCALE_LOGIN' }); return tsClient; },
  };
  const fixture = setup([], { mode: 'tailscale', keepAlive: true, tailscale });
  await assert.rejects(fixture.network.fetch('https://api.example.test/'), /Sign in to Tailscale/);
  ready = true;
  assert.equal(await (await fixture.network.fetch('https://api.example.test/a')).text(), 'via exit');
  assert.equal(await (await fixture.network.fetch('https://api.example.test/b', { method: 'POST', body: 'x' })).text(), 'again');
  assert.equal(tsClient.calls.length, 1, 'second request reused the Tailscale connection');
  assert.equal(fixture.client.calls.length, 0, 'Tor never used');
  assert.equal(fixture.created, 0, 'Tor client never created');
  assert.equal(fixture.network.getStatus().recentTorRequests[0].via, 'tailscale');
  assert.equal((await fixture.network.preconnect('https://api.example.test')).reason, 'already-warm');
});
