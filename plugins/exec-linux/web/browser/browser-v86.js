// browser-v86.js — a real-Linux execution environment for Self Forming's browser edition,
// powered by v86 (github.com/copy/v86, BSD-2-Clause): an x86 emulator compiled to WebAssembly
// running a trimmed Alpine Linux (i686) with hooks into OUR filesystem (browser-vfs.js) and OUR
// network transports (cors-rot: Tailscale / Tor plain `connect`).
//
// /workspace in the guest is ALWAYS a live 9P2000.L mount (cache=none) of the page VFS
// /workspace, served on the page by p9-server.js over the virtual NIC (192.168.86.1:564). There
// is no copy-in/copy-out: page edits are visible to the guest's next read and guest writes are
// in the VFS when the command returns (live.sync()). /scratch is a VM-local directory on the
// root fs (fast; reset with the VM). If /workspace cannot be mounted, the command fails with
// code LINUX_WORKSPACE_UNAVAILABLE (retryable) and is never run against a stale or empty
// /workspace; the next command retries the mount.
//
// Public API (ES module):
//
//   createLinuxEnv({ vfs, transport, onStatus, live? }) -> {
//     ready(),                                                 // lazy: load assets + restore
//                                                              //   snapshot (or cold boot)
//     run(command, { cwd, env, onOutput, signal, timeoutMs, graceMs })
//                                                              // -> Promise<{ exitCode, ... }>
//       command: string => bash --noprofile --norc -c; array => direct argv exec.
//       onOutput(stream: "stdout"|"stderr", bytes: Uint8Array) — raw, separate streams.
//       timeout -> { exitCode: 124, timedOut }, abort -> { exitCode: 130, aborted }.
//       Requires bash in the image; otherwise rejects with code LINUX_IMAGE_LACKS_BASH.
//       No /workspace mount -> rejects with code LINUX_WORKSPACE_UNAVAILABLE (retry later).
//     workspace, mountLive(path), diagnose(), health,
//     dispose(),
//   }
//
// The emulator runs in a dedicated **module Worker** (apps/browser/browser-v86-worker.js) so the
// page stays responsive; in environments without Workers (Node tests) it runs in-process. The
// transport always lives here on the main thread — when the emulator is in a Worker, the worker's
// outbound TCP is bridged back over a postMessage stream proxy (open/read/write/close, with
// request-driven reads for backpressure). DNS synthetic-IP mapping stays in the worker/engine.
//
// Assets (libv86 module, v86.wasm, SeaBIOS, the Alpine 9p basefs + flat files, and the gzip'd
// state snapshot) are produced by scripts/build-v86-image.sh and vendored under
// apps/browser/vendor/v86/ (image/ holds alpine-fs.json, flat/, alpine-state.bin.gz). See
// apps/browser/vendor/v86/PROVENANCE.md for versions, checksums and licenses.

import { browserAssetURL } from "./browser-assets.js";
import { createV86Engine } from "./browser-v86-worker.js";
import { createP9Server, P9_HOST, P9_PORT } from "./p9-server.js";

const WORKSPACE = "/workspace";
export const SCRATCH = "/scratch";     // VM-local fast directory (root 9p of the VM; reset with the VM)
const SCRATCH_PREPARE = `mkdir -p ${SCRATCH} 2>/dev/null; chmod 1777 ${SCRATCH} 2>/dev/null`;
const CANCEL_GRACE_MS = 2000;            // TERM -> KILL grace for a cancelled command's group
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const textEncoder = new TextEncoder();
const invalidRequest = (message) => Object.assign(new Error(message), { code: "invalid" });

/** Shell source string -> bash -c; argv array -> direct exec. Validated, never re-quoted. */
export function execRequest(command, cwd = WORKSPACE, env = {}) {
  const request = { cwd, env: {} };
  if (typeof command === "string") Object.assign(request, { mode: "shell", source: command });
  else if (Array.isArray(command)) {
    if (!command.length) throw invalidRequest("argv must not be empty");
    if (command.some((arg) => typeof arg !== "string")) throw invalidRequest("argv elements must be strings");
    if (command[0] === "") throw invalidRequest("argv[0] (the program) must not be empty");
    Object.assign(request, { mode: "argv", argv: [...command] });
  } else throw invalidRequest("command must be a shell source string or an argv array");
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw invalidRequest("cwd must be an absolute guest path");
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(name)) throw invalidRequest(`Invalid environment variable name: ${JSON.stringify(name)}`);
    if (value == null || typeof value === "object") throw invalidRequest(`Environment variable ${name} must be a string`);
    request.env[name] = String(value);
  }
  const nul = [request.source, ...(request.argv || []), cwd, ...Object.values(request.env)].some((v) => typeof v === "string" && v.includes("\0"));
  if (nul) throw invalidRequest("command, cwd and environment values must not contain NUL");
  return request;
}

