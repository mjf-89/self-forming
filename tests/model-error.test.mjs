import assert from 'node:assert/strict';
import test from 'node:test';
import { safeModelErrorResponse } from '../apps/common/model-error.js';

const dummy = 'sk-ant-oat01-dummy-0123456789-ABCDEFGHIJKLMN';
const options = { provider: 'Claude', init: { headers: { authorization: `Bearer ${dummy}` } } };
const failure = (error, extra = {}) => new Response(JSON.stringify({ error, ...extra }), {
  status: 401, headers: { 'content-type': 'application/json', 'x-untrusted': dummy },
});
const sanitized = async (error, config = options) => {
  const response = await safeModelErrorResponse(failure(error), config);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-untrusted'), null);
  return response.json();
};

test('a bounded provider reason survives; only supported error fields are forwarded', async () => {
  const result = await sanitized({ message: 'OAuth token has expired. Please sign in again.', type: 'authentication_error', code: 'token_expired', request: { headers: dummy }, trace: dummy });
  assert.deepEqual(result, { error: {
    message: 'Claude request failed (401). OAuth token has expired. Please sign in again. (authentication_error; token_expired)',
    type: 'authentication_error', code: 'token_expired',
  } });
  assert.equal(JSON.stringify(result).includes(dummy), false);
});

test('credentials, escaped representations, masked fragments and recognizable tokens are redacted in every field', async () => {
  const unprefixed = 'dummy-opaque-0123456789-ABCDEFGHIJKLMN';
  const echoes = [
    dummy, JSON.stringify(dummy), dummy.replaceAll('-', '\\u002d'), dummy.replaceAll('-', '\\x2d'),
    encodeURIComponent(dummy).replaceAll('-', '%2D'), dummy.split('').join('\u200b'),
    'sk-ant-...IJKLMN', '****IJKLMN', '0123456789.', 'ABCDEFGHIJKLMN',
    'sk-unknown-dummy-secret', 'eyJhbGciOiJIUzI1NiJ9.eyJkdW1teSI6dHJ1ZX0.dummySignature',
    'Bearer unrecognizedDummyCredential',
  ];
  for (const echo of echoes) {
    const result = await sanitized({ message: `Invalid credential: "${echo}"`, type: echo, code: echo });
    const output = JSON.stringify(result);
    assert.match(result.error.message, /\[redacted\]/);
    for (const fragment of [dummy, 'IJKLMN', '0123456789', 'unknown-dummy-secret', 'unrecognizedDummyCredential', 'eyJhbGci']) {
      assert.equal(output.includes(fragment), false, `Leaked dummy fragment for ${echo}`);
    }
  }
  const result = await sanitized({ message: `The key is ${unprefixed}; partial: 0123456789.` }, { provider: 'OpenAI', init: { headers: { 'x-api-key': unprefixed } } });
  assert.equal(JSON.stringify(result).includes(unprefixed), false);
  assert.equal(JSON.stringify(result).includes('0123456789'), false);
});

test('Request headers and explicit init header replacement both redact the effective credentials', async () => {
  const input = new Request('https://api.example.invalid/model', { headers: { authorization: `Bearer ${dummy}` } });
  assert.equal(JSON.stringify(await sanitized({ message: dummy }, { provider: 'Claude', input })).includes(dummy), false);
  const override = 'opaque-dummy-override-credential';
  const result = await sanitized({ message: override }, { provider: 'OpenAI', input, init: { headers: [['x-api-key', override]] } });
  assert.equal(JSON.stringify(result).includes(override), false);
  assert.match(result.error.message, /\[redacted\]/);
});

test('redaction precedes display truncation, including a credential crossing the limit', async () => {
  const result = await sanitized({ message: 'a'.repeat(450) + ' ' + dummy + ' ' + 'b'.repeat(100) });
  assert.equal(Array.from(result.error.message).length, 500);
  assert.equal(JSON.stringify(result).includes('sk-ant'), false);
  assert.equal(JSON.stringify(result).includes('0123456789'), false);
  assert.match(result.error.message, /\[redacted\]/);
});

test('HTML, malformed JSON, invalid fields, invalid UTF-8 and already-read bodies use the generic fallback', async () => {
  const responses = [
    new Response(`<h1>${dummy}</h1>`, { status: 401, headers: { 'content-type': 'text/html' } }),
    new Response(`{"error":${dummy}`, { status: 401, headers: { 'content-type': 'application/json' } }),
    failure({ message: {}, type: ['bad'], code: null }),
    failure({ message: 'x'.repeat(8193) }), failure([]), failure(null),
    new Response(new Uint8Array([0xc3, 0x28]), { status: 401, headers: { 'content-type': 'application/json' } }),
  ];
  const read = failure({ message: dummy });
  await read.text();
  responses.push(read);
  for (const response of responses) {
    const result = await (await safeModelErrorResponse(response, options)).json();
    assert.deepEqual(result, { error: { message: 'Claude request failed (401). Check your sign-in, model access and account limits.' } });
  }
});

test('oversized streams are cancelled after the small bound without draining the body', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(4096).fill(32)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await (await safeModelErrorResponse(new Response(stream, { status: 502, headers: { 'content-type': 'application/json' } }), options)).json();
  assert.equal(pulls, 9);
  assert.equal(cancelled, true);
  assert.match(result.error.message, /Claude request failed \(502\).*Check your sign-in/);
  let declaredPulls = 0, declaredCancelled = false;
  const declared = new ReadableStream({ pull() { declaredPulls++; }, cancel() { declaredCancelled = true; } }, { highWaterMark: 0 });
  await safeModelErrorResponse(new Response(declared, { status: 500, headers: { 'content-type': 'application/json', 'content-length': '32769' } }), options);
  assert.equal(declaredPulls, 0);
  assert.equal(declaredCancelled, true);
});

test('reader failures, locked responses and abort during an outstanding read fall back without hanging', async () => {
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error(dummy)); } });
  const failed = await (await safeModelErrorResponse(new Response(broken, { status: 401 }), options)).json();
  assert.equal(JSON.stringify(failed).includes(dummy), false);
  assert.match(failed.error.message, /Check your sign-in/);
  const locked = failure({ message: dummy });
  const lock = locked.body.getReader();
  const fallback = await (await safeModelErrorResponse(locked, options)).json();
  assert.match(fallback.error.message, /Check your sign-in/);
  await lock.cancel();
  let cancelled = false;
  const started = Promise.withResolvers();
  const waiting = new ReadableStream({ pull() { started.resolve(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const controller = new AbortController();
  const pending = safeModelErrorResponse(new Response(waiting, { status: 401 }), { ...options, init: { ...options.init, signal: controller.signal } });
  await started.promise;
  controller.abort(new Error(dummy));
  assert.match((await (await pending).json()).error.message, /Check your sign-in/);
  assert.equal(cancelled, true);
  // Leave one turn for an abandoned reader rejection or abort race to surface.
  await new Promise(resolve => setImmediate(resolve));
});

test('successful streaming responses are returned untouched', async () => {
  let pulled = false;
  const response = new Response(new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await safeModelErrorResponse(response, options), response);
  assert.equal(pulled, false);
  assert.equal(response.bodyUsed, false);
  await response.body.cancel();
});
