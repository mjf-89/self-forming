// Browser Linux command protocol: cancellation during the first-use dispatcher bootstrap, and
// guest kernel oops detection. ONE emulator per test, sequential (x86 emulation is slow).
// Needs an image with bash: the repository vendor image (apps/browser/vendor/v86) or PI_V86_VENDOR.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxEnv } from "../plugins/exec-linux/web/browser/browser-v86.js";

globalThis.crypto ??= webcrypto;
const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(here, "../apps/browser/vendor/v86");
function vendorAssets(dir) {
  const image = path.join(dir, "image");
  const files = [path.join(dir, "v86.wasm"), path.join(dir, "libv86.mjs"), path.join(image, "alpine-fs.json"), path.join(image, "alpine-state.bin.gz")];
  if (!files.every((f) => fs.existsSync(f))) return null;
  return {
    libv86Url: pathToFileURL(path.join(dir, "libv86.mjs")).href, wasmPath: path.join(dir, "v86.wasm"),
    biosUrl: path.join(dir, "seabios.bin"), vgaBiosUrl: path.join(dir, "vgabios.bin"),
    basefsUrl: path.join(image, "alpine-fs.json"), baseUrl: path.join(image, "flat") + "/",
    stateGzPath: path.join(image, "alpine-state.bin.gz"),
  };
}
const assets = process.env.PI_V86_SKIP ? null : vendorAssets(VENDOR);
const skip = assets ? false : "bash-capable v86 image not found (set PI_V86_VENDOR) or PI_V86_SKIP set";
const run = async (env, command, opts = {}) => {
  let out = "";
  const r = await env.run(command, { timeoutMs: 60000, ...opts, onOutput: (_s, b) => { out += Buffer.from(b).toString(); } });
  return { ...r, out };
};

test("a timeout that fires during the first-use dispatcher bootstrap is not lost", { skip, timeout: 180000 }, async (t) => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const env = createLinuxEnv({ vfs, assets });
  t.after(() => env.dispose());
  await env.ready();
  // The very first command bootstraps the dispatcher over serial and mounts the live /workspace
  // (several seconds) within the command's timeout budget. Before the fix, a cancel in that
  // window found no registered run and `sleep 600` ran to completion.
  const started = Date.now();
  const first = await run(env, "sleep 600", { timeoutMs: 1000 });
  assert.equal(first.timedOut, true, JSON.stringify(first));
  assert.ok(Date.now() - started < 60000, `timed out promptly (${Date.now() - started} ms)`);
  const next = await run(env, "printf after");
  assert.equal(next.exitCode, 0); assert.equal(next.out, "after");
  // An abort before the dispatcher launches the run likewise stops it from launching.
  const ac = new AbortController(); ac.abort();
  await assert.rejects(env.run("printf never", { signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(env.health.healthy, true);
});

test("a guest kernel oops (taint D) makes Linux unhealthy instead of passing as an exit code", { skip, timeout: 180000 }, async (t) => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const env = createLinuxEnv({ vfs, assets });
  t.after(() => env.dispose());
  await env.ready();
  assert.equal((await run(env, "printf ok")).exitCode, 0);
  // Simulate an oops: root may set (never clear) kernel taint flags; 128 = TAINT_DIE.
  const crashed = await run(env, "echo 128 > /proc/sys/kernel/tainted");
  assert.equal(crashed.kernelOops, true, JSON.stringify(crashed));
  assert.match(crashed.out, /kernel crashed \(oops\)/);
  assert.equal(env.health.healthy, false);
  await assert.rejects(env.run("printf later", {}), (e) => e.code === "LINUX_UNHEALTHY");
});