// ---- live /workspace: 9P2000.L over the virtual NIC ----------------------------------------
// The page serves its VFS with p9-server.js; the transport routes the guest's TCP connection to
// 192.168.86.1:564 to that server (linux-shell.js, or createLinuxEnv itself when no `live` hooks
// are given). The guest mounts it with the 9p TCP transport (module 9pnet_fd, kept by
// scripts/build-v86-image.sh) and cache=none, so page edits are visible on the next guest read
// and guest writes reach the VFS without any copy step.
export const LIVE_9P = Object.freeze({ host: P9_HOST, port: P9_PORT, msize: 524288, cache: "none" });
export const WORKSPACE_UNAVAILABLE = "LINUX_WORKSPACE_UNAVAILABLE";
const LIVE_MOUNT_PATH = /^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/;

/**
 * Guest shell script that makes `guestPath` a live 9p mount of the page VFS export. Idempotent:
 * loads 9pnet_fd if needed; if a mount exists and answers, keeps it ("LIVE9P ok"); if it exists
 * but the connection dropped (EIO), unmounts it and mounts again ("LIVE9P remounted"); otherwise
 * mounts ("LIVE9P mounted"). Exit codes: 0 ok, 3 module missing, 4 mount failed.
 */
export function liveMountScript(guestPath, { msize = LIVE_9P.msize, cache = LIVE_9P.cache, probeSeconds = 10, mountSeconds = 30, prepare = "" } = {}) {
  if (typeof guestPath !== "string" || !LIVE_MOUNT_PATH.test(guestPath) || guestPath.split("/").includes("..")) throw invalidRequest("live mount path must be a simple absolute guest path");
  if (!Number.isInteger(msize) || msize < 4096 || msize > 1 << 20) throw invalidRequest("msize must be an integer between 4096 and 1048576");
  if (!/^(none|mmap|loose|readahead|0x[0-9a-f]{1,2}|[0-9]{1,3})$/.test(String(cache))) throw invalidRequest("unsupported 9p cache mode");
  const { host, port } = LIVE_9P;
  return [
    ...(prepare ? [prepare] : []),
    `p='${guestPath}'`,
    `grep -q '^9pnet_fd ' /proc/modules || insmod "/lib/modules/$(uname -r)/kernel/net/9p/9pnet_fd.ko" || { echo 'LIVE9P error: module 9pnet_fd missing (rebuild the Linux image)' >&2; exit 3; }`,
    `state=mounted`,
    `if grep -q "^${host} $p 9p " /proc/mounts; then`,
    // cache=none: stat/ls go to the server, so a dropped connection shows up as an error at once.
    `  if timeout -s KILL ${probeSeconds} stat -c %i "$p/." >/dev/null 2>&1 && timeout -s KILL ${probeSeconds} ls -a "$p" >/dev/null 2>&1; then echo 'LIVE9P ok'; exit 0; fi`,
    `  umount "$p" 2>/dev/null || umount -l "$p" 2>/dev/null; state=remounted`,
    `fi`,
    `mkdir -p "$p" || { echo 'LIVE9P error: cannot create the mount point' >&2; exit 4; }`,
    `timeout -s KILL ${mountSeconds} mount -t 9p -o trans=tcp,port=${port},version=9p2000.L,cache=${cache},msize=${msize} ${host} "$p" || { echo 'LIVE9P error: mount failed' >&2; exit 4; }`,
    `echo "LIVE9P $state"`,
  ].join("\n");
}

