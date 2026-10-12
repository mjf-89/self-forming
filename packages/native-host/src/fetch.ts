import type { NativeBridge } from './bridge.ts';
import { base64ToBytes, bytesToBase64, isRecord } from './wire.ts';

/** Native sockets, exposed as Fetch without replacing the browser's globals. */
export type NativeFetchHost = Pick<NativeBridge, 'call'> & Partial<Pick<NativeBridge, 'closed' | 'onClose'>>;
const CHUNK_BYTES = 64 * 1024;
const ENCODED_CHUNK_BYTES = Math.ceil(CHUNK_BYTES / 3) * 4;
const MANAGED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade',
  'expect', 'trailer', 'te', 'origin', 'referer', 'cookie', 'cookie2', 'accept-encoding', 'anthropic-dangerous-direct-browser-access']);
const aborted = () => new DOMException('The request was aborted.', 'AbortError');
const protocolError = () => new TypeError('Invalid HTTP response from native host.');

function responseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url });
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'clone', { value: () => responseUrl(clone(), url) });
  return response;
}

export function createNativeFetch(host: NativeFetchHost): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted) throw request.signal.reason ?? aborted();
    if (host.closed) throw new TypeError('Native bridge is closed.');
    if (new URL(request.url).protocol !== 'https:') throw new TypeError('Native HTTP requires HTTPS.');
    const requestId = crypto.randomUUID();
    let active = true, reserved = false, cancelled = false;
    let failure: unknown;
    let upload: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let unsubscribe = () => {};
    const waiters = new Set<(reason: unknown) => void>();
    const cancelNative = () => {
      if (!reserved || cancelled) return;
      cancelled = true;
      try { void host.call('http.cancel', { requestId }).catch(() => {}); } catch { /* Host already gone. */ }
    };
    const cleanup = () => {
      request.signal.removeEventListener('abort', onAbort);
      unsubscribe();
    };
    const finish = () => { if (active) { active = false; cleanup(); } };
    const stop = (reason: unknown, errorBody = true) => {
      if (!active) return;
      failure = reason;
      active = false;
      cleanup();
      for (const reject of waiters) reject(reason);
      waiters.clear();
      if (upload) void upload.cancel(reason).catch(() => {});
      cancelNative();
      if (errorBody && body) { try { body.error(reason); } catch { /* Already closed. */ } }
    };
    const onAbort = () => stop(request.signal.reason ?? aborted());
    request.signal.addEventListener('abort', onAbort, { once: true });
    unsubscribe = host.onClose?.(error => stop(error)) ?? (() => {});
    if (!active) unsubscribe(); // onClose may notify synchronously.
    // Remove each waiter when its operation settles. Repeated Promise.race calls
    // against one never-settled abort promise would retain every streamed chunk.
    const wait = <T>(operation: Promise<T>): Promise<T> => {
      if (!active) { void operation.catch(() => {}); return Promise.reject(failure ?? aborted()); }
      return new Promise<T>((resolve, reject) => {
        waiters.add(reject);
        void operation.then(value => { waiters.delete(reject); resolve(value); }, error => { waiters.delete(reject); reject(error); });
      });
    };
    const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (!active) return Promise.reject(failure ?? aborted());
      return wait(host.call<T>(method, { requestId, ...params }));
    };
    try {
      if (!active) throw failure;
      const headers = [...request.headers].filter(([name]) => !MANAGED_HEADERS.has(name)
        && !name.startsWith('proxy-') && !name.startsWith('sec-'));
      reserved = true;
      await call('http.open', { url: request.url, method: request.method, headers, hasBody: request.body !== null });
      if (request.body) {
        upload = request.body.getReader();
        try {
          while (true) {
            const chunk = await wait(upload.read());
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array)) throw new TypeError('Request body must contain bytes.');
            for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK_BYTES) {
              await call('http.write', { data: bytesToBase64(chunk.value.subarray(offset, offset + CHUNK_BYTES)) });
            }
          }
        } finally { upload.releaseLock(); upload = undefined; }
      }
      const head = await call('http.send');
      if (!isRecord(head) || !Number.isInteger(head.status) || (head.status as number) < 200 || (head.status as number) > 599
        || typeof head.statusText !== 'string' || typeof head.url !== 'string' || head.url !== request.url
        || !Array.isArray(head.headers) || !head.headers.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === 'string'))) {
        throw protocolError();
      }
      // The native host never follows redirects outside its endpoint policy.
      if ([301, 302, 303, 307, 308].includes(head.status as number)) throw new TypeError('Native HTTP redirects are not supported.');
      let responseHeaders: Headers;
      try { responseHeaders = new Headers(head.headers as [string, string][]); }
      catch { throw protocolError(); }
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(head.status as number);
      const stream = noBody ? null : new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
        async pull(controller) {
          try {
            const chunk = await call('http.read');
            if (!isRecord(chunk) || typeof chunk.data !== 'string' || typeof chunk.done !== 'boolean'
              || chunk.data.length > ENCODED_CHUNK_BYTES) throw protocolError();
            let bytes: Uint8Array;
            try { bytes = base64ToBytes(chunk.data); } catch { throw protocolError(); }
            if (bytes.byteLength > CHUNK_BYTES || (!chunk.done && bytes.byteLength === 0)) throw protocolError();
            if (bytes.byteLength) controller.enqueue(bytes);
            if (chunk.done) { finish(); controller.close(); }
          } catch (error) { stop(error); throw error; }
        },
        cancel(reason) { stop(reason ?? aborted(), false); },
      }, { highWaterMark: 0 });
      let response: Response;
      try { response = new Response(stream, { status: head.status as number, statusText: head.statusText, headers: responseHeaders }); }
      catch { throw protocolError(); }
      if (noBody) { cancelNative(); finish(); }
      return responseUrl(response, head.url);
    } catch (error) { stop(error); throw error; }
  };
}
