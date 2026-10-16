// browser-v86-worker.js — hosts the v86 x86 → WebAssembly emulator off the UI thread for
// apps/browser/browser-v86.js, and also exports the reusable emulator core so the same code can
// run in-process (Node tests, or a runtime without Workers).
//
// Two surfaces live here:
//
//   1. createV86Engine({ assets, onStatus, onSerial, connect }) -> engine
//      The real driver around a v86 CPU: boot (restore snapshot / cold boot), a serial-console
//      shell with an exit-code marker protocol, root-9p file primitives (image tooling/tests;
//      /workspace itself is a live 9p mount of the page VFS, see browser-v86.js), the
//      in-page DNS + TCP bridge (guest TCP -> `connect(host, port)`), state save, and a fast
//      "restart from the recovery snapshot" used to recover a wedged shell after a timeout.
//      Agent commands do NOT use the serial shell: exec()/cancelExec() drive a resident guest
//      Bash dispatcher over a root-9p mailbox (see "command protocol" below). The serial
//      run()/cancel()/restart() remain for bootstrap, image tooling and tests only.
//
//   2. A module-Worker bootstrap (only active when loaded as a Worker). It wires the engine's
//      `connect` to a postMessage stream proxy so the transport can live on the main thread
//      (open/read/write/close with request-driven reads = backpressure), forwards status and
//      run output, and exposes run/interrupt/restart/list/readFile/saveState/dispose.
//
// The emulator assets (libv86 module, v86.wasm, SeaBIOS, the Alpine 9p basefs + flat files and
// the gzip'd state snapshot) are produced by scripts/build-v86-image.sh and vendored under
// apps/browser/vendor/v86/. See apps/browser/vendor/v86/PROVENANCE.md.

const td = new TextDecoder();

// Serial-shell + boot defaults. The snapshot is CONFIG-BOUND: memory size and net_device type
// must match what the snapshot was saved with, or v86's set_state will reject it.
export const ENGINE_DEFAULTS = {
  memoryMB: 256,
  vgaMemoryMB: 2,
  netType: "virtio", // virtio-net; the guest insmods failover/net_failover/virtio_net at boot
  cmdline:
    "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose " +
    "modules=virtio_pci tsc=reliable console=ttyS0,115200 quiet",
  bootReadyMarker: "V86_BOOT_READY",
  readyTimeoutMs: 120000,
};

// ---- command protocol constants + fixed guest scripts ------------------------------------------
export const EXEC_ROOT = "/.pi-exec";   // root 9p, deliberately not /tmp or /workspace
const BOOTSTRAP_MS = 20000;
const POLL_MS = 25;
const READ_CHUNK = 1 << 20;
const MAX_STREAM_BYTES = 64 * 1024 * 1024; // per stream; exceeding it cancels the command
const PICKUP_MS = 30000;                    // dispatcher must launch a request within this
const DRAIN_MS = 15000;                     // host waits this long for final spool lengths
const DEFAULT_GRACE_MS = 2000;              // TERM -> KILL grace
const KILL_WAIT_MS = 10000;                 // dispatcher waits this long after KILL (200 ticks)
const ACK_SLACK_MS = 15000;                 // emulator scheduling slack for the cancel ack
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function randomToken(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
const invalid = (message) => Object.assign(new Error(message), { code: "invalid" });

/**
 * Validate and encode a command request as NUL-terminated UTF-8 records:
 *   v1, mode, cwd, envCount, NAME=VALUE..., argv elements (argv mode) or the source (shell), end.
 * Embedded NUL is rejected everywhere (it cannot cross execve); env names must be identifiers.
 */
export function encodeExecRequest(request) {
  const { mode, cwd = "/workspace", env = {} } = request || {};
  const fields = [];
  const field = (value, what) => {
    if (typeof value !== "string") throw invalid(`${what} must be a string`);
    if (value.includes("\0")) throw invalid(`${what} must not contain NUL`);
    fields.push(value);
  };
  if (mode !== "shell" && mode !== "argv") throw invalid("exec request mode must be 'shell' or 'argv'");
  field("v1", "version"); field(mode, "mode");
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw invalid("cwd must be an absolute path");
  field(cwd, "cwd");
  const entries = Object.entries(env ?? {});
  field(String(entries.length), "env count");
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw invalid(`Invalid environment variable name: ${JSON.stringify(name)}`);
    if (typeof value !== "string") throw invalid(`environment variable ${name} must be a string`);
    field(`${name}=${value}`, `environment variable ${name}`);
  }
  if (mode === "shell") field(request.source, "shell source");
  else {
    const argv = request.argv;
    if (!Array.isArray(argv) || argv.length === 0) throw invalid("argv must be a non-empty array");
    if (argv[0] === "") throw invalid("argv[0] (the program) must not be empty");
    argv.forEach((arg, i) => field(arg, `argv[${i}]`));
  }
  fields.push("end");                     // trailer: launcher rejects truncated payloads
  return utf8(fields.map((f) => f + "\0").join(""));
}