export function createLinuxEnv({ vfs, transport = null, onStatus = () => {}, assets: assetOverrides = null, live = null, createEngine = null } = {}) {
  if (!vfs) throw new Error("createLinuxEnv requires { vfs } (apps/browser/browser-vfs.js)");
  if (live && (typeof live.disconnects !== "function" || typeof live.sync !== "function")) throw new TypeError("live needs { disconnects(), sync(), reset?(), mount? }");
  const status = (phase, detail) => { try { onStatus({ phase, detail }); } catch { /* observers independent */ } };

  // Without `live` hooks (direct users such as tests), serve the page VFS /workspace ourselves and
  // route the guest's 9p connection to it; every other host goes to the given transport.
  let ownP9 = null;
  if (!live) {
    ownP9 = createP9Server(vfs, { root: WORKSPACE });
    const upstream = transport;
    transport = {
      connect: async (host, port, timeoutMs) => {
        if (host === P9_HOST && port === P9_PORT) return ownP9.connect();
        if (!upstream) throw new Error("no network transport");
        return upstream.connect(host, port, timeoutMs);
      },
    };
    live = { disconnects: () => ownP9.stats.disconnects, sync: () => ownP9.sync(), reset: () => ownP9.closeAll() };
  }

  let engine = null;
  let readyPromise = null;
  let disposed = false;
  let runQueue = Promise.resolve();

  // ---- live /workspace state -----------------------------------------------------------------
  // "unmounted" until a command after boot/restart mounts it; "live" while the mount's connection
  // is up (the server's disconnect counter is unchanged since the mount); "unavailable" after a
  // failed mount (commands fail with LINUX_WORKSPACE_UNAVAILABLE; the next command retries).
  const workspace = { mode: "unmounted", detail: "", disconnectsAtMount: -1 };
  function guestRestarted() {
    workspace.mode = "unmounted";
    try { live.reset?.(); } catch { /* best effort */ }
  }

  // ---- lifecycle ----------------------------------------------------------------------------
  async function boot() {
    status("loading", "resolving assets");
    const a = await resolveAssets();
    const merged = assetOverrides ? { ...a, ...assetOverrides } : a;
    status("loading", "loading snapshot");
    const stateBuffer = await loadStateBuffer(merged, status);
    const engineAssets = {
      libv86Url: merged.libv86Url,
      wasmPath: merged.wasmPath,
      biosUrl: merged.biosUrl,
      vgaBiosUrl: merged.vgaBiosUrl,
      basefsUrl: merged.basefsUrl,
      baseUrl: merged.baseUrl,
      stateBuffer,
    };
    // Only override engine DEFAULTS (memory/net) when explicitly provided — a stray `undefined`
    // would clobber the default and break the config-bound snapshot restore.
    if (merged.memoryMB != null) engineAssets.memoryMB = merged.memoryMB;
    if (merged.netType != null) engineAssets.netType = merged.netType;
    // Experimental windowed host->guest TCP for the page-local 9p connection (browser-v86-worker.js
    // windowedSend); off unless assets.localTcp = { window } is given (not measured as a win yet).
    if (merged.localTcp != null) engineAssets.localTcp = merged.localTcp;
    // Diagnostics only: run without the v86 9P Tflush fix.
    if (merged.flushFix === false) engineAssets.flushFix = false;
    engine = await (createEngine ?? makeEngine)({ assets: engineAssets, status, transport });
    await engine.boot();
    guestRestarted();                // fresh VM (snapshot predates any mount): mount before use
  }

  function ready() { return (readyPromise ??= boot()); }

  // ---- run ----------------------------------------------------------------------------------
  // Commands go through the guest dispatcher (browser-v86-worker.js exec protocol), never the
  // serial shell. A string runs as `bash --noprofile --norc -c SOURCE`; an array is exec'd
  // directly as argv. stdout/stderr arrive as separate raw byte streams (Uint8Array).
  //
  // /workspace: before each command the live mount is ensured (prepareWorkspace); after it the
  // page server commits buffered guest writes (live.sync()), including after a confirmed
  // cancellation (partial writes made before cancellation are kept). On timeout/abort the
  // command's process group is TERMed, then KILLed after the grace period and reaped. If
  // cancellation is NOT confirmed the environment is marked unhealthy and every later run fails
  // with a clear error. The VM is never restarted on cancel.
  let unhealthy = null;
  let tokenSeq = 0;
  const unhealthyError = () => Object.assign(new Error(`The Linux environment is unhealthy: ${unhealthy}. It is not reset automatically; reload the page to start a fresh Linux VM.`), { code: "LINUX_UNHEALTHY" });
  const workspaceError = (why) => Object.assign(new Error(`Linux could not mount /workspace (${why}); the command was not run. Try again.`), { code: WORKSPACE_UNAVAILABLE, retryable: true });

  async function runLocked(command, options) {
    const { cwd = WORKSPACE, env = {}, onOutput, signal, timeoutMs = 120000, graceMs = CANCEL_GRACE_MS, cancelAckTimeoutMs } = options || {};
    if (unhealthy) throw unhealthyError();
    if (signal?.aborted) throw abortError();
    const request = execRequest(command, cwd, env);
    const emit = (stream, bytes) => { try { onOutput?.(stream, bytes); } catch { /* independent */ } };
    const note = (text) => emit("stderr", textEncoder.encode(text));

    // The timeout budget includes the mount step (and with it the first-use dispatcher
    // bootstrap): a budget spent before launch means the command is not launched (as a cancel
    // that reaches the dispatcher before pickup).
    const startedAt = Date.now();
    const ws = await prepareWorkspace();
    if (ws === "restarted") return { exitCode: 125, restarted: true };
    if (ws !== "live") throw workspaceError(workspace.detail);
    if (signal?.aborted) throw abortError();
    const remainingMs = timeoutMs > 0 ? timeoutMs - (Date.now() - startedAt) : 0;
    if (timeoutMs > 0 && remainingMs <= 0) return { exitCode: 124, timedOut: true, canceled: true, cancelConfirmed: true, commandExitCode: null, escalated: false };

    const token = `t${++tokenSeq}`;
    let timedOut = false, aborted = false, cancelPromise = null, timer = null, onAbort = null;
    const beginCancel = (why) => {
      if (cancelPromise) return;
      if (why === "timeout") timedOut = true; else aborted = true;
      cancelPromise = engine.cancelExec(token, { graceMs, ackTimeoutMs: cancelAckTimeoutMs }).catch((e) => ({ confirmed: false, error: e }));
    };
    const execPromise = engine.exec(request, emit, token);
    if (timeoutMs > 0) timer = setTimeout(() => beginCancel("timeout"), remainingMs);
    if (signal) { onAbort = () => beginCancel("abort"); signal.addEventListener("abort", onAbort, { once: true }); }
    let result;
    try { result = await execPromise; }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
    const cancel = cancelPromise ? await cancelPromise : null;  // queue stays locked until the ack

    if (result.restarted || result.disposed) { guestRestarted(); return { exitCode: 125, restarted: true }; }
    await syncLive(note);            // buffered guest writes reach the VFS before we return
    if (result.unconfirmed || (cancel && !cancel.confirmed)) {
      unhealthy ??= "cancellation of a command was not confirmed by the guest";
      note(`\n[v86] cancellation was not confirmed; the Linux environment is now unhealthy.\n`);
      return { exitCode: timedOut ? 124 : 130, timedOut, aborted, canceled: true, cancelConfirmed: false };
    }
    if (result.kernelOops) {
      unhealthy ??= "the Linux kernel crashed (oops)";
      note(`\n[v86] the Linux kernel crashed (oops) during this command; its result cannot be trusted. Linux is now unhealthy: reload the page to start a fresh VM.\n`);
      return { exitCode: result.exitCode ?? 125, kernelOops: true };
    }
    if (result.outputIncomplete) note(`\n[v86] output may be incomplete (spool drain timed out)\n`);
    if (result.outputLimit) note(`\n[v86] command stopped: ${result.outputLimit}\n`);
    const detail = { commandExitCode: result.exitCode, escalated: !!result.escalated };
    if (timedOut) return { exitCode: 124, timedOut: true, canceled: true, cancelConfirmed: true, ...detail };
    if (aborted) return { exitCode: 130, aborted: true, canceled: true, cancelConfirmed: true, ...detail };
    if (result.spawnError) return { exitCode: result.exitCode ?? 127, spawnError: result.spawnError };
    if (result.outputLimit) return { exitCode: result.exitCode ?? 125, outputLimit: result.outputLimit };
    return { exitCode: result.exitCode };
  }

  // ---- live /workspace ------------------------------------------------------------------------
  // Before each command: (re)mount /workspace if this VM has not mounted it yet (boot, snapshot
  // restore, VM restart), the last attempt failed, or the server saw a disconnect since the mount
  // (the script probes the mount and remounts after EIO). Creates the VM-local /scratch on the way.
  // Returns "live", "restarted" or "unavailable" (workspace.detail says why).
  async function prepareWorkspace() {
    if (workspace.mode === "live" && live.disconnects() === workspace.disconnectsAtMount) return "live";
    // Engine errors (image lacks bash, dispatcher start, unhealthy) propagate like a run's would.
    const m = await mountLiveLocked(WORKSPACE, { ...live.mount, prepare: SCRATCH_PREPARE });
    if (m.state === "restarted") return "restarted";
    if (m.ok) {
      Object.assign(workspace, { mode: "live", detail: m.state, disconnectsAtMount: live.disconnects() });
      return "live";
    }
    const why = (m.output || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() || `mount script exit ${m.exitCode}`;
    Object.assign(workspace, { mode: "unavailable", detail: why, disconnectsAtMount: -1 });
    status("warn", `/workspace mount failed: ${why}`);
    return "unavailable";
  }
  async function syncLive(note) {
    try { await live.sync(); }
    catch (error) { note(`\n[v86] could not commit guest writes to /workspace: ${error?.message || error}\n`); }
  }

  async function mountLiveLocked(guestPath, options = {}) {
    if (unhealthy) throw unhealthyError();
    const request = execRequest(liveMountScript(guestPath, options), "/", {});
    const chunks = [];
    const result = await engine.exec(request, (stream, bytes) => { chunks.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)); }, `m${++tokenSeq}`);
    if (result.restarted || result.disposed) { guestRestarted(); return { ok: false, state: "restarted", output: chunks.join("") }; }
    const output = chunks.join("");
    const state = /LIVE9P (ok|mounted|remounted)/.exec(output)?.[1] ?? "failed";
    return { ok: result.exitCode === 0 && state !== "failed", state, exitCode: result.exitCode, output };
  }

  // ---- public surface -----------------------------------------------------------------------
  return {
    ready,
    /**
     * Make `guestPath` (e.g. "/mnt/live") a live 9p mount of the page VFS export, remounting if
     * the connection dropped. Resolves { ok, state: "ok"|"mounted"|"remounted"|"failed"|"restarted", output }.
     * Served by the page 9p server (linux-shell.js, or this env's own when no `live` hooks).
     */
    async mountLive(guestPath, options) {
      await ready();
      if (disposed) throw new Error("Linux environment disposed");
      const task = runQueue.then(() => mountLiveLocked(guestPath, options));
      runQueue = task.catch(() => {});
      return task;
    },
    async run(command, options) {
      await ready();
      if (disposed) throw new Error("Linux environment disposed");
      const task = runQueue.then(() => runLocked(command, options));
      runQueue = task.catch(() => {});
      return task;
    },
    async dispose() {
      disposed = true;
      try { await engine?.dispose(); } catch { /* best effort */ }
      try { ownP9?.closeAll(); } catch { /* best effort */ }
      engine = null; readyPromise = null;
    },
    /** { mode: "live"|"unmounted"|"unavailable", detail }: the guest's live /workspace mount. */
    get workspace() { return { mode: workspace.mode, detail: workspace.detail }; },
    /**
     * Diagnostics for a command that does not finish: processes with their kernel wait channel and
     * stack, recent kernel messages and taint, read over the SERIAL console (independent of the
     * command dispatcher, so it works while a dispatcher command hangs), plus the 9P flush-fix
     * counters. Text only; never changes guest state.
     */
    async diagnose(timeoutMs = 20000) {
      if (!engine) return "Linux is not running.";
      const script = "ps -eo pid,ppid,stat,wchan:22,etime,args | grep -v ' \\[' | head -40; for p in $(pgrep -x git; pgrep -f 'git '); do echo \"== $p $(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)\"; cat /proc/$p/stack 2>/dev/null | head -12; done; echo '== dmesg'; dmesg | tail -15; echo \"== tainted $(cat /proc/sys/kernel/tainted)\"";
      let out = "";
      const ran = await Promise.race([engine.run(script, { cwd: "/" }, (chunk) => { out += chunk; }).then(() => true, (e) => { out += `\n[serial run failed: ${e?.message || e}]`; return false; }),
        new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
      let fix = null;
      try { fix = await engine.flushFixStatus?.(); } catch { /* older engine */ }
      return `${out.trim()}${ran ? "" : "\n[serial console did not answer in time]"}\n== flush fix ${JSON.stringify(fix)}`;
    },
    /** { healthy } or { healthy: false, reason } once a cancellation was not confirmed. */
    get health() { return unhealthy ? { healthy: false, reason: unhealthy } : { healthy: true }; },
    // Diagnostics (not part of the documented contract).
    netStats() { return engine?.netStats?.() ?? null; },
    get _engine() { return engine; },
  };
}

function abortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("The command was aborted", "AbortError")
    : Object.assign(new Error("The command was aborted"), { name: "AbortError" });
}

