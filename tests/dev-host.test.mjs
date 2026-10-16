import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest, createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serve } from '../scripts/serve.mjs';

const STATE = 'self_forming_state_'.repeat(4);
const deniedNetwork = async () => { throw new Error('Unexpected external request in dev-host test'); };
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, options = {}) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'self-forming-dev-'));
  const assets = join(directory, 'assets');
  const authDirectory = join(directory, 'auth');
  await mkdir(assets);
  await writeFile(join(assets, 'index.html'), '<!doctype html><title>Test app</title>');
  const hosts = [];
  async function start(extra = {}) {
    const host = await serve(assets, 0, {}, { auth: { directory: authDirectory, fetch: deniedNetwork, ...options, ...extra } });
    hosts.push(host);
    return host;
  }
  t.after(async () => {
    for (const host of hosts) if (host.server.listening) await host.close();
    // Only remove the exact mkdtemp-created directory directly within the selected temporary root.
    assert.equal(dirname(resolve(directory)), tempRoot);
    assert.ok(directory.startsWith(join(tempRoot, 'self-forming-dev-')));
    await rm(directory, { recursive: true, force: true });
  });
  return { host: await start(), start, directory, assets, authDirectory };
}

async function post(host, path, value, overrides = {}) {
  const headers = { origin: host.url, 'content-type': 'application/json', 'x-self-forming': '1', ...overrides.headers };
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
  return fetch(`${host.url}${path}`, { method: overrides.method ?? 'POST', headers,
    ...(overrides.method === 'GET' ? {} : { body: JSON.stringify(value) }), signal: overrides.signal });
}

async function auth(host, method, params = {}) {
  const response = await post(host, '/__pi/auth', { method, params });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code, status: response.status });
  return body.result;
}

function rawRequest(url, options = {}) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

function authorizationUrl(attempt, parameters = {}) {
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  url.searchParams.set('state', STATE);
  url.searchParams.set('redirect_uri', attempt.redirectUri);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

async function assertPortReleased(uri) {
  const server = createServer();
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(Number(new URL(uri).port), '127.0.0.1', done);
    });
  } finally { if (server.listening) await new Promise((done) => server.close(done)); }
}