// Resident dispatcher. Fixed code: request files are only ever read as data, never sourced or
// evaluated. It polls (fork-free `read -t` on a never-written pipe) for ready records while idle
// and for a cancel record while a command runs. Forks are minimised because every fork/exec is
// expensive under emulation.
//
// Launch (function `launch`, run in a forked subshell with fd1/fd2 on the per-run spools):
// NUL records -> positional parameters; cwd/env applied only after parsing (dispatcher globals
// are unset first so request env names cannot clobber launcher state); then
//   argv mode:  exec setsid -- "$@"                       (direct exec, never shell text)
//   shell mode: exec setsid -- /bin/bash --noprofile --norc -c SOURCE
// setsid execs in place (the subshell is not a group leader), so $! = command PID = PGID = SID.
// Launch failures (malformed request, bad cwd, program not found) go to fd 9 (the .spawn record).
//
// Cancel: TERM to the command's own process group (or the leader alone if it is somehow not a
// group leader), bounded grace, KILL to the group, reap. The leader is never reaped before the
// group is signalled, so its PID/PGID cannot be reused meanwhile. Nothing outside the group
// (dispatcher, tmux servers that daemonised into their own sessions) is signalled.
export const DISPATCHER_SH = `#!/bin/bash
# Self Forming browser command dispatcher (fixed code; requests are data, never sourced).
set -u
D=$1
NONCE=$2
exec 8< <(exec sleep 2147483647)
nap() { read -r -t "$1" -u 8 _ 2>/dev/null; return 0; }
declare -A seen=()
active='' pid='' canceled=0 escalated=0 stale=()
proc_stat() {
  local line rest
  { read -r line < "/proc/$1/stat"; } 2>/dev/null || return 1
  rest=\${line##*) }
  set -- $rest
  STATE=$1 PGRP=$3
}
exited() { proc_stat "$1" || return 0; [[ $STATE == Z || $STATE == X ]]; }
signal_cmd() {
  if proc_stat "$pid" && [[ $PGRP == "$pid" ]]; then kill -s "$1" -- "-$pid" 2>/dev/null
  else kill -s "$1" -- "$pid" 2>/dev/null; fi
  return 0
}
finish() {
  local id=$1 st=$2 rc=$3 o=0 e=0 sp=0 sizes
  if [[ $st != notstarted ]]; then
    # Global sync: spools AND the command's buffered writes reach the host before the done record.
    sizes=$(sync 2>/dev/null; stat -c %s -- "$D/$id.out" "$D/$id.err" 2>/dev/null)
    { read -r o; read -r e; } <<< "$sizes"
  fi
  [[ $o =~ ^[0-9]+$ ]] || o=0
  [[ $e =~ ^[0-9]+$ ]] || e=0
  [[ -s $D/$id.spawn ]] && sp=1
  # Kernel taint (fork-free builtin read): bit 128 (D) means the guest kernel oopsed. An oops
  # kills whatever task was running, so results after it cannot be trusted.
  local taint=0; { read -r taint < /proc/sys/kernel/tainted; } 2>/dev/null; [[ $taint =~ ^[0-9]+$ ]] || taint=0
  printf 'v1 %s %s %s %s %s %s %s %s\\n' "$id" "$st" "$rc" "$o" "$e" "$escalated" "$sp" "$taint" > "$D/$id.done"
  active='' pid='' canceled=0 escalated=0
  stale+=("$D/$id".*)
}
launch() {
  exec 9>> "$1.spawn" || exit 126
  local -a __pi_f __pi_env
  local __pi_mode __pi_cwd __pi_n __pi_i __pi_kv
  fail() { printf '%s\\n' "$2" >&9; exit "$1"; }
  mapfile -d '' -t __pi_f < "$1.req" || fail 126 'unreadable request'
  [[ \${__pi_f[0]-} == v1 && \${#__pi_f[@]} -ge 6 && \${__pi_f[-1]} == end ]] || fail 126 'malformed or truncated request'
  __pi_mode=\${__pi_f[1]} __pi_cwd=\${__pi_f[2]} __pi_n=\${__pi_f[3]}
  [[ $__pi_n =~ ^[0-9]+$ ]] || fail 126 'malformed request'
  __pi_i=$((4 + __pi_n))
  __pi_env=("\${__pi_f[@]:4:__pi_n}")
  unset -v '__pi_f[-1]'
  if [[ $__pi_mode == shell ]]; then
    (( \${#__pi_f[@]} == __pi_i + 1 )) || fail 126 'malformed request'
    set -- /bin/bash --noprofile --norc -c "\${__pi_f[__pi_i]}"
  elif [[ $__pi_mode == argv ]]; then
    (( \${#__pi_f[@]} > __pi_i )) || fail 126 'empty argv'
    set -- "\${__pi_f[@]:__pi_i}"
  else fail 126 'malformed request'; fi
  cd -- "$__pi_cwd" 2>/dev/null || fail 126 "working directory not found: $__pi_cwd"
  unset -v D NONCE seen active pid canceled escalated stale STATE PGRP r id ver rid len drop idle
  for __pi_kv in "\${__pi_env[@]}"; do
    [[ \${__pi_kv%%=*} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail 126 'invalid environment variable name'
    export -- "$__pi_kv" 2>/dev/null || fail 126 "cannot set environment variable \${__pi_kv%%=*}"
  done
  if [[ $__pi_mode == argv ]]; then
    if [[ $1 == */* ]]; then [[ -f $1 && -x $1 ]] || fail 127 "not an executable file: $1"
    else type -P -- "$1" > /dev/null || fail 127 "command not found: $1"; fi
  fi
  exec 9>&-
  exec setsid -- "$@"
}
start_run() {
  local id=$1 ver='' rid='' len='' drop=''
  [[ $id =~ ^[A-Za-z0-9-]+$ ]] || return 0
  { read -r ver rid len drop < "$D/$id.ready"; } 2>/dev/null
  [[ $ver == v1 && $rid == "$id" && $len =~ ^[0-9]+$ ]] || return 0   # not complete yet
  seen[$id]=1
  if (( \${#stale[@]} >= 24 )); then rm -f -- "\${stale[@]}"; stale=(); fi
  if [[ -e $D/$id.cancel ]]; then finish "$id" notstarted -1; return 0; fi
  # The host changed root-fs paths behind the guest (engine syncIn; /workspace is a live cache=none
  # mount and never needs this): the root 9p cache=loose page/dentry/inode cache may serve stale
  # content, so drop clean caches (fork-free builtin write). Dirty pages
  # are not dropped (and were already flushed by the global sync at the end of each command).
  if [[ $drop == 1 ]]; then { echo 3 > /proc/sys/vm/drop_caches; } 2>/dev/null; fi
  : > "$D/$id.spawn"
  launch "$D/$id" < /dev/null > "$D/$id.out" 2> "$D/$id.err" 8<&- &
  pid=$! active=$id canceled=0 escalated=0
  printf '%s\\n' "$pid" > "$D/$id.pid"
}
do_cancel() {
  local ver='' rid='' ticks='' i rc
  canceled=1
  { read -r ver rid ticks < "$D/$active.cancel"; } 2>/dev/null
  [[ $ticks =~ ^[0-9]+$ ]] || ticks=40
  signal_cmd TERM
  for ((i = 0; i < ticks; i++)); do exited "$pid" && break; nap 0.05; done
  exited "$pid" || escalated=1
  signal_cmd KILL
  for ((i = 0; i < 200; i++)); do exited "$pid" && break; nap 0.05; done
  if ! exited "$pid"; then finish "$active" killfail -1; return 0; fi
  wait "$pid"; rc=$?
  finish "$active" canceled "$rc"
}
check_active() {
  local rc
  if (( ! canceled )) && [[ -e $D/$active.cancel ]]; then do_cancel; return 0; fi
  if exited "$pid"; then wait "$pid"; rc=$?; finish "$active" exit "$rc"; fi
}
ip link set lo up 2>/dev/null || true   # guest boots with loopback down; idempotent
printf '%s %s\\n' "$NONCE" "$$" > "$D/alive"
idle=0
while :; do
  if [[ -n $active ]]; then check_active; idle=0
  else
    for r in "$D"/*.ready; do
      [[ -f $r ]] || continue
      id=\${r##*/}; id=\${id%.ready}
      [[ -n \${seen[$id]+x} ]] && continue
      start_run "$id"
      [[ -n $active ]] && break
    done
    (( idle < 1000 )) && idle=$((idle + 1))
  fi
  if (( idle > 200 )); then nap 0.2; else nap 0.03; fi
done
`;