// =============================================================================================
// Asset resolution (browser URLs vs Node file paths) + snapshot (gzip) decompression.
// =============================================================================================
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

async function resolveAssets() {
  if (IS_NODE) {
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const path = (await import("node:path")).default;
    const vdir = fileURLToPath(browserAssetURL("v86/"));
    const img = path.join(vdir, "image");
    return {
      libv86Url: pathToFileURL(path.join(vdir, "libv86.mjs")).href,
      wasmPath: path.join(vdir, "v86.wasm"),
      biosUrl: path.join(vdir, "seabios.bin"),
      vgaBiosUrl: path.join(vdir, "vgabios.bin"),
      basefsUrl: path.join(img, "alpine-fs.json"),
      baseUrl: path.join(img, "flat") + "/",
      stateGzPath: path.join(img, "alpine-state.bin.gz"),
    };
  }
  const u = (p) => browserAssetURL("v86/" + p).href;
  return {
    libv86Url: u("libv86.mjs"),
    wasmPath: u("v86.wasm"),
    biosUrl: u("seabios.bin"),
    vgaBiosUrl: u("vgabios.bin"),
    basefsUrl: u("image/alpine-fs.json"),
    baseUrl: u("image/flat/"),
    stateGzUrl: u("image/alpine-state.bin.gz"),
  };
}

