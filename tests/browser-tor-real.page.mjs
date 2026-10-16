// TEST-PAGE-ONLY harness: runs the vendored webtor WASM in a real browser engine.
// Drive with tests/browser-tor-real.mjs, or open the page and call window.runAll().
import init, * as webtor from '../libs/cors-rot/vendor/webtor/webtor_wasm.js';
import { createBrowserNetwork, createTorClientOptions } from '../libs/cors-rot/network.js';

const R = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, steps: [], logs: [], consoleErrors: [] };
window.__results = R;
const out = document.getElementById('out');
const render = () => { out.textContent = JSON.stringify(R, null, 1); };
const errText = (e) => { try { return e?.get?.('message') ?? e?.message ?? String(e); } catch { return String(e); } };
const withDeadline = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`deadline ${ms}ms exceeded: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };
async function step(name, fn) {
  const s = { name, ok: false }; R.steps.push(s); const t0 = performance.now();
  try { s.detail = await fn(s); s.ok = true; } catch (e) { s.error = errText(e); s.errorRaw = String(e?.stack || e).slice(0, 1500); }
  s.ms = Math.round(performance.now() - t0); render(); return s;
}
const dec = new TextDecoder('latin1'), enc = new TextEncoder();
async function readAll(stream, limit = 8 << 20) {
  const chunks = []; let n = 0;
  for (;;) { const c = await stream.read(); if (c === undefined) break; chunks.push(c); n += c.length; if (n > limit) throw new Error('response too large'); }
  const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } return all;
}
function splitHttp(bytes) {
  const text = dec.decode(bytes); const i = text.indexOf('\r\n\r\n'); if (i < 0) throw new Error('no header terminator');
  const head = text.slice(0, i); const lines = head.split('\r\n'); const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(lines[0])?.[1]);
  const headers = {}; for (const l of lines.slice(1)) { const k = l.indexOf(':'); headers[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
  let body = text.slice(i + 4);
  if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    let out = '', p = 0;
    for (;;) { const e = body.indexOf('\r\n', p); const size = parseInt(body.slice(p, e), 16); if (!Number.isFinite(size)) throw new Error('bad chunk size'); if (size === 0) break; out += body.slice(e + 2, e + 2 + size); p = e + 2 + size + 2; if (p > body.length) throw new Error('truncated chunked body'); }
    body = out;
  }
  return { status, statusLine: lines[0], headers, body };
}
async function httpGet(client, host, path, extra = {}, timeout = 90000) {
  const stream = await withDeadline(client.connectTls(host, 443, timeout), timeout + 5000, `connectTls ${host}`);
  try {
    let req = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept-Encoding: identity\r\n`;
    for (const [k, v] of Object.entries(extra)) req += `${k}: ${v}\r\n`;
    await stream.write(enc.encode(req + '\r\n'));
    const raw = await withDeadline(readAll(stream), timeout, `read ${host}`);
    return { ...splitHttp(raw), rawBytes: raw.length };
  } finally { try { await stream.close(); } catch {} }
}

