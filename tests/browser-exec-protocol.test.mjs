// Browser Linux command protocol (plugins/exec-linux/web/browser/browser-v86*.js): resident
// guest Bash dispatcher + root-9p mailbox. ONE emulator at a time, sequential tests.
//
// Needs an image with bash: the repository vendor image (apps/browser/vendor/v86) or PI_V86_VENDOR.
// The missing-bash check needs an older bash-less image: PI_V86_NOBASH_VENDOR (skipped if unset).
// Cancellation/tmux cases live in browser-exec-protocol-cancel.test.mjs (separate process).
//
// Run: node --test tests/browser-exec-protocol.test.mjs   (several minutes; x86 emulation)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxEnv, execRequest } from "../plugins/exec-linux/web/browser/browser-v86.js";
import { encodeExecRequest } from "../plugins/exec-linux/web/browser/browser-v86-worker.js";
import { createBrowserExecution } from "../plugins/core-execution/web/browser/browser-execution.js";
import { createJavaScriptShell } from "../plugins/exec-js/web/browser/js-shell.js";
import { createLinuxShell } from "../plugins/exec-linux/web/browser/linux-shell.js";

globalThis.crypto ??= webcrypto;
const here = path.dirname(fileURLToPath(import.meta.url));
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
const BASH_VENDOR = process.env.PI_V86_VENDOR || path.resolve(here, "../apps/browser/vendor/v86");
const bashAssets = vendorAssets(BASH_VENDOR);
const oldAssets = process.env.PI_V86_NOBASH_VENDOR ? vendorAssets(process.env.PI_V86_NOBASH_VENDOR) : null;

function collect() {
  const parts = { stdout: [], stderr: [] };
  return { onOutput: (stream, bytes) => { assert.ok(bytes instanceof Uint8Array, "raw bytes"); parts[stream].push(Buffer.from(bytes)); },
    stdout: () => Buffer.concat(parts.stdout), stderr: () => Buffer.concat(parts.stderr), chunks: () => parts.stdout.length + parts.stderr.length };
}

test("request validation and shell dispatch (no VM)", async () => {
  assert.deepEqual(execRequest("echo hi"), { cwd: "/workspace", env: {}, mode: "shell", source: "echo hi" });
  assert.deepEqual(execRequest(["a", ""]).argv, ["a", ""]);
  assert.throws(() => execRequest([]), /argv must not be empty/);
  assert.throws(() => execRequest([""]), /program/);
  assert.throws(() => execRequest(["x", 1]), /strings/);
  assert.throws(() => execRequest(["x"], "/workspace", { "BAD-NAME": "v" }), /Invalid environment variable name/);
  assert.throws(() => execRequest(["x"], "/workspace", { "A=B": "v" }), /Invalid environment variable name/);
  assert.throws(() => execRequest(["x", "a\0b"]), /NUL/);
  assert.throws(() => execRequest("echo", "relative"), /absolute/);
  const bytes = Buffer.from(encodeExecRequest({ mode: "argv", argv: ["p", "", "雪"], cwd: "/workspace", env: { A: "1" } }));
  assert.deepEqual(bytes.toString().split("\0"), ["v1", "argv", "/workspace", "1", "A=1", "p", "", "雪", "end", ""]);

  // Shell dispatch (E1): every env.exec names its shell; no PI_EXEC_KIND selector, no default.
  const posted = [];
  const original = globalThis.Worker;
  globalThis.Worker = class { constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "done", exitCode: 0 } })); } postMessage(m) { posted.push(m); } terminate() {} };
  try {
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    vfs.write("/workspace/script.js", new TextEncoder().encode("console.log(process.argv)"));
    const shells = { javascript: createJavaScriptShell(), bash: createLinuxShell({ vfs, network: null, load: () => { throw new Error("no VM in this test"); } }) };
    const backend = createBrowserExecution({ vfs, emit: () => {}, shells });
    const call = (params) => backend.methods["env.exec"]({ id: "x" + posted.length + Math.random(), owner: "t", ...params });
    assert.deepEqual(await call({ shell: "javascript", command: "console.log(1 + 1)" }), { exitCode: 0 });
    assert.equal(posted.at(-1).code, "console.log(1 + 1)");
    assert.deepEqual(posted.at(-1).argv, []);
    assert.deepEqual(await call({ shell: "javascript", command: "1", env: { PI_EXEC_KIND: "linux" } }), { exitCode: 0 }, "PI_EXEC_KIND is an ordinary variable");
    assert.equal(posted.at(-1).env.PI_EXEC_KIND, "linux");
    assert.deepEqual(await call({ shell: "javascript", command: ["node", "script.js", "a b", ""] }), { exitCode: 0 });
    assert.equal(posted.at(-1).code, "console.log(process.argv)");
    assert.deepEqual(posted.at(-1).argv, ["node", "/workspace/script.js", "a b", ""]);
    const before = posted.length;
    await assert.rejects(call({ command: "1" }), (e) => e.code === "shell_unavailable" && /No shell selected/.test(e.message));
    await assert.rejects(call({ shell: "python", command: "1" }), (e) => e.code === "shell_unavailable");
    await assert.rejects(call({ shell: "javascript", command: ["ls", "-l"] }), (e) => e.code === "spawn_error" && /no program "ls"/.test(e.message));
    await assert.rejects(call({ shell: "javascript", command: ["node", "missing.js"] }), (e) => e.code === "spawn_error" && /Cannot run/.test(e.message));
    await assert.rejects(call({ shell: "bash", command: ["x"], env: { "BAD NAME": "1" } }), /Invalid environment variable name/);
    await assert.rejects(call({ shell: "bash", command: [] }), (e) => e.code === "spawn_error");
    assert.equal(posted.length, before, "rejected requests never reached a JS worker");
    assert.deepEqual(backend.methods["env.info"]({ shell: "bash" }).shell, { id: "bash", language: "bash", name: "Linux (Bash)" });
    assert.equal(backend.methods["env.info"]({}).shell, undefined);
    backend.dispose();
  } finally { globalThis.Worker = original; }
});