async function loadStateBuffer(a, status) {
  try {
    if (a.stateBuffer) return a.stateBuffer;
    if (a.stateGzPath) {
      const fs = await import("node:fs");
      const zlib = await import("node:zlib");
      if (!fs.existsSync(a.stateGzPath)) return null;
      const raw = zlib.gunzipSync(fs.readFileSync(a.stateGzPath));
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    }
    if (a.stateGzUrl) {
      const resp = await fetch(a.stateGzUrl);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      // DecompressionStream('gzip') is supported in all target browsers (Chrome/Edge 80+,
      // Firefox 113+, Safari 16.4+); stream-inflate the snapshot without blocking.
      const stream = resp.body.pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).arrayBuffer();
    }
  } catch (e) {
    status("warn", "snapshot unavailable, will cold boot: " + (e?.message || e));
    return null;
  }
  return null;
}

// =============================================================================================
// Engine abstraction: a module Worker in the browser, in-process in Node / no-Worker runtimes.
// =============================================================================================
async function makeEngine({ assets, status, transport }) {
  const canWorker = typeof Worker !== "undefined" && typeof document !== "undefined";
  if (canWorker) {
    try { return createWorkerEngine({ assets, status, transport }); }
    catch (e) { status("warn", "Worker engine unavailable (" + (e?.message || e) + "); running in-process"); }
  }
  return createLocalEngine({ assets, status, transport });
}

