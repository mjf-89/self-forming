import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeFetch, type NativeFetchHost } from '../packages/native-host/src/fetch.ts';
import { createNativeBridge } from '../packages/native-host/src/bridge.ts';
import { bytesToBase64, base64ToBytes } from '../packages/native-host/src/wire.ts';
import { deferred, MockHost } from './bridge-support.ts';

const URL = 'https://api.anthropic.com/v1/messages?beta=true';
type Params = Record<string, unknown>;
class HttpHost implements NativeFetchHost {
  readonly calls: { method: string; params: Params }[] = [];
  readonly listeners = new Set<(error: Error) => void>();
  closed = false;
  url = URL;
  handler?: (method: string, params: Params) => unknown | Promise<unknown>;
  async call<T>(method: string, params: Params = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'http.open') this.url = String(params.url);
    if (this.handler) return await this.handler(method, params) as T;
    if (method === 'http.send') return this.head() as T;
    if (method === 'http.read') return { data: '', done: true } as T;
    return {} as T;
  }
  head(status = 200) { return { status, statusText: 'OK', headers: [['content-type', 'application/octet-stream']], url: this.url }; }
  onClose(listener: (error: Error) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close(error = new Error('Fixture bridge closed')) { this.closed = true; for (const listener of [...this.listeners]) listener(error); }
  count(method: string) { return this.calls.filter(call => call.method === method).length; }
}

test('Request/init semantics, binary upload and response metadata are preserved through native HTTP', async () => {
  const host = new HttpHost();
  const fetch = createNativeFetch(host);
  const request = new Request(URL, { method: 'POST', headers: { 'x-original': 'replace me', authorization: 'Bearer dummy-original' }, body: 'original' });
  const bytes = Uint8Array.from([0, 255, 1, 128, 195, 169]);
  const response = await fetch(request, { method: 'PUT', headers: { 'x-replacement': 'present', authorization: 'Bearer dummy-replacement', 'user-agent': 'dummy-client', origin: 'https://browser.invalid', cookie: 'dummy-cookie', 'content-length': '999', 'accept-encoding': 'gzip' }, body: bytes });
  const opened = host.calls[0].params;
  assert.equal(opened.method, 'PUT'); assert.equal(opened.url, URL); assert.equal(opened.hasBody, true);
  assert.deepEqual(new Headers(opened.headers as [string, string][]), new Headers({ authorization: 'Bearer dummy-replacement', 'x-replacement': 'present', 'user-agent': 'dummy-client' }));
  assert.deepEqual(base64ToBytes(String(host.calls.find(call => call.method === 'http.write')?.params.data)), bytes);
  assert.equal(response.status, 200); assert.equal(response.statusText, 'OK'); assert.equal(response.url, URL);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.equal(response.redirected, false);
  const clone = response.clone(); assert.equal(clone.url, URL);
  assert.equal(await response.text(), ''); assert.equal(await clone.text(), '');
  assert.equal(host.listeners.size, 0);
});

test('OAuth, model listing and inference use the same native protocol, without a browser fallback', async () => {
  const host = new HttpHost();
  const fetch = createNativeFetch(host);
  for (const url of ['https://platform.claude.com/v1/oauth/token', 'https://api.openai.com/v1/models', URL]) {
    const response = await fetch(url);
    await response.text();
  }
  assert.equal(host.count('http.open'), 3); assert.equal(host.count('http.send'), 3);
  assert.equal(host.calls.some(call => call.method.startsWith('auth.')), false);
  assert.equal(host.listeners.size, 0);
});

test('uploads and responses cross 4 MiB with bounded frames and no cumulative body limit', async () => {
  const host = new HttpHost();
  const total = 4 * 1024 * 1024 + 65539;
  let produced = 0, written = 0, sent = 0, maximum = 0, received = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === total) { controller.close(); return; }
      const size = Math.min(131075, total - produced);
      const bytes = Uint8Array.from({ length: size }, (_, offset) => (produced + offset) % 251);
      produced += size; controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
  host.handler = (method, params) => {
    if (method === 'http.write') {
      const bytes = base64ToBytes(String(params.data)); maximum = Math.max(maximum, bytes.length);
      for (let offset = 0; offset < bytes.length; offset++) assert.equal(bytes[offset], (written + offset) % 251);
      written += bytes.length;
    }
    if (method === 'http.send') { assert.equal(written, total); return host.head(); }
    if (method === 'http.read') {
      const size = Math.min(65536, total - sent);
      const bytes = Uint8Array.from({ length: size }, (_, offset) => (sent + offset) % 251);
      sent += size;
      return { data: bytesToBase64(bytes), done: sent === total };
    }
    return {};
  };
  const response = await createNativeFetch(host)(URL, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal(written, total); assert.equal(maximum, 65536); assert.equal(sent, 0);
  const reader = response.body!.getReader();
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    for (let offset = 0; offset < chunk.value.length; offset++) assert.equal(chunk.value[offset], (received + offset) % 251);
    received += chunk.value.length;
  }
  assert.equal(received, total); assert.equal(host.listeners.size, 0); assert.equal(host.count('http.cancel'), 0);
});

