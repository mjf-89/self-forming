import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHttp } from '../scripts/native-http.mjs';

const endpoint = 'https://api.openai.com/v1/responses';
const deferred = () => Promise.withResolvers();
const open = (host, requestId, extra = {}) => host.call('http.open', {
  requestId, url: endpoint, method: 'POST', headers: [['authorization', 'Bearer dummy-test-only']], hasBody: false, ...extra,
});

test('development HTTP spools uploads beyond 32 MiB and pulls unlimited responses in bounded chunks', { timeout: 20000 }, async t => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const count = 529;
  let uploaded = 0, uploadPath, requests = 0, pulls = 0;
  const host = createNativeHttp(async (_url, init) => {
    requests++;
    uploadPath = init.body.path;
    assert.equal(init.headers.get('content-length'), String(chunk.length * count));
    assert.equal(init.headers.get('authorization'), 'Bearer dummy-test-only');
    assert.equal(init.redirect, 'manual');
    for await (const bytes of init.body) uploaded += bytes.length;
    return new Response(new ReadableStream({ pull(controller) {
      pulls++;
      if (pulls > count) controller.close(); else controller.enqueue(chunk);
    } }, { highWaterMark: 0 }));
  });
  t.after(() => host.close());
  await open(host, 'large', { hasBody: true });
  for (let i = 0; i < count; i++) await host.call('http.write', { requestId: 'large', data: chunk.toString('base64') });
  assert.equal(requests, 0, 'http.write must not start network IO');
  const response = await host.call('http.send', { requestId: 'large' });
  assert.equal(response.status, 200);
  assert.equal(uploaded, chunk.length * count);
  assert.equal(pulls, 0, 'http.send must not pre-read the response body');
  let downloaded = 0;
  while (true) {
    const result = await host.call('http.read', { requestId: 'large' });
    const bytes = Buffer.from(result.data, 'base64');
    assert.ok(bytes.length <= 64 * 1024);
    downloaded += bytes.length;
    if (result.done) break;
  }
  assert.equal(downloaded, uploaded);
  await assert.rejects(access(uploadPath), { code: 'ENOENT' });
});

test('development HTTP preserves explicit SDK headers and rejects unsafe endpoints, methods and managed headers', async t => {
  let requests = 0;
  const host = createNativeHttp(async (_url, init) => {
    requests++;
    assert.equal(init.headers.get('user-agent'), 'claude-cli/dummy');
    return new Response(null, { status: 204 });
  });
  t.after(() => host.close());
  for (const url of ['https://attacker.invalid/v1/responses', 'http://api.openai.com/v1/responses',
    'https://user@api.openai.com/v1/responses', 'https://api.openai.com:444/v1/responses',
    'https://api.openai.com/v1/files', 'https://api.openai.com/v1/responses#fragment',
    'https://auth.openai.com/api/accounts/oauth/token?extra=1']) {
    await assert.rejects(open(host, 'invalid', { url }), { code: 'URL_DENIED' });
  }
  for (const name of ['host', 'content-length', 'origin', 'referer', 'cookie', 'sec-fetch-site', 'proxy-authorization', 'accept-encoding'])
    await assert.rejects(open(host, 'invalid', { headers: [[name, 'dummy']] }), { code: 'INVALID_REQUEST' });
  await assert.rejects(open(host, 'invalid', { method: 'DELETE' }), { code: 'URL_DENIED' });
  await open(host, 'claude', { url: 'https://api.anthropic.com/v1/messages?beta=true', headers: [['User-Agent', 'claude-cli/dummy']] });
  assert.equal((await host.call('http.send', { requestId: 'claude' })).status, 204);
  assert.deepEqual(await host.call('http.read', { requestId: 'claude' }), { data: '', done: true });
  assert.equal(requests, 1);
});

