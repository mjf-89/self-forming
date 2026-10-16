// Functional test for the v86-backed Linux execution environment (apps/browser/browser-v86.js).
// Runs the actual emulator in Node 18 (v86 runs in Node too; this is the realistic speed signal
// for the native-ARM WebView on device — the headless-Chromium harness runs x86 under box64/proot
// and is pathologically slow). It exercises the PUBLIC API only:
//
//   createLinuxEnv({ vfs, transport, onStatus }) -> { ready(), run(cmd, opts), dispose() }
//
// with our real VFS (apps/browser/browser-vfs.js, MemoryBackend) and a fake transport backed by
// Node sockets (stand-in for cors-rot's Tor/Tailscale `connect`) dialing a local HTTP server.
//
// Checks: boot-from-snapshot time, echo, exit codes, cd/env, pipes, the live /workspace mount
// (create/modify/delete both ways, no copies) and /scratch, timeout recovery (124 + the shell keeps working), network via the
// transport hook (wget by hostname, exercising in-page DNS), and `apk --version`.
//
// Commands run through the guest Bash dispatcher, which needs an image with bash. The current
// repository image (apps/browser/vendor/v86) lacks bash, so this test uses the bash-capable
// repository vendor image or PI_V86_VENDOR.
// If no such image is present the test SKIPS so `node --test` stays green without the artifacts.
//
// Run:  node --test tests/browser-v86.test.mjs     (allow ~30 s; x86 emulation)
import test from "node:test";
import { heavy } from "./heavy.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import { Vfs, MemoryBackend, normalizePath } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxEnv } from "../plugins/exec-linux/web/browser/browser-v86.js";

globalThis.crypto ??= webcrypto;

const dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(dir, "../apps/browser/vendor/v86");
const IMAGE = path.join(VENDOR, "image");
const assetsPresent = fs.existsSync(path.join(VENDOR, "v86.wasm"))
  && fs.existsSync(path.join(IMAGE, "alpine-fs.json"))
  && fs.existsSync(path.join(IMAGE, "flat"))
  && fs.existsSync(path.join(IMAGE, "alpine-state.bin.gz"));
const assets = {
  libv86Url: pathToFileURL(path.join(VENDOR, "libv86.mjs")).href, wasmPath: path.join(VENDOR, "v86.wasm"),
  biosUrl: path.join(VENDOR, "seabios.bin"), vgaBiosUrl: path.join(VENDOR, "vgabios.bin"),
  basefsUrl: path.join(IMAGE, "alpine-fs.json"), baseUrl: path.join(IMAGE, "flat") + "/",
  stateGzPath: path.join(IMAGE, "alpine-state.bin.gz"),
};

// A transport that records the (host, port) it was asked to dial and pipes to a loopback server.
function makeFakeTransport(portMap) {
  const dialed = [];
  return {
    dialed,
    async connect(host, port) {
      dialed.push({ host, port });
      const target = portMap[port];
      if (!target) throw new Error(`no fake upstream for port ${port}`);
      const sock = net.connect({ host: "127.0.0.1", port: target });
      const queue = []; let waiters = []; let ended = false;
      const pushEnd = () => { ended = true; while (waiters.length) waiters.shift()(undefined); };
      sock.on("data", (d) => { const u = new Uint8Array(d); if (waiters.length) waiters.shift()(u); else queue.push(u); });
      sock.on("end", pushEnd); sock.on("close", pushEnd); sock.on("error", pushEnd);
      await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
      return {
        read() { if (queue.length) return Promise.resolve(queue.shift()); if (ended) return Promise.resolve(undefined); return new Promise((r) => waiters.push(r)); },
        write(bytes) { sock.write(Buffer.from(bytes)); },
        close() { sock.end(); },
      };
    },
  };
}

