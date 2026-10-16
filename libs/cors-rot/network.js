// cors-rot network: standard fetch() over one of two in-page transports:
//   - 'tailscale' (default): the user's own Tailscale exit node (Go->WASM, vendor/tailscale)
//   - 'tor': Tor over Snowflake (patched webtor-rs, vendor/webtor)
// There is deliberately no "direct" or "auto" route and no CORS detection: same-origin requests
// (the host page's own files) may use the browser's fetch, everything else goes through the
// selected transport. See ./index.js for createCorsRot(), the bundled entry point.
import { createConnectionPool, poolKey, requestHttp, validateHeaders, validateHttpUrl } from './http-stream.js';

// Capture before a caller installs network.fetch as its global fetch. Never
// send WASM/bootstrap asset loading recursively through the transport adapter.
const capturedFetch = globalThis.fetch?.bind(globalThis);
const MODULE_URL = new URL('./vendor/webtor/webtor_wasm.js', import.meta.url);
const WASM_URL = new URL('./vendor/webtor/webtor_wasm_bg.wasm', import.meta.url);
const SNOWFLAKE_URL = 'wss://snowflake.torproject.net/';
const MODES = new Set(['tailscale', 'tor']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SAFE_CROSS_ORIGIN = new Set(['accept', 'accept-language', 'content-type', 'content-language']);
// Release gate, NOT a user preference. The upstream Tor client failed open in TLS and
// skipped directory signatures; the patched build (build/patches/webtor-rs) uses
// rustls/webpki TLS 1.3 only and a 5-of-9 pinned-authority quorum, passed two
// independent code reviews and headless Chromium runs. Enabled as EXPERIMENTAL:
// Android WebView is untested and path selection is weaker than Tor Browser
// (no guards/families), so this is a CORS workaround, not anonymity.
const TOR_SECURITY_VERIFIED = true;
function securityBlocked() {
  return Object.assign(new Error('Tor networking is blocked: TLS certificate/handshake and directory signature validation are not verified.'), { code: 'TOR_SECURITY_BLOCKED' });
}

function cancelled() { return new DOMException('Request cancelled', 'AbortError'); }
function deadline(operation, signal, timeoutMs, cleanup = () => {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (callback, value, clean = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (clean) { try { Promise.resolve(cleanup()).catch(() => {}); } catch { /* best effort */ } }
      callback(value);
    };
    const abort = () => finish(reject, cancelled(), true);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(reject, new DOMException('Transport request setup timed out', 'TimeoutError'), true), timeoutMs);
    Promise.resolve().then(operation).then((value) => finish(resolve, value), (error) => finish(reject, error, true));
  });
}

/** Build only WASM option values; does not bootstrap, open sockets, or unlock
 * the release gate. Exported so offline tests exercise the actual loader path
 * with the production WASM, rather than a mock of wasm-bindgen ownership.
 */
export function createTorClientOptions(module, { seed } = {}) {
  // Constructor requires a URL string. Each wasm-bindgen builder CONSUMES its
  // receiver, so retain the returned wrapper, never reuse the original one.
  let options = new module.TorClientOptions(SNOWFLAKE_URL);
  // The Tor directory comes only from Tor: downloaded from the Snowflake bridge, or the copy
  // this page downloaded earlier (IndexedDB seed). The client authenticates both the same way
  // (5-of-9 pinned authority signatures, validity, full descriptor coverage). No hosted snapshot.
  if (seed) options = options.withDirectorySeed(seed.consensus, seed.microdescriptors, seed.certificates);
  return options;
}

// Save the client's authenticated directory for the next start (after bootstrap and after
// each on-demand refresh). Never throws; caching is only a speed-up.
const savedDirectories = new WeakMap();
async function persistDirectory(client) {
  if (typeof client?.exportDirectory !== 'function') return;
  try {
    // exportDirectory() copies ~10 MB out of WASM: only call it when the cheap version check
    // says the installed directory changed since the last save.
    if (typeof client.directoryValidAfter !== 'function') return;
    const current = client.directoryValidAfter();
    if (!current || savedDirectories.get(client) === current) return;
    const directory = client.exportDirectory();
    if (!directory?.validAfter || savedDirectories.get(client) === directory.validAfter) return;
    const { saveTorDirectory } = await import('./tor-cache.js');
    if (await saveTorDirectory(directory)) savedDirectories.set(client, directory.validAfter);
  } catch { /* cache is optional */ }
}