test('development HTTP skips empty stream chunks and does not expose response cookies', async t => {
  const host = createNativeHttp(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.enqueue(new TextEncoder().encode('hello')); controller.close();
  } }), { headers: { 'set-cookie': 'dummy-cookie=never-visible', 'set-cookie2': 'dummy-cookie=never-visible' } }));
  t.after(() => host.close());
  await open(host, 'empty-chunk');
  const response = await host.call('http.send', { requestId: 'empty-chunk' });
  assert.equal(new Headers(response.headers).get('set-cookie'), null);
  assert.equal(new Headers(response.headers).get('set-cookie2'), null);
  assert.deepEqual(await host.call('http.read', { requestId: 'empty-chunk' }), { data: Buffer.from('hello').toString('base64'), done: false });
  assert.deepEqual(await host.call('http.read', { requestId: 'empty-chunk' }), { data: '', done: true });
});

test('development HTTP rejects redirects, cancels pending requests, sanitizes errors and cancels response readers', async t => {
  const started = deferred();
  let redirectCancelled = false, responseCancelled = false;
  const host = createNativeHttp(async (_url, init) => {
    const mode = init.headers.get('x-fixture');
    if (mode === 'redirect') return new Response(new ReadableStream({ cancel() { redirectCancelled = true; } }),
      { status: 302, headers: { location: 'https://attacker.invalid' } });
    if (mode === 'wait') {
      started.resolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort',
        () => reject(new Error('dummy-secret must not enter bridge errors')), { once: true }));
    }
    return new Response(new ReadableStream({ cancel() { responseCancelled = true; } }, { highWaterMark: 0 }));
  });
  t.after(() => host.close());
  await open(host, 'redirect', { headers: [['x-fixture', 'redirect']] });
  await assert.rejects(host.call('http.send', { requestId: 'redirect' }), { code: 'HTTP_REDIRECT' });
  assert.equal(redirectCancelled, true);
  await open(host, 'wait', { headers: [['x-fixture', 'wait']] });
  const pending = assert.rejects(host.call('http.send', { requestId: 'wait' }), error => error.code === 'ABORTED' && !error.message.includes('dummy-secret'));
  await started.promise;
  await host.call('http.cancel', { requestId: 'wait' });
  await pending;
  await open(host, 'response');
  await host.call('http.send', { requestId: 'response' });
  const read = assert.rejects(host.call('http.read', { requestId: 'response' }), { code: 'ABORTED' });
  await host.call('http.cancel', { requestId: 'response' });
  await read;
  assert.equal(responseCancelled, true);
});

test('development HTTP bounds only active operations and individual chunks, and close releases partial uploads', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'self-forming-http-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  let upstream = 0;
  const host = createNativeHttp(async () => { upstream++; throw new Error('Must not send'); }, { temporaryDirectory });
  for (let i = 0; i < 8; i++) await open(host, String(i), { hasBody: true });
  await assert.rejects(open(host, 'overflow'), { code: 'HTTP_BUSY' });
  await assert.rejects(open(host, '0'), { code: 'DUPLICATE_ID' });
  await host.call('http.write', { requestId: '0', data: Buffer.from('partial request').toString('base64') });
  await assert.rejects(host.call('http.write', { requestId: '1', data: Buffer.alloc(65537).toString('base64') }), error => ['INVALID_REQUEST', 'HTTP_TOO_LARGE'].includes(error.code));
  await host.close();
  assert.deepEqual(await readdir(temporaryDirectory), []);
  assert.equal(upstream, 0);
  await assert.rejects(open(host, 'after-close'), { code: 'ABORTED' });
});

test('development HTTP cleans uploads when cancelled during open and while a transport ignores abort', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'self-forming-http-test-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const started = deferred(); const returned = deferred();
  const host = createNativeHttp(async () => { started.resolve(); return returned.promise; }, { temporaryDirectory });
  t.after(() => host.close());
  const opening = assert.rejects(open(host, 'opening', { hasBody: true }), { code: 'ABORTED' });
  await host.call('http.cancel', { requestId: 'opening' });
  await opening;
  assert.deepEqual(await readdir(temporaryDirectory), []);
  await open(host, 'sending', { hasBody: true });
  const sending = assert.rejects(host.call('http.send', { requestId: 'sending' }), { code: 'ABORTED' });
  await started.promise;
  await host.close();
  assert.deepEqual(await readdir(temporaryDirectory), [], 'close must not wait for remote response before removing uploads');
  returned.resolve(new Response(null, { status: 204 }));
  await sending;
});