// Collect stdout+stderr of one run (raw bytes per stream; this test only checks the text).
function capture() { const parts = []; return { onOutput: (_stream, bytes) => { parts.push(Buffer.from(bytes)); }, text: () => Buffer.concat(parts).toString() }; }
const strip = (s) => s.replace(/sh: can't access tty.*\n?/g, "").trim();

test("v86 Alpine: boot, shell, VFS round-trip, timeout recovery, network hook",
  { skip: heavy || (assetsPresent ? false : `bash-capable v86 image not found at ${VENDOR} (set PI_V86_VENDOR)`) },
  async (t) => {
    const httpServer = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("hello-from-upstream\n"); });
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const httpPort = httpServer.address().port;
    const transport = makeFakeTransport({ 80: httpPort });
    t.after(() => httpServer.close());

    const vfs = await Vfs.open({ backend: new MemoryBackend() });
    const at = (p) => normalizePath(p, "/workspace");
    vfs.write(at("/workspace/hello.txt"), new TextEncoder().encode("from-the-vfs\n"));

    const t0 = Date.now();
    const env = createLinuxEnv({
      vfs,
      transport,
      assets,
      onStatus: ({ phase, detail }) => t.diagnostic(`status: ${phase}${detail ? " " + detail : ""}`),
    });
    t.after(() => env.dispose());

    // --- boot from the state snapshot (default path) ---
    await env.ready();
    t.diagnostic(`restore-from-snapshot -> ready: ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    const run = async (cmd, opts) => { const c = capture(); const r = await env.run(cmd, { ...opts, onOutput: c.onOutput }); return { exitCode: r.exitCode, out: strip(c.text()) }; };

    // --- echo + uname ---
    assert.deepEqual(await run("echo hi"), { exitCode: 0, out: "hi" });
    let r = await run("uname -a");
    assert.equal(r.exitCode, 0); assert.match(r.out, /Linux .* i686 (GNU\/)?Linux/);

    // --- arithmetic + pipes + exit codes ---
    assert.equal((await run("echo $((6*7))")).out, "42");
    assert.deepEqual(await run("printf 'a\\nb\\nc\\n' | grep -c ."), { exitCode: 0, out: "3" });
    assert.equal((await run("false")).exitCode, 1);
    assert.equal((await run("true | false")).exitCode, 1, "bash reports the last pipeline stage's exit code");
    assert.equal((await run("exit 7")).exitCode, 7);

    // --- cwd + env ---
    r = await run("pwd; echo $MYVAR", { cwd: "/tmp", env: { MYVAR: "xyz" } });
    assert.equal(r.exitCode, 0); assert.deepEqual(r.out.split("\n"), ["/tmp", "xyz"]);

    // --- apk present ---
    r = await run("apk --version");
    assert.equal(r.exitCode, 0); assert.match(r.out, /apk-tools/);

    // --- live /workspace: a VFS file created before the run is visible in the guest ---
    assert.equal((await run("cat /workspace/hello.txt")).out, "from-the-vfs");
    assert.deepEqual(env.workspace, { mode: "live", detail: "mounted" });
    assert.match((await run("grep ' /workspace ' /proc/mounts")).out, /^192\.168\.86\.1 \/workspace 9p /);

    // --- guest writes are in the VFS when the command returns ---
    r = await run("mkdir -p /workspace/out && echo guest-made-this > /workspace/out/result.txt && echo ok");
    assert.equal(r.exitCode, 0);
    assert.ok(vfs.exists(at("/workspace/out/result.txt")), "guest-created file is in the VFS");
    assert.equal(new TextDecoder().decode(await vfs.read(at("/workspace/out/result.txt"))).trim(), "guest-made-this");

    // --- a VFS file deleted in the guest is removed from the VFS ---
    assert.ok(vfs.exists(at("/workspace/hello.txt")));
    await run("rm /workspace/hello.txt");
    assert.ok(!vfs.exists(at("/workspace/hello.txt")), "guest deletion is in the VFS");

    // --- page edits/removals are visible to the next command ---
    vfs.write(at("/workspace/hello.txt"), new TextEncoder().encode("second-version\n"));
    assert.equal((await run("cat /workspace/hello.txt")).out, "second-version");
    vfs.remove(at("/workspace/out"), { recursive: true });
    assert.equal((await run("test -e /workspace/out; echo $?")).out, "1", "page removal visible to the guest");

    // --- /scratch: VM-local, not in the VFS ---
    r = await run("echo local > /scratch/s.txt && cat s.txt", { cwd: "/scratch" });
    assert.deepEqual(r, { exitCode: 0, out: "local" });
    assert.ok(!vfs.exists(at("/workspace/s.txt")) && !vfs.exists(at("/scratch/s.txt")));

    // --- timeout recovery: `sleep 100` with a 3s budget -> 124, and the shell keeps working ---
    const ts = Date.now();
    assert.equal((await run("sleep 100", { timeoutMs: 3000 })).exitCode, 124);
    t.diagnostic(`timeout recovery took ${((Date.now() - ts) / 1000).toFixed(1)}s`);
    assert.deepEqual(await run("echo recovered"), { exitCode: 0, out: "recovered" }, "shell works after a timeout");

    // --- abort via AbortSignal -> 130, shell keeps working ---
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    assert.equal((await run("sleep 100", { signal: ac.signal, timeoutMs: 60000 })).exitCode, 130);
    assert.deepEqual(await run("echo still-here"), { exitCode: 0, out: "still-here" });

    // --- network hook: wget a hostname (in-page DNS synthetic IP -> transport by hostname) ---
    r = await run("wget -T 20 -q -O - http://test.example/", { timeoutMs: 40000 });
    assert.equal(r.exitCode, 0, "wget through the transport succeeded");
    assert.match(r.out, /hello-from-upstream/);
    assert.ok(transport.dialed.some((d) => d.host === "test.example" && d.port === 80),
      `transport dialed by hostname; got ${JSON.stringify(transport.dialed)}`);

    t.diagnostic(`network bridge stats: ${JSON.stringify(env.netStats())}`);
  });