window.runAll = async function runAll({ skipLive = false } = {}) {
  const t00 = performance.now();
  let mod;
  await step('wasm-instantiate (fetch->arrayBuffer->init)', async () => {
    const bytes = await (await fetch(new URL('../libs/cors-rot/vendor/webtor/webtor_wasm_bg.wasm', import.meta.url), { cache: 'no-store' })).arrayBuffer();
    await init({ module_or_path: bytes }); mod = webtor;
    try { webtor.setLogCallback((...a) => { if (R.logs.length < 400) R.logs.push(a.map(String).join(' ').slice(0, 300)); }); } catch {}
    return { wasmBytes: bytes.byteLength, version: webtor.getVersionInfo?.(), test_wasm: webtor.test_wasm?.() };
  });
  if (!mod) { R.totalMs = Math.round(performance.now() - t00); R.done = true; return R; }
  if (skipLive) { R.totalMs = Math.round(performance.now() - t00); R.done = true; render(); return R; }

  let client;
  await step('live: TorClientOptions (retain builder) + new TorClient (Snowflake bridge, wss:// WebSocket transport)', async (s) => {
    const opts = createTorClientOptions(mod); // directory downloaded from the bridge over Tor
    const t = performance.now();
    client = await withDeadline(new mod.TorClient(opts), 240000, 'new TorClient');
    s.constructMs = Math.round(performance.now() - t);
    return { constructedMs: s.constructMs };
  });
  if (client) {
    await step('live: waitForCircuit', async () => {
      await withDeadline(client.waitForCircuit(), 240000, 'waitForCircuit');
      let status; try { status = await client.getCircuitStatusString(); } catch (e) { status = 'n/a ' + errText(e); }
      let relays; try { relays = await client.getCircuitRelays(); } catch {}
      return { status, relays: relays ? JSON.stringify(relays).slice(0, 600) : undefined };
    });
    await step('live: check.torproject.org /api/ip via connectTls (expect IsTor:true)', async () => {
      const r = await httpGet(client, 'check.torproject.org', '/api/ip', { 'User-Agent': 'Mozilla/5.0 (browser-tor-real test)' });
      let j; try { j = JSON.parse(r.body); } catch {}
      if (r.status !== 200 || !j || j.IsTor !== true) throw new Error(`unexpected: ${r.statusLine} ${r.body.slice(0, 200)}`);
      return { status: r.status, isTor: j.IsTor, exitIp: j.IP, rawBytes: r.rawBytes };
    });
    await step('live: example.com GET / via connectTls', async () => {
      const r = await httpGet(client, 'example.com', '/', { 'User-Agent': 'Mozilla/5.0 (browser-tor-real test)' });
      if (r.status !== 200 || !/Example Domain/.test(r.body)) throw new Error(`unexpected: ${r.statusLine} ${r.body.slice(0, 200)}`);
      return { status: r.status, bodyChars: r.body.length, hasExampleDomain: true, rawBytes: r.rawBytes };
    });
    await step('live: github.com git-upload-pack discovery via connectTls (raw)', async () => {
      const r = await httpGet(client, 'github.com', '/isomorphic-git/isomorphic-git.git/info/refs?service=git-upload-pack', { 'User-Agent': 'git/2.43.0' }, 120000);
      if (r.status !== 200 || !r.body.includes('# service=git-upload-pack')) throw new Error(`unexpected: ${r.statusLine} ${r.body.slice(0, 200)}`);
      return { status: r.status, contentType: r.headers['content-type'], transferEncoding: r.headers['transfer-encoding'], decodedBodyBytes: r.body.length, rawBytes: r.rawBytes, head: r.body.slice(0, 120) };
    });
    await step('live: app adapter createBrowserNetwork({createTorClient}).fetchTor streamed git discovery', async () => {
      // TEST-ONLY injection point (documented in cors-rot/network.js); production gate untouched.
      const net = createBrowserNetwork({ mode: 'tor', createTorClient: async () => client, timeoutMs: 150000 });
      const t = performance.now();
      const resp = await net.fetchTor('https://github.com/isomorphic-git/isomorphic-git.git/info/refs?service=git-upload-pack', { headers: { 'user-agent': 'git/2.43.0' } });
      const headersMs = Math.round(performance.now() - t);
      const reader = resp.body.getReader(); let n = 0, chunks = 0, first = new Uint8Array(0);
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (chunks === 0) first = value.slice(0, 200); n += value.length; chunks++; }
      const head = dec.decode(first);
      if (resp.status !== 200 || !head.includes('# service=git-upload-pack')) throw new Error(`unexpected: ${resp.status} ${head.slice(0, 120)}`);
      return { status: resp.status, isResponse: resp instanceof Response, streamedChunks: chunks, bodyBytes: n, headersMs, contentType: resp.headers.get('content-type'), head: head.slice(0, 80), torState: net.getStatus().torState };
    });
    try { await withDeadline(client.close(), 10000, 'close'); } catch {}
  }
  R.totalMs = Math.round(performance.now() - t00); R.done = true; render(); return R;
};
window.addEventListener('error', (e) => R.consoleErrors.push('window.error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => R.consoleErrors.push('unhandledrejection: ' + errText(e.reason)));
window.__ready = true; render();

// ---------------------------------------------------------------------------
// Follow-up checks (all through the TEST-PAGE-injected real client and the app's
// createBrowserNetwork({mode:'tor', createTorClient}).fetchTor). Public endpoints only.
// ---------------------------------------------------------------------------
window.runFollowup = async function runFollowup({ only = null } = {}) {
  const t00 = performance.now();
  const F = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, steps: [], transport: {} };
  window.__followup = F;
  const fstep = async (name, fn) => {
    const s = { name, ok: false }; F.steps.push(s); const t0 = performance.now();
    try { s.detail = await fn(s); s.ok = true; } catch (e) { s.error = errText(e); s.errorRaw = String(e?.stack || e).slice(0, 1500); s.detail = e?.out ?? e?.d ?? e?.detail; }
    s.ms = Math.round(performance.now() - t0); return s;
  };
  // Instrumentation recorded by tests/browser-tor-real.followup.mjs's init script
  let mod;
  await init({ module_or_path: await (await fetch(new URL('../libs/cors-rot/vendor/webtor/webtor_wasm_bg.wasm', import.meta.url), { cache: 'no-store' })).arrayBuffer() }); mod = webtor;
  let client;
  await fstep('bootstrap: new TorClient + waitForCircuit', async () => {
    client = await withDeadline(new mod.TorClient(createTorClientOptions(mod)), 240000, 'new TorClient');
    await withDeadline(client.waitForCircuit(), 240000, 'waitForCircuit');
    let relays; try { relays = await client.getCircuitRelays(); } catch {}
    return { circuit: await client.getCircuitStatusString(), relays };
  });
  if (!client) { F.done = true; return F; }
  const net = createBrowserNetwork({ mode: 'tor', createTorClient: async () => client, timeoutMs: 180000 });
  // Counting wrapper around the app's fetchTor (counts decoded body bytes actually read by consumers).
  const stats = { requests: 0, bytesIn: 0, urls: [] };
  const countingFetch = async (input, init) => {
    stats.requests++; stats.urls.push(`${init?.method || 'GET'} ${typeof input === 'string' ? input : input.url}`);
    const resp = await net.fetchTor(input, init);
    if (!resp.body) return resp;
    const counter = new TransformStream({ transform(chunk, c) { stats.bytesIn += chunk.byteLength; c.enqueue(chunk); } });
    return new Response(resp.body.pipeThrough(counter), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  };
  const MAX_URLS = 40;

  // ---- 1. end-to-end git clone in the browser ----
  F.bufferBeforeGitImport = typeof globalThis.Buffer;
  const { Vfs, MemoryBackend, normalizePath } = await import('../plugins/core-execution/web/browser/browser-vfs.js');
  const { createBrowserGit } = await import('../apps/browser/browser-git.js');
  const cloneOne = async (name, url, { depth = 1, noCheckout = false } = {}) => fstep(name, async () => {
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    const at = (p) => normalizePath(p, '/workspace');
    const rpc = (fn) => async (...a) => { try { return fn(...a); } catch (e) { throw Object.assign(new Error(e.message), { code: e.code, path: e.path }); } };
    const fs = {
      readFile: rpc((p) => vfs.read(at(p))), writeFile: rpc((p, d) => vfs.write(at(p), d)),
      stat: rpc((p) => { const i = vfs.info(at(p)); return { ...i, mtime: new Date(i.mtimeMs), isFile: () => i.kind === 'file', isDirectory: () => i.kind === 'directory' }; }),
      readdir: rpc((p) => vfs.readdir(at(p))), mkdir: rpc((p, o) => vfs.mkdir(at(p), o?.recursive ?? true)),
      rm: rpc((p, o) => vfs.remove(at(p), { recursive: Boolean(o?.recursive), force: Boolean(o?.force) })),
    };
    fs.promises = fs;
    const before = { requests: stats.requests, bytesIn: stats.bytesIn };
    const git = createBrowserGit({ fs, fetch: countingFetch, cwd: '/workspace/clone' });
    const phases = new Set(); let lastProgress;
    const t = performance.now();
    await withDeadline(git.clone({ url, depth, singleBranch: true, noCheckout, onProgress: (p) => { phases.add(p.phase); lastProgress = p; }, onMessage: () => {} }), 420000, 'clone ' + url);
    const cloneMs = Math.round(performance.now() - t);
    const branch = await git.currentBranch();
    const log = await git.log({ depth: 5 });
    const files = noCheckout ? [] : await git.listFiles({ ref: 'HEAD' }).catch((e) => ['listFiles error: ' + errText(e)]);
    const walk = (dir, out = []) => { for (const n of vfs.readdir(dir)) { const p = dir === '/' ? '/' + n : dir + '/' + n; const i = vfs.info(p); if (n === '.git') continue; if (i.kind === 'directory') walk(p, out); else out.push({ path: p.replace('/workspace/clone/', ''), size: i.size ?? 0 }); } return out; };
    let worktree = []; try { worktree = walk('/workspace/clone'); } catch (e) { worktree = [{ error: errText(e) }]; }
    let readme; try { const r = worktree.find((f) => /readme/i.test(f.path || '')); if (r) readme = new TextDecoder().decode(await fs.readFile('/workspace/clone/' + r.path)).slice(0, 80); } catch {}
    const tipFiles = (() => { try { return worktree.length; } catch { return null; } })();
    const empty = log.length === 0;
    return {
      url, depth, noCheckout, cloneMs, currentBranch: branch,
      commits: log.map((c) => ({ oid: c.oid, message: c.commit.message.trim().slice(0, 80), author: c.commit.author.name })),
      headOid: await git.resolveRef({ ref: 'HEAD' }).catch((e) => 'resolveRef error: ' + errText(e)),
      trackedFileCount: files.length, trackedFilesSample: files.slice(0, 15), worktreeFileCount: tipFiles,
      worktreeBytes: worktree.reduce((a, f) => a + (f.size || 0), 0), readmeHead: readme,
      networkRequests: stats.requests - before.requests, networkBodyBytesRead: stats.bytesIn - before.bytesIn,
      requestUrls: stats.urls.slice(-(stats.requests - before.requests)).slice(0, MAX_URLS), phases: [...phases], lastProgress: lastProgress && { phase: lastProgress.phase, loaded: lastProgress.loaded, total: lastProgress.total }, emptyRepo: empty,
    };
  });
  F.bufferAfterGitImport = typeof globalThis.Buffer; F.bufferIsVendored = globalThis.Buffer?.from?.('hi').toString('hex') === '6869';
  await cloneOne('git clone depth=1 singleBranch isomorphic-git/test.empty.git', 'https://github.com/isomorphic-git/test.empty.git');
  await cloneOne('git clone depth=1 singleBranch octocat/Hello-World.git (with checkout)', 'https://github.com/octocat/Hello-World.git');
  if (only === 'clone') { try { await withDeadline(client.close(), 10000, 'close'); } catch {} F.totalMs = Math.round(performance.now() - t00); F.done = true; return F; }
  await cloneOne('git clone depth=1 singleBranch isomorphic-git/isomorphic-git.git (larger, extra; noCheckout because VFS has no symlinks/exec bits)', 'https://github.com/isomorphic-git/isomorphic-git.git', { noCheckout: true });

  // ---- 2. ChatGPT sign-in prerequisites (CORS-blocked directly): metadata only ----
  await fstep('auth.openai.com openid-configuration + jwks_uri via fetchTor', async () => {
    const t = performance.now();
    const r = await net.fetchTor('https://auth.openai.com/.well-known/openid-configuration', { headers: { accept: 'application/json' } });
    const text = await r.text();
    const out = { configStatus: r.status, configContentType: r.headers.get('content-type'), configBytes: text.length, configMs: Math.round(performance.now() - t) };
    let cfg; try { cfg = JSON.parse(text); out.configParses = true; out.issuer = cfg.issuer; out.jwks_uri = cfg.jwks_uri; out.configKeyCount = Object.keys(cfg).length; out.hasAuthorizationEndpoint = !!cfg.authorization_endpoint; out.hasTokenEndpoint = !!cfg.token_endpoint; }
    catch { out.configParses = false; out.configBodyHead = text.slice(0, 200); }
    if (r.status !== 200 || !cfg) throw Object.assign(new Error(`openid-configuration: status ${r.status} parses=${out.configParses} ${out.configBodyHead || ''}`), { out });
    const t2 = performance.now();
    const j = await net.fetchTor(cfg.jwks_uri, { headers: { accept: 'application/json' } });
    const jt = await j.text();
    Object.assign(out, { jwksStatus: j.status, jwksBytes: jt.length, jwksMs: Math.round(performance.now() - t2) });
    try { const jj = JSON.parse(jt); out.jwksParses = true; out.jwksKeyCount = jj.keys?.length; out.jwksKids = (jj.keys || []).map((k) => `${k.kty}/${k.alg || ''}/${(k.kid || '').slice(0, 12)}`).slice(0, 6); }
    catch { out.jwksParses = false; out.jwksBodyHead = jt.slice(0, 200); }
    if (j.status !== 200 || !out.jwksParses || !out.jwksKeyCount) throw Object.assign(new Error('jwks check failed ' + JSON.stringify(out)), { out });
    return out;
  });
  // If step failed with a thrown `out`, preserve it
  for (const s of F.steps) if (!s.ok && s.errorRaw && s.name.startsWith('auth.openai')) { /* error text retains status */ }

  // ---- 4. three concurrent discovery requests on the same client ----
  await fstep('3x concurrent github git-upload-pack discovery on one client', async () => {
    const url = 'https://github.com/isomorphic-git/isomorphic-git.git/info/refs?service=git-upload-pack';
    const t = performance.now();
    const one = async (i) => {
      const t1 = performance.now();
      const r = await net.fetchTor(url, { headers: { 'user-agent': 'git/2.43.0' } });
      const reader = r.body.getReader(); let n = 0, head = ''; 
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (!head) head = new TextDecoder('latin1').decode(value.slice(0, 60)); n += value.length; }
      return { i, status: r.status, bytes: n, ms: Math.round(performance.now() - t1), ok: r.status === 200 && head.includes('# service=git-upload-pack') };
    };
    const results = await withDeadline(Promise.allSettled([one(1), one(2), one(3)]), 240000, 'concurrent');
    const mapped = results.map((x) => x.status === 'fulfilled' ? x.value : { error: errText(x.reason) });
    const detail = { wallMs: Math.round(performance.now() - t), results: mapped, identicalSizes: new Set(mapped.map((m) => m.bytes)).size === 1 };
    if (!mapped.every((m) => m.ok)) throw Object.assign(new Error('concurrent failures: ' + JSON.stringify(mapped)), { detail });
    return detail;
  });

  // ---- 3. streaming over time ----
  const drip = async (url) => {
    const t = performance.now();
    const r = await net.fetchTor(url, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(40000) });
    const headersMs = Math.round(performance.now() - t);
    const reader = r.body.getReader(); const arrivals = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; arrivals.push({ atMs: Math.round(performance.now() - t), bytes: value.length }); }
    return { url, status: r.status, headersMs, totalMs: Math.round(performance.now() - t), totalBytes: n, chunkCount: arrivals.length, arrivals, firstChunkMs: arrivals[0]?.atMs, lastChunkMs: arrivals.at(-1)?.atMs, contentLength: r.headers.get('content-length'), transferEncoding: r.headers.get('transfer-encoding') };
  };
  await fstep('streaming: drip endpoint (per-chunk arrival times)', async (st) => {
    const attempts = [];
    const status = async () => { try { return await withDeadline(client.getCircuitStatusString(), 5000, 'status'); } catch (e) { return 'status error: ' + errText(e); } };
    for (const url of ['https://httpbin.dev/drip?duration=4&numbytes=8&delay=0', 'https://httpbin.org/drip?duration=4&numbytes=8&delay=0', 'https://httpbin.dev/drip?duration=4&numbytes=8&delay=0', 'https://httpbin.io/drip?duration=4&numbytes=8&delay=0', 'https://eu.httpbin.org/drip?duration=4&numbytes=8&delay=0', 'https://httpbingo.org/drip?duration=4&numbytes=8&delay=0']) {
      const circuitBefore = await status();
      try {
        const d = await drip(url);
        d.circuitBefore = circuitBefore;
        const spread = (d.lastChunkMs ?? 0) - (d.firstChunkMs ?? 0);
        d.streamedBeforeEof = d.status === 200 && d.chunkCount > 1 && spread > 1500;
        attempts.push(d);
        if (d.streamedBeforeEof) return { usedUrl: url, attempts };
      } catch (e) { attempts.push({ url, circuitBefore, error: errText(e), circuitAfter: await status() }); }
    }
    // Continuous public SSE feeds (no credentials): chunk arrival times over ~8 s, then client-side cancel (never reaches EOF).
    for (const url of ['https://stream.wikimedia.org/v2/stream/recentchange', 'https://sse.dev/test']) {
      const circuitBefore = await status();
      try {
        const t = performance.now(); const resp = await net.fetchTor(url, { headers: { accept: 'text/event-stream', 'user-agent': 'SelfFormingBrowserTest/0.1 (streaming check; https://github.com/)' }, signal: AbortSignal.timeout(40000) });
        const headersMs = Math.round(performance.now() - t); const reader = resp.body.getReader(); const arrivals = []; let n = 0, ended = false;
        while (performance.now() - t < 8000) {
          const r = await withDeadline(reader.read(), 20000, 'sse read');
          if (r.done) { ended = true; break; } n += r.value.length; arrivals.push({ atMs: Math.round(performance.now() - t), bytes: r.value.length });
        }
        await reader.cancel().catch(() => {});
        const d = { kind: 'sse', url, circuitBefore, status: resp.status, contentType: resp.headers.get('content-type'), headersMs, totalBytes: n, chunkCount: arrivals.length, firstChunkMs: arrivals[0]?.atMs, lastChunkMs: arrivals.at(-1)?.atMs, endedByServer: ended, arrivals: arrivals.slice(0, 60), arrivalsTruncated: arrivals.length > 60 };
        d.streamedBeforeEof = resp.status === 200 && !ended && d.chunkCount >= 3 && (d.lastChunkMs - d.firstChunkMs) > 2000;
        attempts.push(d);
        if (d.streamedBeforeEof) return { usedUrl: url, attempts };
      } catch (e) { attempts.push({ kind: 'sse', url, circuitBefore, error: errText(e) }); }
    }
    // Weaker fallback evidence: chunk arrival times of a large GET (shows incremental delivery, not server-side pacing).
    try {
      const big = await drip('https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/package-lock.json');
      attempts.push({ fallbackLargeGet: true, ...big, arrivals: big.arrivals.slice(0, 40), arrivalsTruncated: big.arrivals.length > 40 });
    } catch (e) { attempts.push({ fallbackLargeGet: true, error: errText(e) }); }
    throw Object.assign(new Error('streaming not observed on any endpoint: ' + JSON.stringify(attempts).slice(0, 600)), { detail: { attempts } });
  });

  // ---- 5. circuit recovery observation after the streaming step (retries every ~5 s for up to 100 s) ----
  await fstep('recovery probe: example.com GET on the same client (retry up to 100 s)', async () => {
    const tries = []; const t0 = performance.now();
    while (performance.now() - t0 < 100000) {
      let status; try { status = await withDeadline(client.getCircuitStatusString(), 5000, 'status'); } catch (e) { status = 'status error: ' + errText(e); }
      const t = performance.now();
      try {
        const r = await httpGet(client, 'example.com', '/', { 'User-Agent': 'Mozilla/5.0 (browser-tor-real test)' }, 20000);
        tries.push({ atMs: Math.round(t - t0), circuitBefore: status, ok: r.status === 200, ms: Math.round(performance.now() - t) });
        if (r.status === 200) return { recovered: true, tries };
      } catch (e) { tries.push({ atMs: Math.round(t - t0), circuitBefore: status, error: errText(e), ms: Math.round(performance.now() - t) }); }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw Object.assign(new Error('no successful request within 100 s: ' + JSON.stringify(tries).slice(0, 500)), { detail: { recovered: false, tries } });
  });

  try { await withDeadline(client.close(), 10000, 'close'); } catch {}
  F.totalMs = Math.round(performance.now() - t00); F.done = true; return F;
};
