// Development host only. This file is never imported by the browser build or Android APK.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateClaudeAuthorization } from './auth-request.mjs';
import { createNativeHttp } from './native-http.mjs';

const MAX_JSON = 4 * 1024 * 1024;

function failure(message, code = 'AUTH_ERROR') { return Object.assign(new Error(message), { code }); }
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request, limit = MAX_JSON) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw failure('Request exceeds the development host limit.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('Invalid request.', 'INVALID_REQUEST'); }
}
async function installationId(directory) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'host-id');
  try { await writeFile(path, `urn:uuid:${randomUUID()}`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const id = (await readFile(path, 'utf8')).trim();
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw failure('Invalid saved host identifier.');
  return id;
}

/** Only the development entry point opts into this loopback host. Credentials remain in process memory. */
export async function createDevHost({ directory = resolve('.local'), fetch: transport = globalThis.fetch, timeoutMs = 300_000 } = {}) {
  const hostId = await installationId(directory);
  const records = new Map();
  let active;
  const requests = createNativeHttp(transport);

  function cancel(attemptId) {
    if (!active || active.id !== attemptId) return;
    clearTimeout(active.timer);
    active.reject(failure('Sign-in cancelled.', 'ABORTED'));
    active.server.close(); active.server.closeAllConnections();
    active = undefined;
  }
  async function listen(state) {
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) throw failure('Invalid sign-in state.');
    if (active) throw failure('A sign-in is already running. Cancel it first.', 'AUTH_BUSY');
    const attempt = { id: randomUUID(), state, redirectUri: '', server: undefined, timer: undefined, resolve: undefined, reject: undefined, result: undefined };
    attempt.result = new Promise((resolveResult, rejectResult) => { attempt.resolve = resolveResult; attempt.reject = rejectResult; });
    void attempt.result.catch(() => {});
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
      let valid = false; let url;
      try {
        url = new URL(request.url, attempt.redirectUri);
        valid = request.method === 'GET' && request.headers.host === new URL(attempt.redirectUri).host &&
          url.origin === new URL(attempt.redirectUri).origin && url.pathname === '/auth/callback' &&
          url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state &&
          (url.searchParams.has('code') || url.searchParams.has('error'));
      } catch { }
      response.writeHead(valid ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
      response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Self Forming sign-in</title><main style="font:18px system-ui;margin:3rem;max-width:35rem"><h1>Self Forming</h1><p>${valid ? 'Sign-in returned. Go back to Self Forming to finish connecting.' : 'This sign-in callback did not match. Return to Self Forming and try again.'}</p></main>`);
      if (valid) {
        clearTimeout(attempt.timer);
        attempt.resolve({ url: url.href });
        response.once('finish', () => { server.close(); server.closeAllConnections(); });
      }
    });
    attempt.server = server;
    server.maxRequestsPerSocket = 1;
    // Reserve before binding so concurrent button presses cannot create multiple listeners.
    active = attempt;
    try {
      await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      attempt.timer = setTimeout(() => {
        attempt.reject(failure('Sign-in timed out. Please try again.', 'AUTH_TIMEOUT'));
        server.close(); server.closeAllConnections();
        if (active === attempt) active = undefined;
      }, timeoutMs);
      attempt.timer.unref();
      return { attemptId: attempt.id, redirectUri: attempt.redirectUri };
    } catch { cancel(attempt.id); throw failure('Could not start the local sign-in callback.'); }
  }
  function attemptFor(id) {
    if (!active || active.id !== id) throw failure('This sign-in attempt has expired.', 'AUTH_EXPIRED');
    return active;
  }
  async function call(method, params = {}) {
    if (method.startsWith('http.')) return requests.call(method, params);
    const provider = params.provider ?? 'chatgpt';
    if (!['chatgpt', 'claude'].includes(provider)) throw failure('Unsupported authentication provider.');
    if (method === 'auth.info') return { hostId, storage: 'memory' };
    if (method === 'auth.load') return structuredClone(records.get(provider) ?? null);
    if (method === 'auth.save') {
      if (!params.record || typeof params.record !== 'object' || Array.isArray(params.record) || Buffer.byteLength(JSON.stringify(params.record)) > 65536) throw failure('Invalid credential record.');
      records.set(provider, structuredClone(params.record)); return null;
    }
    if (method === 'auth.clear') { records.delete(provider); return null; }
    if (method === 'auth.openExternal') {
      if (provider !== 'claude') throw failure('Unsupported external sign-in provider.');
      validateClaudeAuthorization(params.url);
      return null;
    }
    if (provider !== 'chatgpt') throw failure('Unsupported Claude sign-in operation.');
    if (method === 'auth.listen') return listen(params.state);
    if (method === 'auth.cancel') { cancel(params.attemptId); return null; }
    if (method === 'auth.wait') return attemptFor(params.attemptId).result;
    if (method === 'auth.open') {
      const attempt = attemptFor(params.attemptId);
      let url;
      try { url = new URL(params.url); } catch { throw failure('Invalid sign-in URL.'); }
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash ||
        url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== attempt.state ||
        url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== attempt.redirectUri) throw failure('Sign-in URL was denied.');
      // The page opens its prepared browser window. This server never launches a process.
      return null;
    }
    throw failure('Unknown authentication operation.', 'METHOD_NOT_FOUND');
  }
  return {
    async handle(request, response, origin) {
      const path = new URL(request.url, origin).pathname;
      if (!path.startsWith('/__pi/')) return false;
      // Exact loopback Host + Origin and non-simple header prevent DNS rebinding and browser CSRF.
      if (request.method !== 'POST' || request.headers.host !== new URL(origin).host || request.headers.origin !== origin ||
        request.headers['x-self-forming'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) {
        json(response, 403, { ok: false, error: { code: 'ORIGIN_DENIED', message: 'Development requests must come from this app.' } }); return true;
      }
      try {
        const input = await body(request);
        if (path === '/__pi/auth') json(response, 200, { ok: true, result: await call(input.method, input.params) });
        else json(response, 404, { ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Unknown development operation.' } });
      } catch (error) {
        json(response, 400, { ok: false, error: { code: error.code ?? 'AUTH_ERROR', message: error.code ? error.message : 'The development operation failed.' } });
      }
      return true;
    },
    async close() { if (active) cancel(active.id); await requests.close(); records.clear(); },
  };
}
