// Browser Linux command protocol — cancellation without VM reset. ONE emulator, sequential.
// Split from browser-exec-protocol.test.mjs to keep each file's runtime bounded.
// Needs a bash-capable image (repository vendor image by default, or PI_V86_VENDOR).
//
// Run: node --test tests/browser-exec-protocol-cancel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxEnv } from "../plugins/exec-linux/web/browser/browser-v86.js";

function vendorAssets(dir) {
  const image = path.join(dir, "image");
  if (![path.join(dir, "v86.wasm"), path.join(image, "alpine-fs.json"), path.join(image, "alpine-state.bin.gz")].every((f) => fs.existsSync(f))) return null;
  return {
    libv86Url: pathToFileURL(path.join(dir, "libv86.mjs")).href, wasmPath: path.join(dir, "v86.wasm"),
    biosUrl: path.join(dir, "seabios.bin"), vgaBiosUrl: path.join(dir, "vgabios.bin"),
    basefsUrl: path.join(image, "alpine-fs.json"), baseUrl: path.join(image, "flat") + "/",
    stateGzPath: path.join(image, "alpine-state.bin.gz"),
  };
}

globalThis.crypto ??= webcrypto;
const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(here, "../apps/browser/vendor/v86");
const assets = vendorAssets(VENDOR);

test("cancel: graceful TERM, TERM-resistant KILL, unrelated tmux survives, no VM reset, unconfirmed => unhealthy",
  { skip: assets ? false : `bash-capable image not found at ${VENDOR}`, timeout: 230000 },
  async (t) => {
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    const env = createLinuxEnv({ vfs, assets });
    t.after(() => env.dispose());
    await env.ready();
    const t0 = Date.now();
    const at = (label) => t.diagnostic(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const run = async (command, opts = {}) => {
      const parts = { stdout: [], stderr: [] };
      const r = await env.run(command, { timeoutMs: 90000, ...opts, onOutput: (s, b) => parts[s].push(Buffer.from(b)) });
      return { r, out: Buffer.concat(parts.stdout).toString(), err: Buffer.concat(parts.stderr).toString() };
    };
    let restarts = 0;
    const engine = env._engine;
    const origRestart = engine.restart;
    engine.restart = (...a) => { restarts++; return origRestart(...a); };

    // An earlier command starts an unrelated tmux session (daemonised into its own session).
    let x = await run("tmux new-session -d -s keep 'sleep 1000' && tmux display-message -p '#{pid}' && cat /proc/sys/kernel/random/boot_id");
    assert.equal(x.r.exitCode, 0, x.err);
    const [tmuxPid, bootId] = x.out.trim().split("\n");
    assert.match(tmuxPid, /^\d+$/);
    at("tmux started");

    // Timeout on a command that handles TERM: it gets TERM, exits on its own (no escalation).
    x = await run("trap 'printf term-handled; exit 3' TERM; printf started; sleep 1001 & wait", { timeoutMs: 4000 });
    assert.equal(x.r.exitCode, 124); assert.equal(x.r.timedOut, true);
    assert.equal(x.r.cancelConfirmed, true); assert.equal(x.r.escalated, false);
    assert.equal(x.r.commandExitCode, 3);
    assert.equal(x.out, "startedterm-handled");
    at("graceful TERM");

    // Abort a TERM-resistant command (whole group ignores TERM): KILL after the grace period.
    // It also writes into the live /workspace before cancellation: that write is in the VFS.
    const ac = new AbortController();
    const pending = run("printf partial > partial.txt; trap '' TERM; (trap '' TERM; sleep 1002) & while :; do sleep 1; done", { signal: ac.signal, graceMs: 1000 });
    setTimeout(() => ac.abort(), 5000);
    x = await pending;
    assert.equal(x.r.exitCode, 130); assert.equal(x.r.aborted, true);
    assert.equal(x.r.cancelConfirmed, true); assert.equal(x.r.escalated, true);
    assert.equal(x.r.commandExitCode, 137);
    assert.equal(new TextDecoder().decode(await vfs.read("/workspace/partial.txt")), "partial", "writes before a confirmed cancel are in the VFS");
    at("TERM-resistant KILL");

    // The cancelled commands' processes are gone (sleep 1001/1002), the VM was not
    // reset, the tmux server and session survived, and the next command works.
    x = await run("tmux has-session -t keep && tmux display-message -p '#{pid}'; cat /proc/sys/kernel/random/boot_id; ps -eo args= | grep -c '[s]leep 100[12]' || true");
    assert.equal(x.r.exitCode, 0, x.err);
    const [pidAfter, bootAfter, sleepers] = x.out.trim().split("\n");
    assert.equal(pidAfter, tmuxPid, "same tmux server");
    assert.equal(bootAfter, bootId, "same boot (no VM reset)");
    assert.equal(sleepers.trim(), "0", "no process of the cancelled commands remains");
    assert.equal(restarts, 0, "VM restart never called");
    at("survivors checked");

    // Unconfirmed cancellation (ack window forced to ~0): reported, then later runs fail clearly.
    x = await run("sleep 1000", { timeoutMs: 1500, cancelAckTimeoutMs: 1 });
    assert.equal(x.r.exitCode, 124); assert.equal(x.r.cancelConfirmed, false);
    assert.match(x.err, /cancellation was not confirmed/);
    assert.equal(env.health.healthy, false);
    await assert.rejects(run("echo next"), (e) => e.code === "LINUX_UNHEALTHY" && /unhealthy/.test(e.message));
    assert.equal(restarts, 0, "unhealthy path does not reset the VM");
    at("unconfirmed");
  });