// =============================================================================================
// v86 9P Tflush fix (upstream copy/v86#1652, closed unfixed; pinned 94faf3d lib/9p.js case 108).
// v86 answers Tflush with Rflush immediately even while the flushed request is still pending in
// an async handler, and then ALSO sends that request's reply. Linux's virtio-9p transport treats
// an Rflush as "the old reply will not come" (p9_virtio_cancelled drops its reference), so the
// late reply is a use-after-free in the guest kernel: refcount underflow in p9_req_put during
// do_exit, then slab corruption -> an Oops in __kmalloc (the "kernel crashed" seen when a
// process dies with file I/O in flight: Stop/timeout/kill). Measured: crash within 1-4 cancel
// cycles under load before; 60/60 clean cycles (snapshot and cold boot) with this fix.
// Fix (QEMU semantics): hold back an Rflush until the reply to its oldtag has been sent. It wraps
// two methods of THIS emulator instance from the outside; libv86.mjs is not modified. Returns
// false when the pinned internals are not found (then the guard test fails loudly).
// =============================================================================================
export function patch9pFlush(emulator, stats = {}) {
  const dev = emulator?.v86?.cpu?.devices?.virtio_9p;
  if (!dev || !dev.virtio || typeof dev.SendReply !== "function") return false;
  const cpu = emulator.v86.cpu;
  const pending = new Set();      // tags of requests popped but not yet replied
  const flushOld = new Map();     // flush tag -> oldtag
  const deferred = new Map();     // oldtag -> [{ bufchain, bytes }]
  stats.deferred = 0; stats.flushes = 0;

  const vq = dev.virtio.queues[0];
  const origPop = vq.pop_request;
  vq.pop_request = function () {
    const chain = origPop.call(this);
    try {
      const b0 = chain.read_buffers[0];
      const hdr = cpu.read_blob(b0.addr_low, Math.min(9, b0.len));
      if (hdr.length >= 7) {
        const id = hdr[4], tag = hdr[5] | (hdr[6] << 8);
        if (id === 108) {
          let old;
          if (hdr.length >= 9) old = hdr[7] | (hdr[8] << 8);
          else { const b1 = chain.read_buffers[1]; const x = cpu.read_blob(b1.addr_low, 2); old = x[0] | (x[1] << 8); }
          flushOld.set(tag, old); stats.flushes++;
        } else pending.add(tag);
      }
    } catch { /* never break the device */ }
    return chain;
  };

  const origSend = dev.SendReply;
  const release = (tag) => {
    const list = deferred.get(tag);
    if (!list) return;
    deferred.delete(tag);
    for (const { bufchain, bytes } of list) {
      bufchain.set_next_blob(bytes);
      dev.virtqueue.push_reply(bufchain);
      dev.virtqueue.flush_replies();
    }
  };
  dev.SendReply = function (bufchain) {
    const rb = this.replybuffer;
    const id = rb[4], tag = rb[5] | (rb[6] << 8);
    if (id === 109 && flushOld.has(tag)) {
      const old = flushOld.get(tag); flushOld.delete(tag);
      if (pending.has(old)) {
        stats.deferred++;
        const bytes = rb.slice(0, this.replybuffersize);
        if (!deferred.has(old)) deferred.set(old, []);
        deferred.get(old).push({ bufchain, bytes });
        return;
      }
    }
    origSend.call(this, bufchain);
    pending.delete(tag);
    release(tag);
  };
  return true;
}

