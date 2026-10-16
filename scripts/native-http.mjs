// Development-only counterpart of Android's disk-backed, pull-based HTTP host.
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

const CHUNK = 64 * 1024;
const endpoints = new Map([
  ['https://auth.openai.com/.well-known/openid-configuration', 'GET'],
  ['https://auth.openai.com/.well-known/jwks.json', 'GET'],
  ['https://auth.openai.com/api/accounts/oauth/token', 'POST'],
  ['https://auth.openai.com/api/accounts/oauth/revoke', 'POST'],
  ['https://platform.claude.com/v1/oauth/token', 'POST'],
  ['https://api.openai.com/v1/models', 'GET'],
  ['https://api.openai.com/v1/responses', 'POST'],
  ['https://api.anthropic.com/v1/models', 'GET'],
  ['https://api.anthropic.com/v1/messages', 'POST'],
]);
const managed = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'expect',
  'trailer', 'te', 'origin', 'referer', 'cookie', 'cookie2', 'accept-encoding', 'anthropic-dangerous-direct-browser-access']);
const failure = (message, code = 'HTTP_ERROR') => Object.assign(new Error(message), { code });
const cancelled = () => failure('HTTP request cancelled.', 'ABORTED');

function validate({ url: value, method, headers, hasBody }) {
  let url;
  try { url = new URL(value); } catch { throw failure('Unsupported HTTP endpoint.', 'URL_DENIED'); }
  const expected = endpoints.get(url.origin + url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !expected || expected !== method
    || (url.search && !['api.openai.com', 'api.anthropic.com'].includes(url.hostname)))
    throw failure('Unsupported HTTP endpoint or method.', 'URL_DENIED');
  if (typeof hasBody !== 'boolean' || (hasBody && method === 'GET')) throw failure('Invalid HTTP body declaration.', 'INVALID_REQUEST');
  if (!Array.isArray(headers)) throw failure('Invalid HTTP headers.', 'INVALID_REQUEST');
  const accepted = new Headers();
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string'))
      throw failure('Invalid HTTP header.', 'INVALID_REQUEST');
    const [name, value] = pair;
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value) || managed.has(lower)
      || lower.startsWith('sec-') || lower.startsWith('proxy-')) throw failure('Unsupported HTTP header.', 'INVALID_REQUEST');
    try { accepted.append(name, value); } catch { throw failure('Invalid HTTP header.', 'INVALID_REQUEST'); }
  }
  return { url: url.href, method, headers: accepted, hasBody };
}

