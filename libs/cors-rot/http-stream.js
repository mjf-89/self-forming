// cors-rot: HTTP/1.1 over transport streams (Tor or Tailscale), with an optional keep-alive pool
// (createConnectionPool). No decompression, protocol upgrades, cookie jar, or HTTP/2. Bodies are
// pulled, not buffered. The stream API required of a transport client: connect(host, port, timeoutMs)
// and connectTls(host, port, timeoutMs) returning { read(), write(bytes), close() }.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const encoder = new TextEncoder();
const protocolError = (message) => new TypeError(`Invalid HTTP response: ${message}`);
const abortError = () => new DOMException('Request cancelled', 'AbortError');
const WRITE_CHUNK_BYTES = 64 * 1024; // below the Tor stream limit of 256 KiB per write

export function validateHttpUrl(input, base) {
  if (/[\x00-\x20\x7f]/.test(String(input))) throw new TypeError('Invalid URL characters');
  const url = new URL(input, base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Only HTTP and HTTPS URLs are supported');
  if (url.username || url.password) throw new TypeError('URL credentials are not supported; use an Authorization header');
  url.hash = '';
  return url;
}

export function validateHeaders(input) {
  const headers = new Headers();
  if (!input) return headers;
  const entries = typeof input[Symbol.iterator] === 'function' ? input : Object.entries(input);
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName), value = String(rawValue);
    if (!TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new TypeError('Invalid HTTP header');
    headers.append(name, value);
  }
  return headers;
}

const duration = (ms) => ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;

