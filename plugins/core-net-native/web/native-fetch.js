// core-net-native implementation (step X4): packages/native-host/src/fetch.ts (createNativeFetch)
// hand-ported to plain JS. Native sockets exposed as Fetch without replacing the browser's
// globals. Same bridge methods (http.open/write/send/read/cancel), limits, header filter,
// redirect and error behaviour as the compiled module (tests/plugin-x4-net.test.mjs).
// The three wire helpers (base64 both ways, isRecord) are not exported by the fixed
// native-host.js and are copied here.
const CHUNK_BYTES = 64 * 1024;
const ENCODED_CHUNK_BYTES = Math.ceil(CHUNK_BYTES / 3) * 4;
const MANAGED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade",
  "expect", "trailer", "te", "origin", "referer", "cookie", "cookie2", "accept-encoding", "anthropic-dangerous-direct-browser-access"]);
const aborted = () => new DOMException("The request was aborted.", "AbortError");
const protocolError = () => new TypeError("Invalid HTTP response from native host.");

function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}
function base64ToBytes(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid base64 payload from native host");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function responseUrl(response, url) {
  Object.defineProperty(response, "url", { value: url });
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "clone", { value: () => responseUrl(clone(), url) });
  return response;
}

/** host: {call, closed?, onClose?} (a native bridge). Returns a fetch over native HTTPS. */
export function createNativeFetch(host) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted) throw request.signal.reason ?? aborted();
    if (host.closed) throw new TypeError("Native bridge is closed.");
    if (new URL(request.url).protocol !== "https:") throw new TypeError("Native HTTP requires HTTPS.");
    const requestId = crypto.randomUUID();
    let active = true, reserved = false, cancelled = false;
    let failure;
    let upload;
    let body;
    let unsubscribe = () => {};
    const waiters = new Set();
    const cancelNative = () => {
      if (!reserved || cancelled) return;
      cancelled = true;
      try { void host.call("http.cancel", { requestId }).catch(() => {}); } catch { /* Host already gone. */ }
    };
    const cleanup = () => {
      request.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    };
    const finish = () => { if (active) { active = false; cleanup(); } };
    const stop = (reason, errorBody = true) => {
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
    request.signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = host.onClose?.((error) => stop(error)) ?? (() => {});
    if (!active) unsubscribe(); // onClose may notify synchronously.
    // Remove each waiter when its operation settles. Repeated Promise.race calls
    // against one never-settled abort promise would retain every streamed chunk.
    const wait = (operation) => {
      if (!active) { void operation.catch(() => {}); return Promise.reject(failure ?? aborted()); }
      return new Promise((resolve, reject) => {
        waiters.add(reject);
        void operation.then((value) => { waiters.delete(reject); resolve(value); }, (error) => { waiters.delete(reject); reject(error); });
      });
    };
    const call = (method, params = {}) => {
      if (!active) return Promise.reject(failure ?? aborted());
      return wait(host.call(method, { requestId, ...params }));
    };
    try {
      if (!active) throw failure;
      const headers = [...request.headers].filter(([name]) => !MANAGED_HEADERS.has(name)
        && !name.startsWith("proxy-") && !name.startsWith("sec-"));
      reserved = true;
      await call("http.open", { url: request.url, method: request.method, headers, hasBody: request.body !== null });
      if (request.body) {
        upload = request.body.getReader();
        try {
          while (true) {
            const chunk = await wait(upload.read());
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array)) throw new TypeError("Request body must contain bytes.");
            for (let offset = 0; offset < chunk.value.byteLength; offset += CHUNK_BYTES) {
              await call("http.write", { data: bytesToBase64(chunk.value.subarray(offset, offset + CHUNK_BYTES)) });
            }
          }
        } finally { upload.releaseLock(); upload = undefined; }
      }
      const head = await call("http.send");
      if (!isRecord(head) || !Number.isInteger(head.status) || head.status < 200 || head.status > 599
        || typeof head.statusText !== "string" || typeof head.url !== "string" || head.url !== request.url
        || !Array.isArray(head.headers) || !head.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((value) => typeof value === "string"))) {
        throw protocolError();
      }
      // The native host never follows redirects outside its endpoint policy.
      if ([301, 302, 303, 307, 308].includes(head.status)) throw new TypeError("Native HTTP redirects are not supported.");
      let responseHeaders;
      try { responseHeaders = new Headers(head.headers); }
      catch { throw protocolError(); }
      const noBody = request.method === "HEAD" || [204, 205, 304].includes(head.status);
      const stream = noBody ? null : new ReadableStream({
        start(controller) { body = controller; },
        async pull(controller) {
          try {
            const chunk = await call("http.read");
            if (!isRecord(chunk) || typeof chunk.data !== "string" || typeof chunk.done !== "boolean"
              || chunk.data.length > ENCODED_CHUNK_BYTES) throw protocolError();
            let bytes;
            try { bytes = base64ToBytes(chunk.data); } catch { throw protocolError(); }
            if (bytes.byteLength > CHUNK_BYTES || (!chunk.done && bytes.byteLength === 0)) throw protocolError();
            if (bytes.byteLength) controller.enqueue(bytes);
            if (chunk.done) { finish(); controller.close(); }
          } catch (error) { stop(error); throw error; }
        },
        cancel(reason) { stop(reason ?? aborted(), false); }
      }, { highWaterMark: 0 });
      let response;
      try { response = new Response(stream, { status: head.status, statusText: head.statusText, headers: responseHeaders }); }
      catch { throw protocolError(); }
      if (noBody) { cancelNative(); finish(); }
      return responseUrl(response, head.url);
    } catch (error) { stop(error); throw error; }
  };
}