test('development host keeps a stable host UUID and never persists credentials between host instances', { timeout: 10000 }, async (t) => {
  const { host, start, authDirectory } = await fixture(t);
  const info = await auth(host, 'auth.info');
  assert.match(info.hostId, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(info.storage, 'memory');
  assert.equal(await auth(host, 'auth.load'), null);
  const record = { accessToken: 'secret-only-in-test-memory', refreshToken: 'refresh-never-on-disk', clientId: 'test-client' };
  await auth(host, 'auth.save', { record });
  assert.deepEqual(await auth(host, 'auth.load'), record);
  assert.deepEqual(await readdir(authDirectory), ['host-id']);
  const persisted = await readFile(join(authDirectory, 'host-id'), 'utf8');
  assert.equal(persisted, info.hostId);
  assert.ok(!persisted.includes(record.accessToken));
  await assert.rejects(auth(host, 'auth.save', { record: { tooLarge: 'x'.repeat(65536) } }), /credential record/);
  assert.deepEqual(await auth(host, 'auth.load'), record);
  await auth(host, 'auth.clear');
  assert.equal(await auth(host, 'auth.load'), null);
  assert.equal((await auth(host, 'auth.info')).hostId, info.hostId);
  await auth(host, 'auth.save', { record });
  await host.close();
  const restarted = await start();
  assert.equal((await auth(restarted, 'auth.info')).hostId, info.hostId);
  assert.equal(await auth(restarted, 'auth.load'), null);
  assert.deepEqual(await readdir(authDirectory), ['host-id']);
});

test('development routes require the exact loopback Host, Origin, JSON type and custom header', { timeout: 10000 }, async (t) => {
  let upstream = 0;
  const { host } = await fixture(t, { fetch: async () => { upstream++; return new Response('{}'); } });
  for (const path of ['/__pi/auth', '/__pi/fetch']) {
    for (const headers of [
      { origin: undefined }, { origin: 'https://attacker.invalid' }, { 'x-self-forming': undefined },
      { 'x-self-forming': '0' }, { 'content-type': 'text/plain' },
    ]) {
      const response = await post(host, path, { method: 'auth.info' }, { headers });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'ORIGIN_DENIED');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    const wrongHost = await rawRequest(`${host.url}${path}`, { method: 'POST', headers: {
      host: 'attacker.invalid', origin: host.url, 'x-self-forming': '1', 'content-type': 'application/json',
    }, body: JSON.stringify({ method: 'auth.info' }) });
    assert.equal(wrongHost.status, 403);
    const wrongMethod = await post(host, path, null, { method: 'GET' });
    assert.equal(wrongMethod.status, 403);
    await wrongMethod.arrayBuffer();
  }
  assert.equal(upstream, 0);
  assert.match(await (await fetch(host.url)).text(), /Test app/);
});

test('invalid callback paths, hosts, states and error states leave auth.wait pending; valid callback completes without reflecting secrets', { timeout: 10000 }, async (t) => {
  const { host } = await fixture(t);
  const attempt = await auth(host, 'auth.listen', { state: STATE });
  assert.match(attempt.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  await assert.rejects(auth(host, 'auth.listen', { state: STATE }), (error) => error.code === 'AUTH_BUSY');
  let settled = false;
  const pending = auth(host, 'auth.wait', { attemptId: attempt.attemptId }).then((value) => { settled = true; return value; });
  const invalidUrls = [
    `${attempt.redirectUri}?code=hidden-code&state=wrong`,
    `${attempt.redirectUri}?error=access_denied&state=wrong`,
    `${attempt.redirectUri}?error=access_denied`,
    `${attempt.redirectUri}?state=${STATE}&state=${STATE}&code=hidden-code`,
    `${attempt.redirectUri.replace('/auth/callback', '/wrong')}?code=hidden-code&state=${STATE}`,
  ];
  for (const url of invalidUrls) {
    const response = await fetch(url);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.equal(html.includes('hidden-code'), false);
    assert.equal(html.includes(STATE), false);
  }
  const invalidHost = await rawRequest(`${attempt.redirectUri}?code=hidden-code&state=${STATE}`, { headers: { host: 'attacker.invalid' } });
  assert.equal(invalidHost.status, 400);
  const invalidMethod = await fetch(`${attempt.redirectUri}?code=hidden-code&state=${STATE}`, { method: 'POST' });
  assert.equal(invalidMethod.status, 400);
  await invalidMethod.text();
  await wait(30);
  assert.equal(settled, false);
  const returnedUrl = `${attempt.redirectUri}?code=hidden-code&state=${STATE}`;
  const valid = await fetch(returnedUrl);
  assert.equal(valid.status, 200);
  const html = await valid.text();
  assert.equal(html.includes('hidden-code'), false);
  assert.equal(html.includes(STATE), false);
  assert.deepEqual(await pending, { url: returnedUrl });
  await auth(host, 'auth.cancel', { attemptId: attempt.attemptId });
  await assertPortReleased(attempt.redirectUri);
});

test('callback cancellation and timeout reject pending waits and release the listening port', { timeout: 10000 }, async (t) => {
  const { host } = await fixture(t, { timeoutMs: 500 });
  const first = await auth(host, 'auth.listen', { state: STATE });
  const cancelled = assert.rejects(auth(host, 'auth.wait', { attemptId: first.attemptId }), (error) => error.code === 'ABORTED');
  await auth(host, 'auth.cancel', { attemptId: first.attemptId });
  await cancelled;
  await assertPortReleased(first.redirectUri);
  const second = await auth(host, 'auth.listen', { state: STATE });
  await assert.rejects(auth(host, 'auth.wait', { attemptId: second.attemptId }), (error) => error.code === 'AUTH_TIMEOUT');
  await assertPortReleased(second.redirectUri);
});

test('auth.open permits only the bound authorization endpoint, redirect and state; valid OAuth errors still complete the callback', { timeout: 10000 }, async (t) => {
  const { host } = await fixture(t);
  const attempt = await auth(host, 'auth.listen', { state: STATE });
  const valid = authorizationUrl(attempt);
  const invalid = [
    valid.href.replace('https://auth.openai.com', 'https://attacker.invalid'),
    valid.href.replace('https://', 'http://'),
    valid.href.replace('/api/accounts/authorize', '/other'),
    `${valid.href}#fragment`, `${valid.href}&state=${STATE}`,
    authorizationUrl(attempt, { state: 'wrong-state' }).href,
    authorizationUrl(attempt, { redirect_uri: 'http://127.0.0.1:1/auth/callback' }).href,
  ];
  for (const url of invalid) await assert.rejects(auth(host, 'auth.open', { attemptId: attempt.attemptId, url }), /denied/);
  assert.equal(await auth(host, 'auth.open', { attemptId: attempt.attemptId, url: valid.href }), null);
  const pending = auth(host, 'auth.wait', { attemptId: attempt.attemptId });
  const returnedUrl = `${attempt.redirectUri}?error=access_denied&state=${STATE}`;
  const callback = await fetch(returnedUrl);
  assert.equal(callback.status, 200);
  await callback.text();
  assert.deepEqual(await pending, { url: returnedUrl });
  await auth(host, 'auth.cancel', { attemptId: attempt.attemptId });
});

test('development auth and model HTTP share the native streaming protocol through the guarded RPC route', { timeout: 10000 }, async (t) => {
  const upstream = [];
  const { host } = await fixture(t, { fetch: async (url, init) => {
    upstream.push({ url, init, body: init.body ? await new Response(init.body).text() : undefined });
    return Response.json({ access_token: 'dummy-token' });
  } });
  for (const url of ['https://attacker.invalid', 'https://api.openai.com/v1/files', 'https://api.openai.com.evil.test/v1/models']) {
    await assert.rejects(auth(host, 'http.open', { url, requestId: crypto.randomUUID(), method: 'GET', headers: [], hasBody: false }), /endpoint/);
  }
  await assert.rejects(auth(host, 'auth.request', {}), /Unknown authentication operation/);
  const removed = await post(host, '/__pi/fetch', { url: 'https://api.openai.com/v1/responses', method: 'POST' });
  assert.equal(removed.status, 404); assert.equal(upstream.length, 0);
  const requestId = crypto.randomUUID();
  await auth(host, 'http.open', { requestId, url: 'https://platform.claude.com/v1/oauth/token', method: 'POST',
    headers: [['content-type', 'application/json']], hasBody: true });
  await auth(host, 'http.write', { requestId, data: Buffer.from('{"code":"dummy"}').toString('base64') });
  const reply = await auth(host, 'http.send', { requestId });
  assert.equal(reply.status, 200);
  const read = await auth(host, 'http.read', { requestId });
  assert.deepEqual(JSON.parse(Buffer.from(read.data, 'base64').toString()), { access_token: 'dummy-token' });
  assert.equal((await auth(host, 'http.read', { requestId })).done, true);
  assert.equal(upstream[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(upstream[0].init.redirect, 'manual');
  assert.equal(upstream[0].init.headers.get('content-type'), 'application/json');
  assert.equal(upstream[0].body, '{"code":"dummy"}');
  await auth(host, 'http.open', { requestId, url: 'https://api.openai.com/v1/models', method: 'GET', headers: [], hasBody: false });
  await auth(host, 'http.send', { requestId });
  assert.equal(upstream[1].init.method, 'GET');
  await auth(host, 'http.cancel', { requestId });
  assert.equal(upstream.length, 2);
});

test('development streaming HTTP refuses redirects and cancellation settles pending network work', { timeout: 10000 }, async (t) => {
  let requests = 0; let redirectCancelled = false;
  const started = deferred(); const aborted = deferred();
  const { host } = await fixture(t, { fetch: async (_url, init) => {
    requests++;
    if (requests === 1) return new Response(new ReadableStream({ cancel() { redirectCancelled = true; } }), { status: 302, headers: { location: 'https://attacker.invalid' } });
    started.resolve();
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted.resolve(); reject(new DOMException('dummy-secret', 'AbortError'));
    }, { once: true }));
  } });
  const params = { requestId: crypto.randomUUID(), url: 'https://auth.openai.com/.well-known/openid-configuration',
    method: 'GET', headers: [], hasBody: false };
  await auth(host, 'http.open', params);
  await assert.rejects(auth(host, 'http.send', params), /redirects/); assert.equal(redirectCancelled, true);
  await auth(host, 'http.open', params);
  const pending = assert.rejects(auth(host, 'http.send', params), error => error.code === 'ABORTED' && !error.message.includes('dummy-secret'));
  await started.promise; await auth(host, 'http.cancel', { requestId: params.requestId });
  await pending; await aborted.promise;
});

test('Claude credentials are provider-scoped and its external browser URL is validated', { timeout: 10000 }, async (t) => {
  const { host } = await fixture(t);
  await auth(host, 'auth.save', { record: { dummy: 'chatgpt' } });
  await auth(host, 'auth.save', { provider: 'claude', record: { dummy: 'claude' } });
  assert.deepEqual(await auth(host, 'auth.load'), { dummy: 'chatgpt' });
  assert.deepEqual(await auth(host, 'auth.load', { provider: 'claude' }), { dummy: 'claude' });
  await auth(host, 'auth.clear', { provider: 'claude' });
  assert.deepEqual(await auth(host, 'auth.load'), { dummy: 'chatgpt' });
  await assert.rejects(auth(host, 'auth.load', { provider: 'other' }), /provider/);
  const url = new URL('https://claude.ai/oauth/authorize');
  url.search = new URLSearchParams({ code: 'true', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', response_type: 'code',
    redirect_uri: 'https://platform.claude.com/oauth/code/callback', code_challenge_method: 'S256', state: 'a'.repeat(43), code_challenge: 'b'.repeat(43),
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload' }).toString();
  assert.equal(await auth(host, 'auth.openExternal', { provider: 'claude', url: url.href }), null);
  for (const invalid of [url.href.replace('https://claude.ai', 'https://attacker.invalid'), url.href + '&state=other', url.href + '#fragment']) {
    await assert.rejects(auth(host, 'auth.openExternal', { provider: 'claude', url: invalid }), /denied/);
  }
});

test('the ordinary static server does not expose authentication or network proxy routes', { timeout: 10000 }, async (t) => {
  const { assets } = await fixture(t);
  const staticHost = await serve(assets, 0);
  t.after(() => staticHost.close());
  for (const path of ['/__pi/auth', '/__pi/fetch']) {
    const response = await post(staticHost, path, { method: 'auth.info' });
    assert.equal(response.status, 404);
    await response.text();
  }
});