test("Linux dispatcher: argv, shell, byte-exact separate streams, env/cwd, exit codes",
  { skip: bashAssets ? false : `bash-capable image not found at ${BASH_VENDOR} (set PI_V86_VENDOR)`, timeout: 200000 },
  async (t) => {
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    vfs.mkdir("/workspace/sub dir", true);
    const env = createLinuxEnv({ vfs, assets: bashAssets });
    t.after(() => env.dispose());
    const t0 = Date.now();
    await env.ready();
    const run = async (command, opts = {}) => { const c = collect(); const r = await env.run(command, { timeoutMs: 90000, ...opts, onOutput: c.onOutput }); return { r, out: c.stdout(), err: c.stderr(), chunks: c.chunks() }; };
    const at = (label) => t.diagnostic(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // argv edge cases: empty, spaces, quotes, metacharacters, newline, Unicode — direct exec.
    const args = ["", "two words", "single' double\" back\\slash", "$(touch /workspace/INJECTED); `id` * & | > ; $HOME", "line1\nline2", "雪🙂"];
    let x = await run(["printf", "<%s>\\0", ...args]);
    assert.deepEqual(x.r, { exitCode: 0 });
    assert.ok(x.out.equals(Buffer.from(args.map((a) => `<${a}>\0`).join(""))), "argv bytes exact");
    assert.equal(x.err.length, 0);
    assert.equal(vfs.exists("/workspace/INJECTED"), false, "metacharacters not interpreted");
    at("argv");

    // shell mode is bash -c (bash-only syntax works), exit status preserved.
    x = await run("set -o pipefail; a=(x y z); printf '%s|' \"${a[@]}\"; [[ $BASH_VERSION ]] && echo bash; false | true; echo rc=$?; exit 7");
    assert.equal(x.r.exitCode, 7);
    assert.equal(x.out.toString(), "x|y|z|bash\nrc=1\n");
    at("shell");

    // > 1 MiB per stream, NUL + Unicode, separate stdout/stderr, byte exact.
    const N = 1100000;
    x = await run(`printf 'out\\0雪'; head -c ${N} /dev/zero; printf '🙂end'; { printf 'err\\0🙂'; head -c ${N + 1} /dev/zero | tr '\\0' E; } >&2`);
    assert.equal(x.r.exitCode, 0);
    const expectOut = Buffer.concat([Buffer.from("out\0雪"), Buffer.alloc(N), Buffer.from("🙂end")]);
    const expectErr = Buffer.concat([Buffer.from("err\0🙂"), Buffer.alloc(N + 1, "E")]);
    assert.equal(x.out.length, expectOut.length); assert.ok(x.out.equals(expectOut), "stdout byte exact");
    assert.equal(x.err.length, expectErr.length); assert.ok(x.err.equals(expectErr), "stderr byte exact");
    at("large streams");

    // zero-length output.
    x = await run(["true"]);
    assert.deepEqual(x.r, { exitCode: 0 }); assert.equal(x.chunks, 0);

    // env (validated names, arbitrary values) and cwd under /workspace (with a space).
    x = await run('pwd; printf "%s|%s" "$A" "$B"', { cwd: "/workspace/sub dir", env: { A: "x y $z '\"雪", B: "" } });
    assert.equal(x.r.exitCode, 0);
    assert.equal(x.out.toString(), "/workspace/sub dir\nx y $z '\"雪|");
    x = await run(["printenv", "D", "pid", "seen"], { env: { D: "d", pid: "p", seen: "s" } });
    assert.equal(x.out.toString(), "d\np\ns\n", "env names that match dispatcher variables are delivered intact");
    at("env/cwd");

    // exit codes and launch failures.
    assert.equal((await run(["false"])).r.exitCode, 1);
    assert.equal((await run("kill -TERM $$")).r.exitCode, 143);
    x = await run(["definitely-not-a-program", "a"]);
    assert.equal(x.r.exitCode, 127); assert.match(x.r.spawnError, /command not found: definitely-not-a-program/);
    x = await run(["true"], { cwd: "/workspace/missing" });
    assert.equal(x.r.exitCode, 126); assert.match(x.r.spawnError, /working directory not found/);
    at("exit codes");

    // live /workspace: page files visible, guest writes/removals in the VFS when the run returns.
    vfs.write("/workspace/in.txt", new TextEncoder().encode("from-vfs"));
    x = await run("cat in.txt; printf guest > out.txt; rm in.txt");
    assert.equal(x.out.toString(), "from-vfs");
    assert.equal(new TextDecoder().decode(await vfs.read("/workspace/out.txt")), "guest");
    assert.equal(vfs.exists("/workspace/in.txt"), false);
    assert.equal(env.workspace.mode, "live");
    // modes: chmod +x in the guest reaches the VFS; a page mode is visible in the guest.
    x = await run("printf '#!/bin/sh\\necho ran\\n' > s.sh && chmod +x s.sh && ./s.sh");
    assert.equal(x.out.toString(), "ran\n");
    assert.equal(vfs.modeOf("/workspace/s.sh") & 0o111, 0o111, "exec bits in the VFS");
    vfs.setAttributes("/workspace/s.sh", { mode: 0o600 });
    assert.equal((await run("stat -c %a s.sh")).out.toString(), "600\n");
    at("live");

    // Page edits are visible to the very next command (cache=none; no drop_caches, no copies).
    const put = (p, text) => vfs.write(p, new TextEncoder().encode(text));
    put("/workspace/a.txt", "one");
    assert.equal((await run("cat a.txt")).out.toString(), "one");
    put("/workspace/a.txt", "two-longer");
    assert.equal((await run("cat a.txt")).out.toString(), "two-longer", "host edit of an existing file visible");
    put("/workspace/a.txt", "3");
    assert.equal((await run("cat a.txt; printf ' %s' $(stat -c %s a.txt)")).out.toString(), "3 1", "shrunk file: content and size fresh");
    await run("echo guest > b.txt");
    assert.equal(new TextDecoder().decode(await vfs.read("/workspace/b.txt")), "guest\n");
    put("/workspace/b.txt", "host-edit");
    assert.equal((await run("cat b.txt")).out.toString(), "host-edit", "guest-written file then host edit visible");
    vfs.remove("/workspace/b.txt");
    assert.equal((await run("test -e b.txt && echo present || echo gone")).out.toString(), "gone\n", "host removal visible");
    at("stale cache");

    // Loopback is up (dispatcher bootstrap): a closed local port refuses instead of timing out.
    x = await run("ip -o link show lo; exec 3<>/dev/tcp/127.0.0.1/9", { timeoutMs: 30000 });
    assert.match(x.out.toString(), /<[^>]*\bUP\b[^>]*>/, "lo is UP");
    assert.match(x.err.toString(), /Connection refused/);
    assert.equal(env.health.healthy, true);
    at("loopback");
  });

test("missing bash: a bash-less image fails Linux runs with a clear error",
  { skip: oldAssets ? false : "set PI_V86_NOBASH_VENDOR to a bash-less image", timeout: 120000 },
  async (t) => {
    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    const env = createLinuxEnv({ vfs, assets: oldAssets });
    t.after(() => env.dispose());
    await env.ready();
    const bash = env._engine && (await env._engine.listTree("/bin")).some((e) => e.path === "/bin/bash");
    if (bash) { t.skip("repository image now ships bash"); return; }
    for (const command of ["echo hi", ["echo", "hi"]]) {
      await assert.rejects(env.run(command, { onOutput: () => {} }), (e) => e.code === "LINUX_IMAGE_LACKS_BASH" && /lacks bash.*update the Linux image/.test(e.message));
    }
  });