test('response reads follow consumer demand and preserve UTF-8 split across frames', async () => {
  const host = new HttpHost();
  const text = 'data: café 😀\n\n'; const bytes = new TextEncoder().encode(text);
  let offset = 0;
  host.handler = method => method === 'http.send' ? host.head() : method === 'http.read'
    ? { data: bytesToBase64(bytes.subarray(offset, ++offset)), done: offset === bytes.length } : {};
  const response = await createNativeFetch(host)(URL);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.count('http.read'), 0);
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let actual = decoder.decode((await reader.read()).value, { stream: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.count('http.read'), 1);
  while (true) { const chunk = await reader.read(); if (chunk.done) break; actual += decoder.decode(chunk.value, { stream: true }); }
  actual += decoder.decode(); assert.equal(actual, text); assert.equal(host.listeners.size, 0);
});

test('abort interrupts a hung upload read, upload acknowledgement or response-head call exactly once', async () => {
  for (const phase of ['reader', 'http.write', 'http.send']) {
    const host = new HttpHost(); const started = deferred(); const never = deferred<unknown>();
    const controller = new AbortController(); let uploadCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(target) { if (phase === 'reader') started.resolve(); else { target.enqueue(new Uint8Array([1])); target.close(); } },
      cancel() { uploadCancelled = true; },
    }, { highWaterMark: 0 });
    host.handler = method => { if (method === phase) { started.resolve(); return never.promise; } return {}; };
    const pending = createNativeFetch(host)(URL, { method: 'POST', body: stream, duplex: 'half', signal: controller.signal } as RequestInit);
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    await started.promise; controller.abort(); await rejection;
    assert.equal(host.count('http.cancel'), 1); assert.equal(host.listeners.size, 0);
    if (phase === 'reader') assert.equal(uploadCancelled, true);
    if (phase !== 'reader') never.reject(new Error('Late fixture failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.count('http.cancel'), 1);
  }
});

test('abort after headers and consumer cancellation interrupt outstanding body reads', async () => {
  for (const source of ['signal', 'consumer', 'bridge']) {
    const host = new HttpHost(); const started = deferred(); const never = deferred();
    host.handler = method => method === 'http.send' ? host.head() : method === 'http.read' ? (started.resolve(), never.promise) : {};
    const controller = new AbortController();
    const response = await createNativeFetch(host)(URL, { signal: controller.signal });
    const reader = response.body!.getReader();
    const pending = reader.read();
    const settled = source === 'consumer' ? pending : assert.rejects(pending, source === 'bridge' ? /Fixture bridge closed/ : { name: 'AbortError' });
    await started.promise;
    if (source === 'signal') controller.abort();
    else if (source === 'consumer') await reader.cancel();
    else host.close();
    await settled;
    assert.equal(host.count('http.cancel'), 1); assert.equal(host.listeners.size, 0);
    never.reject(new Error('Late read failure'));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('real bridge close rejects a pending header request and cleans the adapter subscription', async () => {
  const started = deferred(); const never = deferred();
  const transport = new MockHost(({ method }) => { if (method === 'http.send') { started.resolve(); return never.promise; } return {}; });
  const bridge = createNativeBridge(transport);
  const pending = assert.rejects(createNativeFetch(bridge)(URL), /Native bridge is closed/);
  await started.promise; bridge.close(); await pending;
  never.reject(new Error('Late native result')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.onmessage, null);
});

test('HTTP errors remain responses; invalid metadata, redirects and invalid frames fail without echoing data', async () => {
  const dummy = 'Bearer dummy-do-not-echo';
  const host = new HttpHost();
  host.handler = method => method === 'http.send' ? host.head(401) : method === 'http.read'
    ? { data: bytesToBase64(new TextEncoder().encode('{"error":"fixture"}')), done: true } : {};
  const response = await createNativeFetch(host)(URL);
  assert.equal(response.status, 401); assert.equal(response.ok, false); assert.equal(await response.text(), '{"error":"fixture"}');
  for (const head of [{ ...host.head(), status: 0 }, { ...host.head(), headers: [['bad\nheader', dummy]] }, { ...host.head(), url: 'https://other.invalid' }, host.head(302)]) {
    const bad = new HttpHost(); bad.handler = method => method === 'http.send' ? head : {};
    await assert.rejects(createNativeFetch(bad)(URL), error => error instanceof TypeError && !error.message.includes(dummy));
    assert.equal(bad.count('http.cancel'), 1); assert.equal(bad.listeners.size, 0);
  }
  for (const chunk of [{ data: dummy, done: true }, { data: '', done: false }, { data: bytesToBase64(new Uint8Array(65537)), done: true }]) {
    const bad = new HttpHost(); bad.handler = method => method === 'http.send' ? bad.head() : method === 'http.read' ? chunk : {};
    const broken = await createNativeFetch(bad)(URL);
    await assert.rejects(broken.text(), /Invalid HTTP response/);
    assert.equal(bad.count('http.cancel'), 1); assert.equal(bad.listeners.size, 0);
  }
});

test('empty/HEAD responses release native resources and pre-aborted requests never open one', async () => {
  for (const status of [204, 205, 304]) {
    const host = new HttpHost(); host.handler = method => method === 'http.send' ? host.head(status) : {};
    const response = await createNativeFetch(host)(URL);
    assert.equal(response.body, null); assert.equal(await response.text(), '');
    assert.equal(host.count('http.cancel'), 1); assert.equal(host.listeners.size, 0);
  }
  const host = new HttpHost(); const response = await createNativeFetch(host)(URL, { method: 'HEAD' });
  assert.equal(response.body, null); assert.equal(host.count('http.cancel'), 1);
  const abortedHost = new HttpHost();
  await assert.rejects(createNativeFetch(abortedHost)(URL, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(abortedHost.calls.length, 0); assert.equal(abortedHost.listeners.size, 0);
});