// In-process engine: the emulator runs on this thread (Node tests, or a browser without Workers).
function createLocalEngine({ assets, status, transport }) {
  const core = createV86Engine({
    assets,
    onStatus: (phase, detail) => status(phase, detail),
    connect: transport ? (host, port, timeoutMs) => transport.connect(host, port, timeoutMs) : null,
  });
  return {
    boot: () => core.boot(),
    run: (command, opts, onOutput) => core.run(command, opts, onOutput),
    exec: (request, onOutput, token) => core.exec(request, onOutput, token),
    cancelExec: (token, opts) => core.cancelExec(token, opts),
    interrupt: () => core.interrupt(),
    cancel: (graceMs) => core.cancel(graceMs),
    restart: () => core.restart(),
    listTree: async (root) => core.listTree(root),   // root-fs inspection (diagnostics/tests)
    readFile: (path) => core.readFile(path),
    saveState: () => core.saveState(),
    netStats: () => core.netStats(),
    flushFixStatus: () => core.flushFixStatus(),
    dispose: () => core.dispose(),
  };
}

// Worker-hosted engine: a module Worker runs the emulator; the transport stays on this thread and
// is bridged to the worker over a postMessage stream proxy (request-driven reads = backpressure).
function createWorkerEngine({ assets, status, transport }) {
  const worker = new Worker(new URL("./browser-v86-worker.js", import.meta.url), { type: "module" });
  let seq = 0;
  const pending = new Map();      // call id -> { resolve, reject, onOutput? }
  const upstreams = new Map();    // sid -> transport stream

  const settle = (id, ok, value) => { const p = pending.get(id); if (!p) return; pending.delete(id); ok ? p.resolve(value) : p.reject(value); };

  worker.onmessage = async (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "status": status(m.phase, m.detail); return;
      case "booted": settle(m.id, true); return;
      case "ack": settle(m.id, true, m.value); return;
      case "run-output": { pending.get(m.id)?.onOutput?.(m.chunk); return; }
      case "run-done": settle(m.id, true, { exitCode: m.exitCode, restarted: m.restarted }); return;
      case "exec-output": { pending.get(m.id)?.onOutput?.(m.stream, m.bytes); return; }
      case "exec-done": settle(m.id, true, m.value); return;
      case "error": settle(m.id, false, Object.assign(new Error(m.message), { code: m.code })); return;
      // transport proxy (worker is the client):
      case "tcp-open": {
        if (!transport) { worker.postMessage({ type: "tcp-error", sid: m.sid, message: "no transport" }); return; }
        try { const s = await transport.connect(m.host, m.port, m.timeoutMs); upstreams.set(m.sid, s); worker.postMessage({ type: "tcp-opened", sid: m.sid }); }
        catch (e) { worker.postMessage({ type: "tcp-error", sid: m.sid, message: String(e?.message || e) }); }
        return;
      }
      case "tcp-write": { try { upstreams.get(m.sid)?.write(m.bytes); } catch { /* broken pipe */ } return; }
      case "tcp-read": {
        const s = upstreams.get(m.sid);
        if (!s) { worker.postMessage({ type: "tcp-end", sid: m.sid }); return; }
        try {
          const chunk = await s.read();
          if (chunk == null) { upstreams.delete(m.sid); worker.postMessage({ type: "tcp-end", sid: m.sid }); }
          else { const copy = chunk.slice ? chunk.slice() : new Uint8Array(chunk); worker.postMessage({ type: "tcp-data", sid: m.sid, bytes: copy }, [copy.buffer]); }
        } catch { upstreams.delete(m.sid); worker.postMessage({ type: "tcp-end", sid: m.sid }); }
        return;
      }
      case "tcp-close": { try { upstreams.get(m.sid)?.close(); } catch { /* ignore */ } upstreams.delete(m.sid); return; }
      default: return;
    }
  };
  worker.onerror = (e) => { for (const [, p] of pending) p.reject(new Error("worker error: " + (e.message || e))); pending.clear(); };

  const call = (type, extra = {}, onOutput = null, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onOutput });
    worker.postMessage({ type, id, ...extra }, transfer);
  });

  return {
    boot: () => call("boot", { assets, wantSerial: false }, null, assets.stateBuffer ? [assets.stateBuffer] : []),
    run: (command, opts, onOutput) => call("run", { command, cwd: opts?.cwd, env: opts?.env }, onOutput),
    exec: (request, onOutput, token) => call("exec", { request, token }, onOutput),
    cancelExec: (token, opts = {}) => call("execCancel", { token, graceMs: opts.graceMs, ackTimeoutMs: opts.ackTimeoutMs }),
    interrupt: () => worker.postMessage({ type: "interrupt" }),
    cancel: (graceMs) => call("cancel", { graceMs }),
    restart: () => call("restart"),
    listTree: (root) => call("list", { root }),
    readFile: (path) => call("readFile", { path }),
    saveState: () => call("saveState"),
    netStats: () => call("netStats"),
    flushFixStatus: () => call("flushFix"),
    async dispose() { try { await call("dispose"); } catch { /* ignore */ } try { worker.terminate(); } catch { /* ignore */ } },
  };
}