async function defaultClient({ nativeFetch, onProgress = () => {}, onPhase = () => {} }) {
  if (!TOR_SECURITY_VERIFIED) throw securityBlocked();
  // Fixed same-origin, locally vendored assets, not a CDN or remote JS loader.
  // The build owns the pinned artifact versions. Do not accept URL overrides.
  if (!/^https?:$/.test(MODULE_URL.protocol)) throw new TypeError('Tor assets must be served over HTTP(S)');
  if (globalThis.location?.origin && MODULE_URL.origin !== globalThis.location.origin) throw new TypeError('Tor assets must be same-origin');
  const module = await import(MODULE_URL.href);
  const binary = await nativeFetch(WASM_URL.href, { credentials: 'same-origin', redirect: 'error' });
  if (!binary.ok) throw new Error('Bundled Tor WASM could not be loaded');
  await module.default({ module_or_path: await binary.arrayBuffer() });
  // Progress for the UI, derived from the client's own info log lines (no secrets in them).
  // init() installs the client's log forwarding (needed for setLogCallback detail), a panic handler
  // and a secure-randomness check. Builds before 2026-10-14 also enable a TRACE-level console logger
  // there that floods and can crash the page, so only call it when the build says logging is capped.
  const version = (() => { try { return module.getVersionInfo?.(); } catch { return undefined; } })();
  // getVersionInfo() returns a Map (serde-wasm-bindgen); accept a plain object or string too.
  const field = (name) => (version instanceof Map ? version.get(name) : version?.[name]);
  const logCapped = field('log_capped') === true || field('logging') === 'log-capped' || (typeof version === 'string' && version.includes('log-capped'));
  if (logCapped) { try { module.init?.(); } catch { /* already initialised */ } }
  if (typeof module.setLogCallback === 'function') {
    module.setLogCallback((level, target, message) => { try { onProgress(String(message ?? '')); } catch { /* UI only */ } });
  }
  if (typeof module.TorClientOptions.prototype.withDirectorySeed !== 'function') throw new Error('This Tor build cannot download its directory over Tor');
  let seed;
  try { seed = await (await import('./tor-cache.js')).loadTorDirectory(); } catch { seed = undefined; }
  // Coarse phase known on this side; finer steps come from the client's log when available.
  onPhase(seed ? 'circuit' : 'directory');
  const client = await new module.TorClient(createTorClientOptions(module, { seed }));
  return client;
}

/**
 * createBrowserNetwork(options) — the transport core behind createCorsRot().
 *
 * Transports are explicit: 'tailscale' (default; the user's own exit node) and 'tor' (Tor over
 * Snowflake). Same-origin requests use the browser's fetch; everything else goes through the
 * selected transport. No non-idempotent request is ever retried after a failure.
 *
 * options: mode ('tailscale'), nativeFetch, tailscale (a tailscale manager, see ./tailscale.js),
 * timeoutMs (120000: per setup stage; within an HTTP exchange the longest time without data sent or
 * received, so a body that keeps streaming is never cut off), maxRedirects (10),
 * maxHeaderBytes (65536), maxRequestBodyBytes (8 MiB), keepAlive (true), onStatus(snapshot).
 * createTorClient(context) is a trusted dependency-injection hook for deterministic tests; it must
 * NEVER be populated from page/user data. It returns the supplied TorClient API, not a replacement
 * HTTP fetch. Production Tor is gated by TOR_SECURITY_VERIFIED; this hook is not a user-facing bypass.
 *
 * fetch/fetchTor support bounded buffered uploads, streaming downloads, AbortSignal, and
 * redirect follow/manual/error. Manual returns an inspectable HTTP response (not browser
 * opaqueredirect). There is no cookie jar, ambient credentials, browser cache, referrer, integrity
 * verification, or response decompression. Accept-Encoding: identity is requested; nonidentity
 * encodings fail explicitly.
 */