/** No total byte limit: uploads live on disk; each response read follows one bridge pull. */
export function createNativeHttp(transport = globalThis.fetch, { temporaryDirectory = tmpdir() } = {}) {
  const requests = new Map();
  let closed = false;
  async function dispose(state) {
    if (state.disposal) return state.disposal;
    state.disposal = (async () => {
      state.controller.abort();
      void state.reader?.cancel().catch(() => {});
      // Finish only local file IO, never await a hung upstream transport/read.
      await state.io?.catch(() => {});
      state.upload?.destroy();
      await state.uploadClosed;
      if (state.directory) await rm(state.directory, { recursive: true, force: true });
    })();
    return state.disposal;
  }
  async function operation(params, action) {
    const state = requests.get(params.requestId);
    if (!state) throw failure('HTTP request is not active.', 'HTTP_STATE');
    if (state.busy) throw failure('Another HTTP operation is in progress.', 'HTTP_BUSY');
    state.busy = true;
    try {
      if (state.controller.signal.aborted) throw cancelled();
      const value = await action(state);
      if (state.controller.signal.aborted) throw cancelled();
      return value;
    } catch (error) {
      if (requests.get(params.requestId) === state) requests.delete(params.requestId);
      const aborted = state.controller.signal.aborted;
      await dispose(state);
      if (aborted) throw cancelled();
      if (error?.code && ['INVALID_REQUEST', 'HTTP_STATE', 'HTTP_REDIRECT', 'HTTP_TOO_LARGE'].includes(error.code)) throw error;
      throw failure('HTTP request could not connect or continue.', 'HTTP_NETWORK');
    } finally { state.busy = false; }
  }
  return {
    async call(method, params = {}) {
      if (closed) throw cancelled();
      if (method === 'http.open') {
        const id = params.requestId;
        if (typeof id !== 'string' || !id.length || id.length > 160) throw failure('Invalid HTTP request identifier.', 'INVALID_REQUEST');
        if (requests.has(id)) throw failure('HTTP request identifier is already active.', 'DUPLICATE_ID');
        if (requests.size >= 8) throw failure('Too many active HTTP requests.', 'HTTP_BUSY');
        const state = { ...validate(params), controller: new AbortController(), phase: 'open', busy: true };
        requests.set(id, state);
        try {
          if (state.hasBody) {
            state.io = (async () => {
              state.directory = await mkdtemp(join(temporaryDirectory, 'self-forming-http-'));
              state.path = join(state.directory, 'upload');
              await writeFile(state.path, '', { mode: 0o600, flag: 'wx' });
            })();
            await state.io;
          }
          if (state.controller.signal.aborted || closed) throw cancelled();
          return null;
        } catch (error) { if (requests.get(id) === state) requests.delete(id); await dispose(state); throw error?.code === 'ABORTED' ? error : failure('Could not create HTTP upload.', 'HTTP_IO'); }
        finally { state.busy = false; }
      }
      if (method === 'http.cancel') {
        const state = requests.get(params.requestId);
        if (state) {
          requests.delete(params.requestId);
          state.controller.abort();
          await dispose(state);
        }
        return null;
      }
      if (method === 'http.write') return operation(params, async state => {
        if (state.phase !== 'open' || !state.hasBody) throw failure('HTTP request cannot accept body data.', 'HTTP_STATE');
        const data = params.data;
        if (typeof data !== 'string' || data.length > Math.ceil(CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
          throw failure('Invalid HTTP upload chunk.', 'INVALID_REQUEST');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > CHUNK) throw failure('HTTP chunks are limited to 64 KiB.', 'HTTP_TOO_LARGE');
        state.io = appendFile(state.path, bytes);
        await state.io;
        return null;
      });
      if (method === 'http.send') return operation(params, async state => {
        if (state.phase !== 'open') throw failure('HTTP request was already sent.', 'HTTP_STATE');
        state.phase = 'sending';
        const headers = new Headers(state.headers);
        headers.set('accept-encoding', 'identity');
        if (state.hasBody) {
          const size = (await stat(state.path)).size;
          if (state.controller.signal.aborted) throw cancelled();
          headers.set('content-length', String(size));
          state.upload = createReadStream(state.path, { highWaterMark: CHUNK });
          state.uploadClosed = finished(state.upload).catch(() => {});
        }
        const response = await transport(state.url, { method: state.method, headers, redirect: 'manual',
          signal: state.controller.signal, ...(state.hasBody ? { body: state.upload, duplex: 'half' } : {}) });
        if (state.controller.signal.aborted) { await response.body?.cancel().catch(() => {}); throw cancelled(); }
        state.reader = response.body?.getReader();
        if (response.status >= 300 && response.status < 400 && response.status !== 304) throw failure('HTTP redirects are not supported.', 'HTTP_REDIRECT');
        state.phase = 'reading';
        const responseHeaders = new Headers(response.headers);
        // Node fetch has already decoded content encodings, even if a server ignored identity.
        responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
        responseHeaders.delete('set-cookie'); responseHeaders.delete('set-cookie2');
        return { status: response.status, statusText: response.statusText, headers: [...responseHeaders], url: response.url || state.url };
      });
      if (method === 'http.read') return operation(params, async state => {
        if (state.phase !== 'reading') throw failure('HTTP response is not ready.', 'HTTP_STATE');
        let bytes = state.remainder;
        while (!bytes?.length) {
          if (state.controller.signal.aborted) throw cancelled();
          const result = await state.reader?.read();
          if (!result || result.done) {
            if (requests.get(params.requestId) === state) requests.delete(params.requestId);
            // Successful completion should not be reported as cancellation by operation().
            state.reader = undefined;
            state.upload?.destroy(); await state.uploadClosed;
            if (state.directory) { await rm(state.directory, { recursive: true, force: true }); state.directory = undefined; }
            return { data: '', done: true };
          }
          bytes = result.value;
        }
        state.remainder = bytes.subarray(CHUNK);
        return { data: Buffer.from(bytes.subarray(0, CHUNK)).toString('base64'), done: false };
      });
      throw failure('Unknown HTTP operation.', 'METHOD_NOT_FOUND');
    },
    async close() {
      closed = true;
      const pending = [...requests.values()]; requests.clear();
      for (const state of pending) { state.controller.abort(); state.upload?.destroy(); void state.reader?.cancel().catch(() => {}); }
      await Promise.all(pending.map(dispose));
    },
  };
}
