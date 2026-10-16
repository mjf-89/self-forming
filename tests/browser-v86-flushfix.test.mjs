// v86 9P Tflush fix (plugins/exec-linux/web/browser/browser-v86-worker.js patch9pFlush, upstream
// copy/v86#1652). Guard: the fix must apply to the pinned emulator (a v86 update that moves its
// internals fails here loudly instead of silently re-enabling guest kernel corruption), and a
// burst of killed processes with file I/O in flight must leave the guest kernel untainted.
// Real v86 (repository vendor image or PI_V86_VENDOR); ONE emulator; run in its own process.
import test from "node:test";
import { heavy } from "./heavy.mjs";
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
const image = path.join(VENDOR, "image");
const present = [path.join(VENDOR, "v86.wasm"), path.join(image, "alpine-state.bin.gz")].every((f) => fs.existsSync(f));
const assets = { libv86Url: pathToFileURL(path.join(VENDOR, "libv86.mjs")).href, wasmPath: path.join(VENDOR, "v86.wasm"),
  biosUrl: path.join(VENDOR, "seabios.bin"), vgaBiosUrl: path.join(VENDOR, "vgabios.bin"),
  basefsUrl: path.join(image, "alpine-fs.json"), baseUrl: path.join(image, "flat") + "/", stateGzPath: path.join(image, "alpine-state.bin.gz") };
const skip = heavy || (present && !process.env.PI_V86_SKIP ? false : "v86 image not present (or PI_V86_SKIP)");

test("the 9P Tflush fix applies to the pinned v86 and killed processes with file I/O in flight leave the kernel untainted", { skip, timeout: 270000 }, async (t) => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const env = createLinuxEnv({ vfs, assets });
  t.after(() => env.dispose());
  await env.ready();
  const fix = await env._engine.flushFixStatus();
  assert.equal(fix.applied, true, "patch9pFlush must find v86's virtio-9p internals (pinned 94faf3d)");
  // Guest-side kills of processes doing file I/O on the 9p root (no host cancel involved): before the
  // fix this corrupted the guest kernel within a few iterations (oops-hunt: crashed by cycle 2-7).
  let out = "";
  const r = await env.run("for i in $(seq 1 25); do timeout -s KILL 0.3 sh -c 'while :; do cat /etc/os-release /bin/busybox > /dev/null; ls -R /usr > /dev/null; done'; done; cat /proc/sys/kernel/tainted",
    { timeoutMs: 200000, onOutput: (_s, b) => { out += Buffer.from(b).toString(); } });
  assert.equal(r.kernelOops, undefined, out);
  assert.equal(out.trim().split("\n").pop(), "0", `kernel taint after the kill loop: ${out.slice(-200)}`);
  t.diagnostic(`flush fix: ${JSON.stringify(await env._engine.flushFixStatus())}`);
  assert.equal(env.health.healthy, true);
});