export function createBrowserNetwork(options = {}) {
  const nativeFetch = options.nativeFetch || capturedFetch;
  if (typeof nativeFetch !== 'function') throw new TypeError('Native fetch is required for browser asset loading');
  let mode = options.mode ?? 'tailscale';
  if (!MODES.has(mode)) throw new TypeError('Network transport must be tailscale or tor');
  const timeoutMs = options.timeoutMs ?? 120000;
  // Starting Tor can include downloading the whole directory over the bridge (first start,
  // or when the saved copy expired): allow longer than one HTTP exchange.
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? (options.timeoutMs !== undefined ? timeoutMs : 300000);
  const maxRedirects = options.maxRedirects ?? 10;
  const maxHeaderBytes = options.maxHeaderBytes ?? 65536;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 8 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('Invalid timeoutMs');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new TypeError('Invalid maxRedirects');
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 32) throw new TypeError('Invalid maxHeaderBytes');
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 0) throw new TypeError('Invalid maxRequestBodyBytes');
  let clientPromise;
  let torGeneration = 0;      // bumped by stopTor(): a start that finishes later releases its client instead
  let lastTailscaleError = null;
  // Startup progress shown in the UI: { phase, done, total, since } while starting, else null.
  let progress = null;
  let progressTimer;
  const setProgress = (next) => {
    progress = next && { since: progress?.since ?? Date.now(), ...next };
    // Batch frequent log-driven updates.
    if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = undefined; notify(); }, 150);
  };
  const onProgress = (message) => {
    if (!progress) return;
    let m;
    if (/Directory seed accepted/.test(message)) setProgress({ phase: 'circuit' });
    else if (/Directory response:/.test(message) && progress.phase !== 'bridge') setProgress({ phase: 'bridge', done: 0, total: 0 });
    if ((m = /Fetching \d+ microdescriptors in (\d+) requests/.exec(message))) setProgress({ phase: 'bridge', done: 0, total: Number(m[1]) + 1 });
    else if (/Directory response:/.test(message) && progress.phase === 'bridge') setProgress({ ...progress, done: Math.min((progress.done ?? 0) + 1, progress.total || Infinity) });
    else if (/Directory downloaded from the bridge/.test(message)) setProgress({ phase: 'circuit' });
    else if (/Creating new circuit|Waiting for circuit/.test(message) && progress.phase !== 'bridge') setProgress({ phase: 'circuit' });
  };
  let lastStartError = null;
  // Keep-alive connections through Tor (per origin); belongs to the current client.
  const pool = options.keepAlive === false ? undefined : createConnectionPool();
  const preconnecting = new Set();
  // The user's own Tailscale exit node (options.tailscale manager, see ./tailscale.js).
  // Separate keep-alive pool; its connections belong to its client.
  const tailscale = options.tailscale;
  const tsPool = options.keepAlive === false ? undefined : createConnectionPool();
  let lastTsClient;
  async function getTailscaleClient(signal) {
    if (!tailscale) throw Object.assign(new Error('Tailscale is not available in this build'), { code: 'TAILSCALE_UNAVAILABLE' });
    const client = await deadline(() => tailscale.getClient(), signal, bootstrapTimeoutMs);
    if (client !== lastTsClient) { tsPool?.clear(); lastTsClient = client; }
    return client;
  }
  const timings = []; // last few requests: { origin, via, reused, connectMs, firstByteMs, at }
  const onTiming = (t) => { timings.unshift({ ...t, at: Date.now() }); timings.length = Math.min(timings.length, 5); notify(); };
  let lastStartMs = null;
  let torState = !TOR_SECURITY_VERIFIED && !options.createTorClient ? 'blocked' : 'idle';
  const listeners = new Set();
  if (options.onStatus) listeners.add(options.onStatus);
  const getStatus = () => ({
    mode, transport: mode, torState,
    progress: progress && { ...progress }, lastStartError: torState === 'error' ? lastStartError : null,
    lastStartMs,
    tailscaleStartError: lastTailscaleError,
    recentTorRequests: timings.map((t) => ({ ...t })),
    torAvailable: torState !== 'blocked',
    message: mode === 'tailscale' ? 'Everything through your Tailscale exit node.'
      : torState === 'blocked' ? 'Tor is security-blocked: TLS and directory authenticity are not verified.'
        : 'Tor only; no direct destination fallback. While Tor is selected, a Snowflake proxy helps others reach Tor.',
  });
  const notify = () => {
    for (const callback of listeners) { try { callback(getStatus()); } catch { /* status observers cannot break transport */ } }
  };
  function getClient() {
    if (!TOR_SECURITY_VERIFIED && !options.createTorClient) return Promise.reject(securityBlocked());
    if (!clientPromise) {
      torState = 'initializing';
      progress = { phase: 'loading', since: Date.now() };
      notify();
      pool?.clear();
      const generation = torGeneration;
      clientPromise = Promise.resolve().then(() => (options.createTorClient || defaultClient)({
        nativeFetch, moduleUrl: MODULE_URL.href, wasmUrl: WASM_URL.href, onProgress,
        onPhase: (phase) => { if (progress) setProgress({ phase }); },
      })).then(async (client) => {
        if (progress?.phase === 'loading' || progress?.phase === 'bridge') setProgress({ phase: 'circuit' });
        if (typeof client?.waitForCircuit !== 'function') throw new TypeError('Invalid Tor client API');
        try { await client.waitForCircuit(); } catch (error) { releaseTorClient(client); throw error; }
        if (generation !== torGeneration) { releaseTorClient(client); throw new Error('Tor was stopped while starting'); }
        void persistDirectory(client);
        lastStartMs = progress?.since ? Date.now() - progress.since : null;
        progress = null;
        torState = 'ready';
        notify();
        return client;
      }).catch((error) => {
        if (generation !== torGeneration) throw error; // stopTor() already reset the state
        clientPromise = undefined;
        pool?.clear();
        progress = null;
        lastStartError = String(error?.message ?? error).slice(0, 200);
        torState = 'error';
        notify();
        throw error;
      });
    }
    return clientPromise;
  }
  // Frees what a Tor client holds (WASM memory, circuits, the bridge WebSocket) when the client offers it.
  function releaseTorClient(client) {
    for (const name of ['close', 'free']) {
      try { const result = client?.[name]?.(); if (result?.catch) result.catch(() => {}); } catch { /* already released */ }
    }
  }
  /**
   * Stops the Tor client: closes pooled connections, releases the client (close()/free() when it has them) and
   * returns to the idle state so that the next Tor request or warmUp() bootstraps a fresh client. Also
   * safe while a start is in progress (that start rejects and its client is released). Idempotent.
   */
  async function stopTor() {
    torGeneration++;
    const pending = clientPromise;
    clientPromise = undefined;
    clearTimeout(progressTimer); progressTimer = undefined;
    progress = null; lastStartError = null; lastStartMs = null;
    pool?.clear();
    preconnecting.clear();
    if (torState !== 'blocked') torState = 'idle';
    notify();
    if (pending) {
      let client;
      try { client = await pending; } catch { /* a start that was aborted or failed holds nothing */ }
      releaseTorClient(client);
    }
  }

  function makeRequest(input, init) {
    // Normalize once so one-shot header iterables are not consumed twice.
    if (init?.headers !== undefined) init = { ...init, headers: validateHeaders(init.headers) };
    const url = validateHttpUrl(input instanceof Request ? input.url : input, globalThis.location?.href);
    const request = new Request(input instanceof Request ? input : url.href, init);
    validateHeaders(request.headers);
    return request;
  }

  async function bodyBytes(request) {
    if (!request.body) return undefined;
    const reader = request.body.getReader();
    return deadline(async () => {
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxRequestBodyBytes) throw new TypeError('Request body exceeds the configured buffer limit');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    }, request.signal, timeoutMs, () => reader.cancel());
  }

  // HTTP through an in-page transport: 'tor' (default) or 'tailscale' (user's exit node).
  async function torRequest(request, via = 'tor') {
    if (request.signal.aborted) throw cancelled();
    if (via === 'tor' && !TOR_SECURITY_VERIFIED && !options.createTorClient) throw securityBlocked();
    if (request.integrity) throw new TypeError('In-page transports do not support integrity verification');
    if (request.keepalive) throw new TypeError('In-page transports do not support keepalive');
    let body = await bodyBytes(request);
    const client = via === 'tailscale' ? await getTailscaleClient(request.signal) : await deadline(getClient, request.signal, bootstrapTimeoutMs);
    const viaPool = via === 'tailscale' ? tsPool : pool;
    let url = validateHttpUrl(request.url);
    let method = request.method;
    let headers = new Headers(request.headers);
    for (let redirects = 0;; redirects++) {
      const response = await requestHttp(client, { url, method, headers, body, signal: request.signal }, { timeoutMs, maxHeaderBytes, pool: viaPool, onTiming: (t) => onTiming({ ...t, via }), label: via === 'tailscale' ? 'Tailscale' : 'Tor' });
      if (via === 'tor') void persistDirectory(client); // no-op unless an on-demand refresh installed a newer directory
      const location = response.headers.get('location');
      if (!REDIRECTS.has(response.status) || location === null || request.redirect === 'manual') {
        Object.defineProperties(response, {
          url: { value: url.href }, redirected: { value: redirects > 0 },
        });
        return response;
      }
      // Dispose of every intermediate response, even invalid redirects.
      await response.body?.cancel();
      if (request.redirect === 'error') throw new TypeError('Redirect rejected by request policy');
      if (redirects >= maxRedirects) throw new TypeError('Too many redirects');
      const next = validateHttpUrl(location, url);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new TypeError('HTTPS to HTTP redirects are refused');
      if (next.origin !== url.origin) {
        // Allowlist rather than guessing every API key header's name. In
        // particular Authorization, Cookie, X-Api-Key and custom secrets vanish.
        headers = new Headers([...headers].filter(([name]) => SAFE_CROSS_ORIGIN.has(name)));
      }
      if (((response.status === 301 || response.status === 302) && method === 'POST') || (response.status === 303 && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        for (const name of [...headers.keys()]) if (name.startsWith('content-')) headers.delete(name);
      }
      url = next;
    }
  }

  async function fetchTor(input, init) { return torRequest(makeRequest(input, init)); }
  async function fetchNetwork(input, init) {
    const request = makeRequest(input, init);
    // Same-origin requests (the host page's own files) use the browser's fetch.
    if (globalThis.location?.origin && new URL(request.url).origin === globalThis.location.origin) return nativeFetch(request);
    // Snapshot transport per request; changing it in the UI never reroutes an active body.
    return torRequest(request, mode === 'tailscale' ? 'tailscale' : 'tor');
  }
  return {
    fetch: fetchNetwork,
    fetchTor,
    // Start the selected transport in the background so the first request does not wait for it.
    warmUp() {
      if (mode === 'tailscale') {
        // start() rejects when the node cannot start: report it through the status instead of leaving an
        // unhandled rejection (the manager's own status carries the same error as state 'error').
        const failed = (error) => { lastTailscaleError = String(error?.message ?? error).slice(0, 200); notify(); };
        try { Promise.resolve(tailscale?.start?.()).then(() => { if (lastTailscaleError) { lastTailscaleError = null; notify(); } }, failed); }
        catch (error) { failed(error); }
      } else if (torState !== 'blocked') getClient().catch(() => {});
      return getStatus();
    },
    /**
     * Open a raw stream to host:port through the selected transport (TLS when { tls: true }).
     * Starts the transport if needed. The returned stream has read()/write(bytes)/close().
     */
    async connect(host, port, { tls = false, signal } = {}) {
      const via = mode === 'tailscale' ? 'tailscale' : 'tor';
      const client = via === 'tailscale' ? await getTailscaleClient(signal) : await deadline(getClient, signal, bootstrapTimeoutMs);
      const open = tls ? client.connectTls : client.connect;
      if (typeof open !== 'function') throw new TypeError('The selected transport cannot open this stream (TLS requires connectTls)');
      return open.call(client, host, Number(port), timeoutMs);
    },
    /**
     * Warm a connection to `url`'s origin before it is needed (e.g. the selected model provider).
     * Open the transport stream + TLS now and park it in the keep-alive pool. Never starts the
     * transport by itself; waits for a start already in progress.
     */
    async preconnect(input) {
      const url = validateHttpUrl(input);
      const route = mode === 'tailscale' ? 'tailscale' : 'tor';
      const warmPool = route === 'tailscale' ? tsPool : pool;
      if (!warmPool) return { route, warmed: false };
      if (route === 'tor' && !clientPromise) return { route, warmed: false, reason: 'tor-not-started' };
      if (route === 'tailscale' && !tailscale?.readyClient?.()) return { route, warmed: false, reason: 'tailscale-not-ready' };
      const { key, host, port } = poolKey(url);
      if (warmPool.has(key) || preconnecting.has(`${route} ${key}`)) return { route, warmed: false, reason: 'already-warm' };
      preconnecting.add(`${route} ${key}`);
      try {
        const client = route === 'tailscale' ? await getTailscaleClient() : await clientPromise;
        const connect = url.protocol === 'https:' ? client.connectTls : client.connect;
        const t = Date.now();
        const stream = await connect.call(client, host, port, timeoutMs);
        if (warmPool.has(key)) { try { await stream.close(); } catch { /* ignore */ } return { route, warmed: false, reason: 'already-warm' }; }
        warmPool.give(key, stream);
        return { route, warmed: true, ms: Date.now() - t };
      } catch (error) {
        return { route, warmed: false, reason: String(error?.message ?? error).slice(0, 120) };
      } finally { preconnecting.delete(`${route} ${key}`); }
    },
    /** Stops the Tor client (see stopTor above). The Tailscale manager is owned by its creator: stop it with tailscale.stop(). */
    stopTor,
    /** Releases everything this network holds: the Tor client, both keep-alive pools, timers and status listeners. */
    async dispose() {
      await stopTor();
      tsPool?.clear();
      lastTsClient = undefined;
      listeners.clear();
    },
    getMode: () => mode,
    getTransport: () => mode,
    setMode(value) { if (!MODES.has(value)) throw new TypeError('Network transport must be tailscale or tor'); mode = value; notify(); return getStatus(); },
    setTransport(value) { return this.setMode(value); },
    getStatus,
    subscribe(callback) { listeners.add(callback); callback(getStatus()); return () => listeners.delete(callback); },
  };
}
