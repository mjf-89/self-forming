// cors-rot optional git-http adapter: a tiny isomorphic-git `http` plugin backed by any fetch
// (e.g. corsRot.fetch), with streaming in both directions and no cookie jar, retries or credential
// persistence. Pass this as `http` to isomorphic-git; isomorphic-git itself is NOT bundled here.
// Usage: git.clone({ fs, http: createGitHttp(corsRot.fetch), dir, url })

const encoder = new TextEncoder();
function bytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected text, ArrayBuffer or a typed array");
}
function streamBody(body) {
  if (body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
  if (typeof body.getReader === "function") return body;
  const iterator = body[Symbol.asyncIterator]?.() || body[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("Git HTTP body must be bytes, a stream, or an iterable of byte chunks");
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(bytes(value));
      } catch (cause) { controller.error(cause); }
    },
    async cancel(reason) { await iterator.return?.(reason); },
  }, { highWaterMark: 0 });
}
async function* responseChunks(body) {
  if (!body) return;
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; return; }
      yield bytes(value);
    }
  } finally {
    try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Git requires an absolute HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only Git over HTTP(S) is supported");
  if (url.username || url.password) throw new Error("Use a credential-free Git URL; supply credentials through onAuth instead");
  return url;
}

export function createGitHttp(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("Git HTTP requires fetch");
  return {
    async request({ url, method = "GET", headers = {}, body, signal, fetchOptions = {} }) {
      safeUrl(url);
      const requestBody = streamBody(body);
      const requestHeaders = new Headers(fetchOptions.headers);
      new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
      const init = {
        ...fetchOptions, method, headers: requestHeaders,
        body: requestBody, signal: signal ?? fetchOptions.signal,
        credentials: "omit",
      };
      if (requestBody && typeof requestBody.getReader === "function") init.duplex = "half";
      const response = await fetchImpl(url, init);
      return {
        url: response.url || url, method,
        statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseChunks(response.body),
      };
    },
  };
}