// One exchange's lifetime. The timeout is an INACTIVITY limit: progress() (bytes received or sent)
// restarts it, so a response that keeps streaming is never cut off, while a silent connection is.
function lifetime(signal, timeoutMs, label = '') {
  let stream, closed = false, stopped = false, bodyController, timer;
  let rejectStop;
  const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
  // There need not be an outstanding read when a deadline expires.
  stopPromise.catch(() => {});
  const close = () => {
    if (!stream || closed) return;
    closed = true;
    try { Promise.resolve(stream.close()).catch(() => {}); } catch { /* already closed */ }
  };
  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    close();
    rejectStop(error || abortError());
    if (error && bodyController) {
      try { bodyController.error(error); } catch { /* consumer already cancelled */ }
    }
  };
  // Body finished cleanly and the connection may be reused: end this exchange WITHOUT closing it.
  const release = () => {
    if (stopped) return undefined;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    rejectStop(abortError());
    return closed ? undefined : stream;
  };
  const onAbort = () => stop(abortError());
  const expire = () => stop(new DOMException(`${label ? `${label} ` : ''}HTTP request timed out (no data for ${duration(timeoutMs)})`, 'TimeoutError'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  if (!stopped) timer = setTimeout(expire, timeoutMs);
  return {
    run: (operation) => stopped ? stopPromise : Promise.race([Promise.resolve().then(operation), stopPromise]),
    // Data moved: restart the inactivity limit.
    progress() { if (stopped) return; clearTimeout(timer); timer = setTimeout(expire, timeoutMs); },
    attach(value) { stream = value; if (stopped) close(); },
    body(controller) { bodyController = controller; },
    stop,
    release,
  };
}

class Reader {
  constructor(stream, life) { this.stream = stream; this.life = life; this.buffer = new Uint8Array(); this.offset = 0; this.received = 0; }
  get leftover() { return this.buffer.length - this.offset; }
  async available() {
    let emptyReads = 0;
    while (this.offset === this.buffer.length) {
      const value = await this.life.run(() => this.stream.read());
      if (value === undefined) return false;
      if (!(value instanceof Uint8Array)) throw protocolError('stream returned non-bytes');
      if (!value.length && ++emptyReads > 1024) throw protocolError('too many empty stream reads');
      if (value.length) this.life.progress();
      this.received += value.length;
      this.buffer = value;
      this.offset = 0;
    }
    return true;
  }
  async take(max = 65536) {
    if (!await this.available()) return undefined;
    const end = Math.min(this.buffer.length, this.offset + max);
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }
  async line(budget) {
    const bytes = [];
    for (;;) {
      if (!await this.available()) throw protocolError('unexpected EOF in headers or chunk framing');
      const byte = this.buffer[this.offset++];
      if (--budget.remaining < 0) throw protocolError('header or chunk line size limit exceeded');
      if (byte === 10) {
        if (bytes.pop() !== 13) throw protocolError('lines must end in CRLF');
        // Preserve HTTP's byte-valued field text, without UTF-8 replacement.
        let text = '';
        for (const b of bytes) text += String.fromCharCode(b);
        return text;
      }
      bytes.push(byte);
    }
  }
}

function field(line) {
  const colon = line.indexOf(':');
  const name = line.slice(0, colon);
  const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '');
  if (colon < 1 || !TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw protocolError('malformed header field');
  return [name.toLowerCase(), value];
}

async function readHead(reader, maxHeaderBytes) {
  const budget = { remaining: maxHeaderBytes };
  for (let interim = 0; interim <= 16; interim++) {
    const statusLine = await reader.line(budget);
    const match = /^HTTP\/1\.([01]) ([1-5][0-9]{2})(?: ([\t\x20-\x7e\x80-\xff]*))?$/.exec(statusLine);
    if (!match) throw protocolError('malformed status line');
    const minor = Number(match[1]);
    const status = Number(match[2]);
    const headers = new Headers();
    const raw = new Map();
    for (;;) {
      const line = await reader.line(budget);
      if (!line) break;
      const [name, value] = field(line);
      if (!raw.has(name)) raw.set(name, []);
      raw.get(name).push(value);
      headers.append(name, value);
    }
    if (status === 101) throw protocolError('protocol upgrades are unsupported');
    if (status < 200) continue;
    return { status, statusText: match[3] || '', headers, raw, minor };
  }
  throw protocolError('too many interim responses');
}

function framing(raw) {
  const transfer = raw.get('transfer-encoding');
  const lengths = raw.get('content-length');
  if (transfer && lengths) throw protocolError('ambiguous transfer-encoding and content-length');
  if (transfer && (transfer.length !== 1 || transfer[0].toLowerCase() !== 'chunked')) throw protocolError('unsupported transfer-encoding');
  let length;
  if (lengths) {
    // Strictly reject duplicate lengths, including identical ones.
    if (lengths.length !== 1 || !/^\d+$/.test(lengths[0])) throw protocolError('invalid content-length');
    length = Number(lengths[0]);
    if (!Number.isSafeInteger(length)) throw protocolError('content-length too large');
  }
  return { chunked: !!transfer, length };
}

/**
 * Idle keep-alive connections, per origin (scheme://host:port). A finished response gives its
 * connection back (if reusable); the next request to the same origin takes it, skipping the Tor
 * stream setup and the TLS handshake. Idle connections close after `idleMs`.
 */
export function createConnectionPool({ maxPerKey = 2, maxTotal = 8, idleMs = 30000 } = {}) {
  const idle = new Map(); // key -> [{ stream, timer }]
  let total = 0;
  const closeStream = (stream) => { try { Promise.resolve(stream.close()).catch(() => {}); } catch { /* already closed */ } };
  const unlink = (key, entry) => {
    const list = idle.get(key);
    const index = list?.indexOf(entry) ?? -1;
    if (index < 0) return false;
    list.splice(index, 1);
    if (!list.length) idle.delete(key);
    total--;
    clearTimeout(entry.timer);
    return true;
  };
  return {
    take(key) {
      const entry = idle.get(key)?.at(-1);
      if (!entry) return undefined;
      unlink(key, entry);
      return entry.stream;
    },
    give(key, stream) {
      const list = idle.get(key) ?? [];
      if (list.length >= maxPerKey || total >= maxTotal) { closeStream(stream); return; }
      const entry = { stream };
      entry.timer = setTimeout(() => { if (unlink(key, entry)) closeStream(stream); }, idleMs);
      entry.timer.unref?.();
      list.push(entry);
      idle.set(key, list);
      total++;
    },
    has(key) { return (idle.get(key)?.length ?? 0) > 0; },
    clear() {
      for (const [key, list] of [...idle]) for (const entry of [...list]) { unlink(key, entry); closeStream(entry.stream); }
    },
    get size() { return total; },
  };
}

const now = () => globalThis.performance?.now?.() ?? Date.now();

/** Pool key for a URL (scheme://host:port), shared with requestHttp. */
export function poolKey(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { key: `${url.protocol}//${host}:${port}`, host, port };
}

/** One HTTP exchange. `timeoutMs` is an inactivity limit over connect, writes, headers and the
 * body: it restarts whenever bytes are received or a request piece is written, so a body that
 * keeps streaming (e.g. a long model reply) is never cut off, while a connection that stays
 * silent for `timeoutMs` fails with a TimeoutError naming `label` (the transport, e.g. "Tor").
 * Request bodies must be buffered Uint8Arrays; callers own redirect policy.
 * Cancellation/abort/timeout always closes this exchange's stream, including a
 * connect that resolves after cancellation. HTTPS ONLY uses connectTls.
 * With `pool`, connections are kept alive and reused. A reused connection that fails before
 * any response byte arrives (the server closed it while idle) is retried once on a fresh
 * connection, as browsers do; a fresh connection is never retried.
 * `onTiming({ origin, reused, connectMs, firstByteMs })` reports where the time went.
 */
export async function requestHttp(client, request, { timeoutMs = 120000, maxHeaderBytes = 65536, pool, onTiming, label = '' } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('Invalid timeoutMs');
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 32) throw new TypeError('Invalid maxHeaderBytes');
  const url = validateHttpUrl(request.url);
  const method = request.method || 'GET';
  if (!TOKEN.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase())) throw new TypeError('Unsupported HTTP method');
  const headers = validateHeaders(request.headers);
  for (const name of headers.keys()) {
    if (['host', 'content-length', 'transfer-encoding', 'connection', 'trailer', 'upgrade', 'expect', 'te', 'proxy-authorization', 'proxy-connection'].includes(name)) {
      throw new TypeError('Transport-managed or unsupported request header');
    }
  }
  if (request.body != null && !(request.body instanceof Uint8Array)) throw new TypeError('HTTP request body must be bytes');
  if (['HEAD', 'GET'].includes(method.toUpperCase()) && request.body != null) throw new TypeError('GET/HEAD bodies are unsupported');
  headers.set('host', url.host);
  if (!pool) headers.set('connection', 'close'); // HTTP/1.1 keeps the connection open by default
  headers.set('accept-encoding', 'identity');
  if (request.body != null) headers.set('content-length', String(request.body.length));
  else if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) headers.set('content-length', '0');
  let head = `${method} ${url.pathname || '/'}${url.search} HTTP/1.1\r\n`;
  for (const [name, value] of headers) {
    // Request serialization is deliberately ASCII (body bytes remain arbitrary).
    if (/[^\t\x20-\x7e]/.test(value)) throw new TypeError('Non-ASCII request headers are unsupported');
    head += `${name}: ${value}\r\n`;
  }
  head += '\r\n';
  if (head.length > maxHeaderBytes) throw new TypeError('Request headers too large');
  const life = lifetime(request.signal, timeoutMs, label);
  const connect = url.protocol === 'https:' ? client.connectTls : client.connect;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const key = `${url.protocol}//${host}:${port}`;
  const started = now();
  let connectMs = 0;
  const open = async () => {
    if (typeof connect !== 'function') throw new TypeError('Required Tor transport is unavailable (HTTPS requires TLS)');
    const t = now();
    const stream = await life.run(() => Promise.resolve(connect.call(client, host, port, timeoutMs)).then((s) => { life.attach(s); return s; }));
    connectMs += now() - t;
    return stream;
  };
  // Send the request on `stream` and read the response head.
  const exchange = async (stream, reader) => {
    // The Tor stream accepts at most 256 KiB per write, so send in bounded, sequential pieces.
    const writeAll = async (bytes) => {
      for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
        const piece = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES);
        await life.run(() => stream.write(piece));
        life.progress();
      }
    };
    await writeAll(encoder.encode(head));
    if (request.body?.length) await writeAll(request.body);
    return readHead(reader, maxHeaderBytes);
  };
  try {
    let stream = pool?.take(key);
    let reused = Boolean(stream);
    if (stream) life.attach(stream); else stream = await open();
    let reader = new Reader(stream, life);
    let response;
    try { response = await exchange(stream, reader); }
    catch (error) {
      const cancelled = request.signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      if (!reused || cancelled || reader.received > 0) throw error;
      // Stale idle connection (closed by the server before answering): one fresh attempt.
      try { Promise.resolve(stream.close()).catch(() => {}); } catch { /* already closed */ }
      reused = false;
      stream = await open();
      reader = new Reader(stream, life);
      response = await exchange(stream, reader);
    }
    const { status, statusText, headers: responseHeaders, raw, minor } = response;
    try { onTiming?.({ origin: url.origin, reused, connectMs: Math.round(connectMs), firstByteMs: Math.round(now() - started) }); } catch { /* diagnostics only */ }
    const { chunked, length } = framing(raw);
    const noBody = method.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status);
    if (!noBody && raw.has('content-encoding') && raw.get('content-encoding').join(',').toLowerCase() !== 'identity') {
      throw protocolError('nonidentity content-encoding is unsupported');
    }
    // Reusable only if HTTP/1.1, the server did not ask to close, and the body is exactly framed.
    const keepAlive = Boolean(pool) && minor === 1 && !(raw.get('connection') ?? []).some((v) => /(^|,)\s*close\s*(,|$)/i.test(v))
      && (noBody || chunked || length !== undefined);
    const finish = () => {
      if (keepAlive && reader.leftover === 0) {
        const kept = life.release();
        if (kept) { pool.give(key, kept); return; }
      }
      life.stop();
    };
    if (noBody || length === 0) {
      finish();
      return new Response(noBody ? null : new Uint8Array(), { status, statusText, headers: responseHeaders });
    }
    let remaining = length, chunkRemaining = 0, chunkEnd = false;
    const body = new ReadableStream({
      start(controller) { life.body(controller); },
      async pull(controller) {
        try {
          if (chunked) {
            if (chunkEnd) {
              if (await reader.line({ remaining: 2 }) !== '') throw protocolError('missing chunk CRLF');
              chunkEnd = false;
            }
            if (chunkRemaining === 0) {
              const line = await reader.line({ remaining: 8192 });
              const size = /^([0-9a-fA-F]+)((?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"))?)*)$/.exec(line);
              if (!size) throw protocolError('invalid chunk size or extension');
              chunkRemaining = Number.parseInt(size[1], 16);
              if (!Number.isSafeInteger(chunkRemaining)) throw protocolError('chunk too large');
              if (chunkRemaining === 0) {
                const budget = { remaining: maxHeaderBytes };
                for (;;) {
                  const trailer = await reader.line(budget);
                  if (!trailer) break;
                  const [name] = field(trailer);
                  if (['content-length', 'transfer-encoding', 'host', 'connection', 'trailer', 'content-encoding'].includes(name)) throw protocolError('forbidden framing trailer');
                }
                // Trailers are validated and discarded: Fetch has no trailer API.
                controller.close();
                finish();
                return;
              }
            }
            const bytes = await reader.take(Math.min(chunkRemaining, 65536));
            if (!bytes) throw protocolError('truncated chunk');
            chunkRemaining -= bytes.length;
            chunkEnd = chunkRemaining === 0;
            controller.enqueue(bytes);
          } else {
            const bytes = await reader.take(remaining === undefined ? 65536 : Math.min(remaining, 65536));
            if (!bytes) {
              if (remaining !== undefined && remaining !== 0) throw protocolError('truncated content-length body');
              controller.close();
              life.stop();
              return;
            }
            if (remaining !== undefined) remaining -= bytes.length;
            controller.enqueue(bytes);
            if (remaining === 0) { controller.close(); finish(); }
          }
        } catch (error) { life.stop(error); }
      },
      cancel() { life.stop(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status, statusText, headers: responseHeaders });
  } catch (error) {
    life.stop(error);
    throw error;
  }
}