// =============================================================================================
// Emulator core
// =============================================================================================
export function createV86Engine({ assets = {}, onStatus = () => {}, onSerial = () => {}, connect = null } = {}) {
  const cfg = { ...ENGINE_DEFAULTS, ...assets };

  let emulator = null;
  let net = null;
  let output = "";            // rolling serial capture (bounded)
  const outputListeners = new Set();
  let recoveryState = null;   // ArrayBuffer snapshot captured after boot, reused for fast restart
  let currentRun = null;      // { cancel(reason) } so restart() can settle an in-flight run
  let disposed = false;

  const status = (phase, detail) => { try { onStatus(phase, detail); } catch { /* observers independent */ } };

  function onSerialByte(byte) {
    const ch = String.fromCharCode(byte);
    output += ch;
    if (output.length > 1 << 20) output = output.slice(-(1 << 19));
    for (const l of outputListeners) { try { l(ch); } catch { /* independent */ } }
    try { onSerial(ch); } catch { /* independent */ }
  }

  async function loadV86Class() {
    if (cfg.V86) return cfg.V86;
    if (!cfg.libv86Url) throw new Error("createV86Engine: assets.V86 or assets.libv86Url is required");
    const mod = await import(cfg.libv86Url);
    return mod.V86 || mod.default;
  }

  function baseConfig(V86) {
    const config = {
      wasm_path: cfg.wasmPath,
      bios: { url: cfg.biosUrl },
      vga_bios: { url: cfg.vgaBiosUrl },
      memory_size: cfg.memoryMB * 1024 * 1024,
      vga_memory_size: cfg.vgaMemoryMB * 1024 * 1024,
      filesystem: { basefs: cfg.basefsUrl, baseurl: cfg.baseUrl },
      autostart: true,
      bzimage_initrd_from_filesystem: true,
      cmdline: cfg.cmdline,
      net_device: { type: cfg.netType, relay_url: "fetch" },
      disable_speaker: true,
    };
    return { V86, config };
  }

  // Every emulator instance (boot, cold-boot fallback, restart from the recovery snapshot) gets the
  // 9P Tflush fix before any command can be cancelled; its counters show it is active.
  const flushFix = { applied: false, flushes: 0, deferred: 0 };
  function applyFlushFix() {
    if (cfg.flushFix === false) { flushFix.applied = false; flushFix.disabled = true; return; }   // diagnostics only
    flushFix.applied = patch9pFlush(emulator, flushFix);
    if (!flushFix.applied) status("warn", "9P flush fix could not be applied: a killed process may corrupt the guest kernel");
  }

  async function newEmulator(stateBuffer) {
    const V86 = await loadV86Class();
    const { config } = baseConfig(V86);
    if (stateBuffer) config.initial_state = { buffer: stateBuffer };
    const emu = new V86(config);
    emu.add_listener("serial0-output-byte", onSerialByte);
    return emu;
  }

  async function boot() {
    status("loading");
    const stateBuffer = cfg.stateBuffer || null;
    const restoring = !!stateBuffer;
    status("booting", restoring ? "restoring snapshot" : "cold boot");
    try {
      emulator = await newEmulator(stateBuffer);
      if (restoring) await waitForShellAlive(cfg.readyTimeoutMs);
      else await waitForMarker(cfg.bootReadyMarker, cfg.readyTimeoutMs);
    } catch (e) {
      if (restoring) {
        // Snapshot failed to restore: fall back to a cold boot from the flat files.
        status("booting", "snapshot restore failed, cold booting: " + (e?.message || e));
        try { await emulator?.destroy?.(); } catch { /* best effort */ }
        output = "";
        emulator = await newEmulator(null);
        await waitForMarker(cfg.bootReadyMarker, cfg.readyTimeoutMs);
      } else {
        throw e;
      }
    }
    installNetwork();
    applyFlushFix();
    // Capture a recovery snapshot so a wedged shell can be restarted in ~a few hundred ms.
    try { recoveryState = await emulator.save_state(); } catch { recoveryState = null; }
    status("ready");
  }

  function waitForMarker(marker, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (output.includes(marker)) return resolve();
      const deadline = Date.now() + timeoutMs;
      let acc = "";
      const unsub = (ch) => {
        acc += ch;
        if (acc.includes(marker)) { outputListeners.delete(unsub); resolve(); }
        else if (Date.now() > deadline) { outputListeners.delete(unsub); reject(new Error("v86 boot timed out")); }
      };
      outputListeners.add(unsub);
    });
  }

  // Send `echo <token>` and resolve true if the shell echoes it back within `attemptMs`.
  function probeOnce(attemptMs) {
    const token = "ALIVE" + Math.random().toString(36).slice(2, 8);
    const start = output.length;
    sendRaw(`echo ${token}\n`);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (output.indexOf(token, start) >= 0) return resolve(true);
        if (Date.now() - t0 > attemptMs) return resolve(false);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  async function probeAlive(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do { if (await probeOnce(Math.min(2000, timeoutMs))) return true; } while (Date.now() < deadline);
    return false;
  }

  async function waitForShellAlive(timeoutMs) {
    if (!(await probeAlive(timeoutMs))) throw new Error("v86 shell did not respond");
  }

  function sendRaw(s) {
    const CHUNK = 512; // keep the UART ring from overflowing on large pastes
    for (let i = 0; i < s.length; i += CHUNK) emulator.serial0_send(s.slice(i, i + CHUNK));
  }

  // ---- shell: exit-code marker protocol -----------------------------------------------------
  function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  /**
   * Run one command. Streams the merged stdout+stderr (2>&1) body between markers to onOutput.
   * Resolves { exitCode } on completion, or { exitCode: null, restarted: true } if restart()
   * tore the VM down mid-command (the caller maps that to a timeout/abort code).
   */
  function run(command, { cwd = "/workspace", env = {} } = {}, onOutput) {
    const id = Math.random().toString(36).slice(2, 10);
    const beginMark = `@@V86BEG@@${id}@@`;
    const endMark = `@@V86END@@${id}@@`;
    const envExports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}; `).join("");
    // The login shell has a controlling tty + job control (see /sbin/init `setsid -c sh`), so the
    // subshell runs as its own foreground process group: a Ctrl-C delivers SIGINT to the whole
    // group. Print a BEGIN marker, the command's merged (2>&1) output, then END + $?.
    const line =
      `printf '\\n${beginMark}\\n'; ( cd ${shellQuote(cwd)} && ${envExports}{ ${command}; } ) 2>&1; ` +
      `printf '\\n${endMark}%d@@\\n' "$?"\n`;

    const start = output.length;
    let emittedUpTo = -1;
    const endRe = new RegExp(endMark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)@@");
    sendRaw(line);

    return new Promise((resolve) => {
      let timer = null;
      let cancelled = false;
      const cleanup = () => { if (timer) clearTimeout(timer); if (currentRun === self) currentRun = null; };
      const self = { resolve(v) { if (cancelled) return; cancelled = true; cleanup(); resolve(v); } };
      currentRun = self;
      const poll = () => {
        if (cancelled) return;
        const slice = output.slice(start);
        const beg = slice.indexOf(beginMark);
        const endMatch = endRe.exec(slice);
        if (onOutput && beg >= 0) {
          const bodyStart = start + beg + beginMark.length + 1; // +1 for the trailing newline
          const bodyEnd = endMatch ? start + endMatch.index : output.length - endMark.length;
          if (bodyEnd > Math.max(bodyStart, emittedUpTo)) {
            const from = Math.max(bodyStart, emittedUpTo < 0 ? bodyStart : emittedUpTo);
            const chunk = output.slice(from, bodyEnd);
            if (chunk) { try { onOutput(chunk); } catch { /* independent */ } emittedUpTo = bodyEnd; }
          }
        }
        if (endMatch) { cleanup(); resolve({ exitCode: parseInt(endMatch[1], 10) }); return; }
        timer = setTimeout(poll, 25);
      };
      poll();
    });
  }

  function interrupt() {
    // Deliver Ctrl-C (SIGINT) to the foreground process group via the controlling tty.
    try { sendRaw("\u0003"); } catch { /* best effort */ }
  }

  /**
   * Cancel the in-flight command. Sends Ctrl-C, then confirms the shell is back at a prompt. On a
   * Ctrl-C the interactive shell kills the foreground job but abandons the rest of the command
   * line (our END marker never prints), so we don't wait for it — we probe liveness instead. If
   * the shell doesn't recover within graceMs we fall back to a VM restart. Settles the pending
   * run() first so streaming stops. Returns { recovered } (false => the VM was restarted).
   */
  async function cancel(graceMs = 2500) {
    const run = currentRun;
    currentRun = null;
    if (run) run.resolve({ exitCode: null, cancelled: true });
    interrupt();
    if (await probeAlive(graceMs)) return { recovered: true };
    await restart();
    return { recovered: false };
  }

  async function restart() {
    // Fast recovery: tear the CPU down and restore the post-boot snapshot captured in boot(). The
    // in-flight run is settled only AFTER the VM is ready again, so callers that await run() do
    // not advance into a half-rebuilt emulator.
    const run = currentRun;
    currentRun = null;
    const prev = emulator;
    emulator = null; net = null;
    try { await prev?.destroy?.(); } catch { /* best effort */ }
    output = "";
    if (!recoveryState) {
      await boot();
    } else {
      emulator = await newEmulator(recoveryState);
      await waitForShellAlive(cfg.readyTimeoutMs);
      installNetwork();
      applyFlushFix();
    }
    if (run) run.resolve({ exitCode: null, restarted: true });
    resetCommandChannel({ exitCode: null, restarted: true });
  }

  // ---- 9p filesystem bridge -----------------------------------------------------------------
  const S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFMT = 0xf000;
  function fs9p() { const f = emulator?.fs9p; if (!f) throw new Error("9p filesystem is not available"); return f; }

  function ensureDir(path) {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      const parent = cur || "/";
      cur += "/" + p;
      if (fs9p().SearchPath(cur).id === -1) {
        const psp = fs9p().SearchPath(parent);
        fs9p().CreateDirectory(p, psp.id === -1 ? 0 : psp.id);
      }
    }
  }

  /** Root-fs copy-in for image tooling/tests (alpine-toolset): create/overwrite guest files, make
   *  dirs, delete removed paths. Not used for /workspace (a live 9p mount of the page VFS); a later
   *  exec should pass request.dropCaches so the root 9p cache=loose does not serve stale data. */
  async function syncIn({ files = [], mkdirs = [], removes = [] } = {}) {
    for (const d of [...mkdirs].sort()) ensureDir(d);
    const dirs = new Set();
    for (const { path } of files) { const d = path.slice(0, path.lastIndexOf("/")); if (d) dirs.add(d); }
    for (const d of [...dirs].sort()) ensureDir(d);
    for (const { path, bytes } of files) {
      // Replace, don't overlay: libv86 create_file on an existing name relinks the name to a new
      // inode without unlinking the old one. Unlink first (POSIX replace semantics: processes
      // that hold the old file open keep the old inode).
      removeGuestPath(path);
      await emulator.create_file(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
    for (const path of removes) removeGuestPath(path);
    return files.length;
  }

  // Pinned libv86 fs9p.DeleteNode(path) is broken (it calls Unlink(parentid, undefined) and
  // throws), so host-side removals never reached the guest. Unlink explicitly, depth-first.
  function removeGuestPath(path) {
    const f = fs9p();
    const sp = f.SearchPath(path);
    if (sp.id === -1 || sp.parentid === -1) return false;
    if ((f.GetInode(sp.id).mode & S_IFMT) === S_IFDIR) {
      for (const name of f.read_dir(path) || []) removeGuestPath(`${path}/${name}`);
    }
    const rc = f.Unlink(sp.parentid, path.slice(path.lastIndexOf("/") + 1));
    if (rc < 0) throw new Error(`could not remove guest path ${path} (${rc})`);
    return true;
  }

  /** List guest regular files + directories under root with size + mtime for diffing. */
  function listTree(root) {
    const out = [];
    const visit = (dir) => {
      const names = fs9p().read_dir(dir) || [];
      for (const name of names) {
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        const sp = fs9p().SearchPath(full);
        if (sp.id === -1) continue;
        const inode = fs9p().GetInode(sp.id);
        const fmt = inode.mode & S_IFMT;
        if (fmt === S_IFDIR) { out.push({ path: full, kind: "directory" }); visit(full); }
        else if (fmt === S_IFREG) out.push({ path: full, kind: "file", size: inode.size, mtimeMs: (inode.mtime || 0) * 1000 });
      }
    };
    if (fs9p().SearchPath(root).id !== -1) visit(root);
    return out;
  }

  async function readFile(path) {
    const bytes = await emulator.read_file(path);
    return bytes || null;
  }

  async function saveState() { return emulator.save_state(); }

  // ---- command protocol: resident guest Bash dispatcher + root-9p mailbox ------------------
  // The serial shell is used ONCE, to start a fixed dispatcher script stored on the root 9p
  // filesystem (EXEC_ROOT, outside /tmp and /workspace). Every command is then a pair of host
  // files: an immutable NUL-delimited request payload, followed by a separate ready record that
  // is published last. The dispatcher launches the command in its own session/process group with
  // fd1/fd2 redirected to separate regular spool files that the host tails by byte offset
  // (fs9p.Read(inode, offset, count)); a final done record carries the exit status and final
  // spool lengths, which the host drains exactly. Cancellation is a separate cancel record the
  // dispatcher polls while the command runs: TERM to the command's own group, bounded grace,
  // KILL, reap, then the done record acts as the acknowledgement. The VM is never restarted.
  let execDir = null;
  let dispatcherReady = null;
  let unhealthy = null;            // sticky reason string once the command channel is unconfirmed
  let execSeq = 0;
  const execs = new Map();         // token -> active exec state

  function nodeOf(path) {
    const sp = fs9p().SearchPath(path);
    if (sp.id === -1) return null;
    return { id: sp.id, inode: fs9p().GetInode(sp.id) };
  }
  async function readRange(id, offset, count) {
    if (count <= 0) return new Uint8Array(0);
    const bytes = await fs9p().Read(id, offset, count);
    return bytes ? bytes.slice() : new Uint8Array(0); // copy: Read may return a live subarray
  }
  async function readSmall(path) {
    const n = nodeOf(path);
    if (!n) return null;
    return readRange(n.id, 0, n.inode.size || 0);
  }

  function channelError(message, code) { return Object.assign(new Error(message), { code }); }
  function unhealthyError() {
    return channelError(`The Linux command channel is unhealthy (${unhealthy}). It is not restarted automatically; reload the page to start a fresh Linux VM.`, "LINUX_UNHEALTHY");
  }
  function markUnhealthy(reason) { if (!unhealthy) unhealthy = reason; status("warn", "Linux command channel unhealthy: " + reason); }

  function requireBash() {
    const bash = nodeOf("/bin/bash");
    if (!bash || (bash.inode.mode & S_IFMT) !== S_IFREG) {
      throw channelError("This Linux image lacks bash (/bin/bash), which the browser command protocol requires; update the Linux image (vendor/v86) to a build that includes bash.", "LINUX_IMAGE_LACKS_BASH");
    }
    if (!nodeOf("/usr/bin/setsid") && !nodeOf("/bin/setsid")) {
      throw channelError("This Linux image lacks setsid, which the browser command protocol requires; update the Linux image.", "LINUX_IMAGE_LACKS_SETSID");
    }
  }

  async function startDispatcher() {
    requireBash();
    const nonce = randomToken(12);
    const dir = `${EXEC_ROOT}/${nonce}`;
    ensureDir(dir);
    await emulator.create_file(`${dir}/dispatcher.sh`, utf8(DISPATCHER_SH));
    // One bounded bootstrap over serial; `& true` keeps run()'s appended `;` valid.
    const boot = run(`setsid /bin/bash --noprofile --norc ${dir}/dispatcher.sh ${dir} ${nonce} </dev/null >/dev/null 2>>${dir}/dispatcher.log & true`, { cwd: "/" });
    const r = await Promise.race([boot, sleep(BOOTSTRAP_MS).then(() => null)]);
    if (!r || r.exitCode !== 0) throw channelError("Could not start the guest command dispatcher over the serial console", "LINUX_DISPATCHER");
    const deadline = Date.now() + BOOTSTRAP_MS;
    while (Date.now() < deadline) {
      const alive = await readSmall(`${dir}/alive`);
      if (alive && td.decode(alive).startsWith(nonce + " ")) { execDir = dir; return; }
      await sleep(POLL_MS);
    }
    const log = await readSmall(`${dir}/dispatcher.log`);
    throw channelError("The guest command dispatcher did not report ready" + (log?.length ? ": " + td.decode(log).slice(-500) : ""), "LINUX_DISPATCHER");
  }

  function resetCommandChannel(result) {
    dispatcherReady = null; execDir = null;
    for (const st of execs.values()) { st.abandon = result; st.ack.resolve(false); }
  }

  /**
   * Run one command through the dispatcher. request = { mode: "shell", source } (bash -c) or
   * { mode: "argv", argv } (direct exec), plus { cwd, env }. onOutput(stream, Uint8Array) gets
   * raw stdout/stderr bytes. Resolves { exitCode, status, canceled, escalated, spawnError, ... }.
   * `token` lets cancelExec() address this run (control bypasses any caller queue).
   */
  async function exec(request, onOutput = () => {}, token = `local-${execSeq + 1}`) {
    if (unhealthy) throw unhealthyError();
    const payload = encodeExecRequest(request);
    if (!emulator) throw channelError("Linux VM is not running", "LINUX_DISPOSED");
    if (execs.has(token)) throw channelError("Duplicate exec token", "invalid");
    // Registered synchronously, BEFORE the (first-use, multi-second) dispatcher bootstrap: a
    // timeout/abort that arrives meanwhile must stop the run from launching. Previously such a
    // cancel found no registered run and was silently dropped, so e.g. a first command
    // `sleep 600` with a 1 s timeout ran to completion.
    const st = { id: null, token, base: null, out: 0, err: 0, abandon: null, cancel: null, limit: null, ack: deferred() };
    execs.set(token, st);
    try {
      await (dispatcherReady ??= startDispatcher().catch((e) => { dispatcherReady = null; throw e; }));
      if (unhealthy) throw unhealthyError();
      if (st.cancel) return { exitCode: null, status: "notstarted", canceled: true, escalated: false, stdoutBytes: 0, stderrBytes: 0 };
      st.id = `r${++execSeq}-${randomToken(8)}`;
      st.base = `${execDir}/${st.id}`;  // from here on, cancels go through the guest's .cancel file
      const { id } = st;
      await emulator.create_file(`${st.base}.req`, payload);                          // immutable payload first
      await emulator.create_file(`${st.base}.ready`, utf8(`v1 ${id} ${payload.length} ${request.dropCaches ? 1 : 0}\n`)); // ready record last
      return await pollExec(st, onOutput);
    } finally { execs.delete(token); st.ack.resolve(false); }
  }

  async function pump(st, onOutput, finalOut = Infinity, finalErr = Infinity) {
    for (const [stream, key, final] of [["stdout", "out", finalOut], ["stderr", "err", finalErr]]) {
      const n = nodeOf(`${st.base}.${key}`);
      if (!n) continue;
      const target = Math.min(n.inode.size || 0, final);
      while (st[key] < target) {
        const chunk = await readRange(n.id, st[key], Math.min(READ_CHUNK, target - st[key]));
        if (!chunk.length) break;
        st[key] += chunk.length;
        try { onOutput(stream, chunk); } catch { /* observer independent */ }
      }
    }
    if (!st.limit && (st.out > MAX_STREAM_BYTES || st.err > MAX_STREAM_BYTES)) {
      st.limit = `output exceeded ${MAX_STREAM_BYTES} bytes on one stream`;
      void cancelExec(st.token);
    }
  }

  async function readDone(st) {
    const bytes = await readSmall(`${st.base}.done`);
    if (!bytes?.length) return null;
    const text = td.decode(bytes);
    if (!text.endsWith("\n")) return null;                // still being written; retry
    const f = text.trim().split(" ");
    if (f.length !== 9 || f[0] !== "v1" || f[1] !== st.id) return null;
    return { status: f[2], rc: Number(f[3]), outLen: Number(f[4]), errLen: Number(f[5]), escalated: f[6] === "1", spawn: f[7] === "1", taint: Number(f[8]) || 0 };
  }

  async function pollExec(st, onOutput) {
    const started = Date.now();
    let launched = false;
    for (;;) {
      if (st.abandon) return st.abandon;
      if (disposed || !emulator) return { exitCode: null, disposed: true };
      await pump(st, onOutput);
      const done = await readDone(st);
      if (done) {
        st.ack.resolve(true);
        const drained = await drain(st, onOutput, done);
        const result = {
          exitCode: done.rc >= 0 ? done.rc : null, status: done.status,
          canceled: done.status === "canceled" || done.status === "notstarted",
          escalated: done.escalated, stdoutBytes: st.out, stderrBytes: st.err,
        };
        if (!drained) result.outputIncomplete = true;
        if (st.limit) result.outputLimit = st.limit;
        if (done.spawn) {
          const why = await readSmall(`${st.base}.spawn`);
          result.spawnError = td.decode(why || new Uint8Array()).trim() || "command could not be started";
        }
        if (done.status === "killfail") markUnhealthy("a cancelled command's process did not exit after SIGKILL");
        // Guest kernel oops (taint D): it kills the task that was running and leaves the kernel
        // in an undefined state. Never let that pass as an ordinary exit code.
        if (done.taint & 128) { result.kernelOops = true; markUnhealthy("the guest Linux kernel crashed (oops)"); }
        return result;
      }
      if (!launched) {
        if (nodeOf(`${st.base}.pid`)) launched = true;
        else if (Date.now() - started > PICKUP_MS && !st.cancel) {
          // Dispatcher is not picking up requests. Ask it not to launch this one, then wait for an ack.
          void cancelExec(st.token);
        }
      }
      await sleep(POLL_MS);
    }
  }

  async function drain(st, onOutput, done) {
    const deadline = Date.now() + DRAIN_MS;
    for (;;) {
      await pump(st, onOutput, done.outLen, done.errLen);
      if (st.out >= done.outLen && st.err >= done.errLen) return true;
      if (Date.now() > deadline || st.abandon || !emulator) return false;
      await sleep(POLL_MS);
    }
  }

  /** Request cancellation of the run addressed by token. Resolves { confirmed } once the guest
   *  acknowledged (TERM, grace, KILL, reap) or the ack timed out (channel marked unhealthy). */
  function cancelExec(token, { graceMs = DEFAULT_GRACE_MS, ackTimeoutMs } = {}) {
    const st = execs.get(token);
    if (!st) return Promise.resolve({ confirmed: true, finished: true });
    // Not published to the guest yet (dispatcher still starting): exec() sees st.cancel and
    // returns "notstarted" without launching, so nothing needs to be signalled.
    if (!st.base) return (st.cancel ??= Promise.resolve({ confirmed: true, notStarted: true }));
    st.cancel ??= (async () => {
      const ticks = Math.max(1, Math.ceil(graceMs / 50));
      try { await emulator.create_file(`${st.base}.cancel`, utf8(`v1 ${st.id} ${ticks}\n`)); }
      catch (e) { markUnhealthy("could not publish a cancel request: " + (e?.message || e)); }
      const wait = ackTimeoutMs ?? graceMs + KILL_WAIT_MS + ACK_SLACK_MS;
      const confirmed = await Promise.race([st.ack.promise, sleep(wait).then(() => false)]);
      if (!confirmed && !st.abandon) {
        markUnhealthy("cancellation of a command was not acknowledged by the guest");
        st.abandon = { exitCode: null, canceled: true, unconfirmed: true };
      }
      return { confirmed: !!confirmed && !st.abandon?.unconfirmed };
    })();
    return st.cancel;
  }

  // ---- network bridge -----------------------------------------------------------------------
  function installNetwork() {
    const adapter = emulator?.network_adapter;
    if (!adapter) { status("warn", "no network adapter"); return; }
    net = createNetworkBridge(adapter, connect, status, cfg.localTcp ?? LOCAL_TCP_TUNING);
  }

  async function dispose() {
    disposed = true;
    resetCommandChannel({ exitCode: null, disposed: true });
    if (currentRun) currentRun.resolve({ exitCode: null, restarted: true });
    try { await emulator?.destroy?.(); } catch { /* best effort */ }
    emulator = null; net = null; recoveryState = null;
  }

  return {
    boot, run, interrupt, cancel, restart, exec, cancelExec,
    get health() { return unhealthy ? { healthy: false, reason: unhealthy } : { healthy: true }; },
    syncIn, listTree, readFile, saveState, dispose,
    onSerial(listener) { outputListeners.add(listener); return () => outputListeners.delete(listener); },
    netStats() { return net?.stats?.() ?? null; },
    /** { applied, flushes, deferred }: the v86 9P Tflush fix on the current emulator. */
    flushFixStatus() { return { ...flushFix }; },
    get disposed() { return disposed; },
    get _emulator() { return emulator; },
  };
}

// =============================================================================================
// Network bridge: v86 FetchNetworkAdapter in-page fake TCP/IP stack + our transport + in-page DNS.
// =============================================================================================
export function createNetworkBridge(adapter, connect, status = () => {}, tuning = LOCAL_TCP_TUNING) {
  // We own DNS so hostnames survive to the transport (Tor prefers names): each A query gets a
  // fresh synthetic IP from 10.99.0.0/16; on_tcp_connection maps the synthetic dest IP back.
  adapter.dns_method = "static";
  const synthByHost = new Map();
  const hostBySynth = new Map();
  let counter = 0;
  const stats = { dnsAnswers: 0, connections: 0, bytesToGuest: 0, bytesFromGuest: 0, failures: 0, windowed: 0, retransmits: 0 };
  tuning = { ...tuning, stats };

  function allocIp(host) {
    let ip = synthByHost.get(host);
    if (ip) return ip;
    counter++;
    ip = `10.99.${(counter >> 8) & 0xff}.${counter & 0xff}`;
    synthByHost.set(host, ip);
    hostBySynth.set(ip, host);
    return ip;
  }

  const origSend = adapter.send.bind(adapter);
  adapter.send = (data) => {
    try {
      const q = parseDnsQuery(data);
      if (q) { const reply = buildDnsResponse(q, allocIp); if (reply) { stats.dnsAnswers++; adapter.receive(reply); return; } }
    } catch { /* fall through to the normal stack */ }
    origSend(data);
  };

  adapter.on_tcp_connection = (conn, packet) => {
    if (conn.state !== "established") conn.accept(packet);
    const destIp = Array.from(conn.psrc).join(".");
    const host = hostBySynth.get(destIp) || destIp;
    if (host === LOCAL_SERVICE_HOST && tuning.window > 0) stats.windowed += windowedSend(conn, tuning) ? 1 : 0;
    bridgeConnection(conn, host, conn.sport, connect, status, stats);
    return true;
  };

  return { stats: () => ({ ...stats }), synthByHost, hostBySynth };
}

// Page-local services live at the virtual router address (the page's 9p server for the live
// /workspace mount). v86's fake TCP stack sends host->guest data stop-and-wait: one segment, then
// nothing until the guest ACKs it, which caps a 9p read at a few hundred KB/s. For connections to
// the router address only, and only when asked (assets.localTcp.window > 0; off by default and not
// yet shown to help end to end), keep up to `window` bytes in flight instead (below the guest's
// advertised receive window, never more than 32 KiB: 64 KiB overran the guest and stalled), with
// go-back-N retransmission when the guest makes no ACK progress for `rtoMs` (v86 itself never
// retransmits). This replaces pump() on the connection INSTANCE (libv86.mjs is not modified); it
// reuses the original pump() to encode each segment by presenting it a one-segment view of the
// send buffer. Remote (network) connections keep the stock behaviour.
export const LOCAL_SERVICE_HOST = "192.168.86.1";
export const LOCAL_TCP_TUNING = Object.freeze({ window: 0, rtoMs: 200 });   // window 0 = stock v86 (the default)

export function windowedSend(conn, { window = 32768, rtoMs = LOCAL_TCP_TUNING.rtoMs, stats = null } = {}) {
  const origPump = conn.pump;
  const buf0 = conn.send_buffer, chunk = conn.send_chunk_buf;
  // Only for the ring-buffer layout this was written against (libv86 GrowableRingbuffer).
  if (typeof origPump !== "function" || !buf0 || !(buf0.buffer instanceof Uint8Array) || typeof buf0.tail !== "number" || !(chunk instanceof Uint8Array)) return false;
  let sentEnd = conn.seq, rto = null;
  conn.pump = function windowedPump() {
    const buf = this.send_buffer, realSeq = this.seq;
    if (!(sentEnd - realSeq >= 0)) sentEnd = realSeq;           // ACKed past what we tracked
    const guestWindow = Math.max(chunk.length, (this.last?.tcp?.winsize ?? 0) - chunk.length);
    const limit = Math.min(window, guestWindow);
    while (buf.length && sentEnd - realSeq < buf.length && sentEnd - realSeq < limit) {
      const off = sentEnd - realSeq;
      const n = Math.min(chunk.length, buf.length - off, Math.max(1, limit - off));
      const view = { length: n, peek(target) {
        const cap = buf.buffer.length, start = (buf.tail + off) % cap;
        for (let i = 0; i < n; i++) target[i] = buf.buffer[(start + i) % cap];
        return n;
      } };
      this.send_buffer = view; this.seq = sentEnd; this.pending = false;
      try { origPump.call(this); } finally { this.send_buffer = buf; this.seq = realSeq; }
      sentEnd += n;
    }
    this.pending = sentEnd !== realSeq;
    if (this.pending && !rto) {
      const armedAt = this.seq;
      rto = setTimeout(() => {
        rto = null;
        if (this.state === "closed" || !this.pending) return;
        if (this.seq === armedAt) { sentEnd = this.seq; if (stats) stats.retransmits++; }   // no progress: go back
        this.pump();
      }, rtoMs);
    }
  };
  return true;
}

function bridgeConnection(conn, host, port, connect, status, stats) {
  stats.connections++;
  if (!connect) { status("warn", `no transport; refusing ${host}:${port}`); try { conn.close(); } catch {} return; }
  let upstream = null;
  let closed = false;
  const pending = [];
  conn.on("data", (data) => { stats.bytesFromGuest += data.length; if (upstream) upstream.write(data); else pending.push(data.slice()); });
  conn.on("shutdown", () => { if (upstream) try { upstream.close(); } catch {} });
  conn.on("close", () => { closed = true; if (upstream) try { upstream.close(); } catch {} });
  (async () => {
    try {
      upstream = await connect(host, port, 30000);
      for (const d of pending) upstream.write(d);
      pending.length = 0;
      if (closed) { try { upstream.close(); } catch {} return; }
      for (;;) {
        const chunk = await upstream.read();
        if (chunk === undefined || chunk === null) break;
        if (chunk.length) { stats.bytesToGuest += chunk.length; conn.write(chunk); }
      }
      conn.close();
    } catch (e) {
      stats.failures++;
      status("warn", `connect ${host}:${port} failed: ${e?.message || e}`);
      try { conn.close(); } catch {}
    }
  })();
}

// ---- minimal DNS over UDP over IPv4 over Ethernet ------------------------------------------
function parseDnsQuery(frame) {
  if (frame.length < 14 + 20 + 8 + 12) return null;
  if (frame[12] !== 0x08 || frame[13] !== 0x00) return null; // IPv4
  const ihl = (frame[14] & 0x0f) * 4;
  if (frame[14 + 9] !== 17) return null; // UDP
  const udp = 14 + ihl;
  const dport = (frame[udp + 2] << 8) | frame[udp + 3];
  if (dport !== 53) return null;
  const dns = udp + 8;
  const flags = (frame[dns + 2] << 8) | frame[dns + 3];
  if (flags & 0x8000) return null;
  const qd = (frame[dns + 4] << 8) | frame[dns + 5];
  if (qd < 1) return null;
  let off = dns + 12;
  const questions = [];
  for (let i = 0; i < qd; i++) {
    const labels = [];
    let guard = 0;
    while (frame[off] !== 0) {
      const len = frame[off];
      if (len > 63 || off + 1 + len > frame.length || guard++ > 128) return null;
      labels.push(td.decode(frame.subarray(off + 1, off + 1 + len)));
      off += 1 + len;
    }
    off += 1;
    const qtype = (frame[off] << 8) | frame[off + 1];
    off += 4;
    questions.push({ name: labels.join("."), qtype });
  }
  return {
    ethSrc: frame.subarray(6, 12),
    ethDst: frame.subarray(0, 6),
    ipSrc: frame.subarray(14 + 12, 14 + 16),
    ipDst: frame.subarray(14 + 16, 14 + 20),
    udpSport: (frame[udp] << 8) | frame[udp + 1],
    dnsId: (frame[dns] << 8) | frame[dns + 1],
    questionBytes: frame.subarray(dns + 12, off),
    questions,
  };
}

function buildDnsResponse(q, allocIp) {
  const answers = [];
  for (const question of q.questions) {
    if (question.qtype === 1) answers.push({ ip: allocIp(question.name).split(".").map((n) => parseInt(n, 10)) });
  }
  const dnsBody = [];
  const push16 = (arr, n) => { arr.push((n >> 8) & 0xff, n & 0xff); };
  push16(dnsBody, q.dnsId);
  push16(dnsBody, 0x8180);
  push16(dnsBody, q.questions.length);
  push16(dnsBody, answers.length);
  push16(dnsBody, 0); push16(dnsBody, 0);
  for (const b of q.questionBytes) dnsBody.push(b);
  for (const a of answers) {
    dnsBody.push(0xc0, 0x0c);
    push16(dnsBody, 1); push16(dnsBody, 1);
    dnsBody.push(0, 0, 0x02, 0x58);
    push16(dnsBody, 4);
    dnsBody.push(...a.ip);
  }
  const dns = Uint8Array.from(dnsBody);
  const udpLen = 8 + dns.length;
  const ipTotal = 20 + udpLen;
  const frame = new Uint8Array(14 + ipTotal);
  frame.set(q.ethSrc, 0);
  frame.set(q.ethDst, 6);
  frame[12] = 0x08; frame[13] = 0x00;
  let o = 14;
  frame[o] = 0x45; frame[o + 2] = (ipTotal >> 8) & 0xff; frame[o + 3] = ipTotal & 0xff;
  frame[o + 6] = 0x40; frame[o + 8] = 64; frame[o + 9] = 17;
  frame.set(q.ipDst, o + 12);
  frame.set(q.ipSrc, o + 16);
  const ipChecksum = checksum16(frame.subarray(o, o + 20));
  frame[o + 10] = (ipChecksum >> 8) & 0xff; frame[o + 11] = ipChecksum & 0xff;
  o = 34;
  frame[o + 1] = 53;
  frame[o + 2] = (q.udpSport >> 8) & 0xff; frame[o + 3] = q.udpSport & 0xff;
  frame[o + 4] = (udpLen >> 8) & 0xff; frame[o + 5] = udpLen & 0xff;
  frame.set(dns, 42);
  return frame;
}

function checksum16(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] || 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

// =============================================================================================
// Worker bootstrap (active only when this module is the Worker's script).
// =============================================================================================
const isWorker = typeof self !== "undefined"
  && typeof WorkerGlobalScope !== "undefined"
  && self instanceof WorkerGlobalScope;

if (isWorker) installWorkerBridge(self);

function installWorkerBridge(scope) {
  let engine = null;
  const post = (msg, transfer) => scope.postMessage(msg, transfer || []);

  // Transport stream proxy: the worker is the client; the real transport lives on the main
  // thread. Reads are request-driven (one tcp-read per read()), which backpressures the upstream.
  let sidCounter = 0;
  const streams = new Map();
  function connect(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const sid = ++sidCounter;
      const entry = { resolve, reject, readQueue: [], readWaiter: null, ended: false, opened: false };
      entry.stream = {
        read() {
          if (entry.readQueue.length) return Promise.resolve(entry.readQueue.shift());
          if (entry.ended) return Promise.resolve(undefined);
          return new Promise((r) => { entry.readWaiter = r; post({ type: "tcp-read", sid }); });
        },
        write(bytes) { const copy = bytes.slice(); post({ type: "tcp-write", sid, bytes: copy }, [copy.buffer]); },
        close() { post({ type: "tcp-close", sid }); },
      };
      streams.set(sid, entry);
      post({ type: "tcp-open", sid, host, port, timeoutMs });
    });
  }
  function deliver(sid, bytes) {
    const e = streams.get(sid); if (!e) return;
    if (e.readWaiter) { const w = e.readWaiter; e.readWaiter = null; w(bytes); }
    else e.readQueue.push(bytes);
  }

  scope.onmessage = async (ev) => {
    const m = ev.data;
    try {
      switch (m.type) {
        case "boot": {
          engine = createV86Engine({
            assets: m.assets,
            onStatus: (phase, detail) => post({ type: "status", phase, detail }),
            onSerial: (chunk) => { if (m.wantSerial) post({ type: "serial", chunk }); },
            connect,
          });
          await engine.boot();
          post({ type: "booted", id: m.id });
          break;
        }
        case "run": {
          const r = await engine.run(m.command, { cwd: m.cwd, env: m.env }, (chunk) => post({ type: "run-output", id: m.id, chunk }));
          post({ type: "run-done", id: m.id, exitCode: r.exitCode, restarted: !!r.restarted });
          break;
        }
        case "exec": {
          // Byte-exact stream output; handled concurrently with execCancel (no queue here).
          const r = await engine.exec(m.request, (stream, bytes) => post({ type: "exec-output", id: m.id, stream, bytes }, [bytes.buffer]), m.token);
          post({ type: "exec-done", id: m.id, value: r });
          break;
        }
        case "execCancel": { const r = await engine.cancelExec(m.token, { graceMs: m.graceMs, ackTimeoutMs: m.ackTimeoutMs }); post({ type: "ack", id: m.id, value: r }); break; }
        case "health": post({ type: "ack", id: m.id, value: engine?.health ?? null }); break;
        case "interrupt": engine?.interrupt(); break;
        case "cancel": { const r = await engine.cancel(m.graceMs); post({ type: "ack", id: m.id, value: r }); break; }
        case "restart": await engine.restart(); post({ type: "ack", id: m.id }); break;
        case "list": post({ type: "ack", id: m.id, value: engine.listTree(m.root) }); break;
        case "readFile": {
          const bytes = await engine.readFile(m.path);
          post({ type: "ack", id: m.id, value: bytes }, bytes ? [bytes.buffer] : []);
          break;
        }
        case "saveState": {
          const buf = await engine.saveState();
          post({ type: "ack", id: m.id, value: buf }, [buf]);
          break;
        }
        case "netStats": post({ type: "ack", id: m.id, value: engine?.netStats() ?? null }); break;
        case "flushFix": post({ type: "ack", id: m.id, value: engine?.flushFixStatus?.() ?? null }); break;
        case "dispose": await engine?.dispose(); post({ type: "ack", id: m.id }); break;
        // transport replies from the main thread:
        case "tcp-opened": { const e = streams.get(m.sid); if (e && !e.opened) { e.opened = true; e.resolve(e.stream); } break; }
        case "tcp-error": { const e = streams.get(m.sid); if (e) { streams.delete(m.sid); if (!e.opened) e.reject(new Error(m.message || "connect failed")); else { e.ended = true; deliver(m.sid, undefined); } } break; }
        case "tcp-data": deliver(m.sid, m.bytes); break;
        case "tcp-end": { const e = streams.get(m.sid); if (e) { e.ended = true; deliver(m.sid, undefined); } break; }
        default: break;
      }
    } catch (e) {
      post({ type: "error", id: m.id, message: String(e?.message || e), code: e?.code });
    }
  };
}
