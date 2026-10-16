// Live 9p mount of the page VFS in a real v86 guest. The Linux shell (linux-shell.js) routes the
// guest's TCP connection to 192.168.86.1:564 to p9-server.js over the page VFS; every command runs
// on the live /workspace mount (the only mode; no copies). mountLive() inserts 9pnet_fd and mounts
// the export at any path (here also /mnt/live) with cache=none.
//
// Needs an image whose rootfs keeps kernel/net/9p/9pnet_fd.ko (scripts/build-v86-image.sh). Set
// PI_V86_VENDOR to such a vendor dir (libv86.mjs, v86.wasm, BIOS, image/); otherwise the test uses
// apps/browser/vendor/v86 and SKIPS when that image lacks the module.
// Run alone (one VM, ~2-4 min on a phone): node --test tests/browser-p9-live.test.mjs
import test from "node:test";
import { heavy } from "./heavy.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto, { webcrypto } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxShell } from "../plugins/exec-linux/web/browser/linux-shell.js";

globalThis.crypto ??= webcrypto;

const dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(dir, "../apps/browser/vendor/v86");
const IMAGE = path.join(VENDOR, "image");
const fsJson = path.join(IMAGE, "alpine-fs.json");
const ready = fs.existsSync(path.join(VENDOR, "v86.wasm")) && fs.existsSync(fsJson)
  && fs.existsSync(path.join(IMAGE, "alpine-state.bin.gz")) && fs.readFileSync(fsJson, "utf8").includes("9pnet_fd.ko");
const assets = {
  libv86Url: pathToFileURL(path.join(VENDOR, "libv86.mjs")).href, wasmPath: path.join(VENDOR, "v86.wasm"),
  biosUrl: path.join(VENDOR, "seabios.bin"), vgaBiosUrl: path.join(VENDOR, "vgabios.bin"),
  basefsUrl: fsJson, baseUrl: path.join(IMAGE, "flat") + "/", stateGzPath: path.join(IMAGE, "alpine-state.bin.gz"),
};
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

test("live /mnt/live: guest and page see each other's changes immediately; 8 MiB exact; remount after a drop", { skip: heavy || (!ready && `no 9pnet_fd image at ${VENDOR}`), timeout: 270000 }, async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  vfs.write("/workspace/hello.txt", enc("hello from the page\n"));
  vfs.write("/workspace/sub/a.txt", enc("nested\n"));
  const big = new Uint8Array(crypto.randomBytes(8 * 1024 * 1024));
  vfs.write("/workspace/big.bin", big);
  const dialed = [];
  const network = Promise.resolve({ async connect(host, port) { dialed.push(`${host}:${port}`); throw new Error("no network in this test"); } });
  const shell = createLinuxShell({ vfs, network, assets });
  async function sh(command, timeout = 120) {
    let out = "", err = "";
    const output = (stream, bytes) => { const s = typeof bytes === "string" ? bytes : dec(bytes); if (stream === "stdout") out += s; else err += s; };
    const t = Date.now();
    const { exitCode } = await shell.exec({ command, directory: "/workspace", env: {}, timeout, output, setCancel() {} });
    log(`$ ${command.split("\n")[0].slice(0, 70)} -> ${exitCode} (${Date.now() - t} ms)${err.trim() ? " stderr: " + err.trim().slice(-300) : ""}`);
    return { exitCode, out, err };
  }
  try {
    const m = await shell.mountLive("/mnt/live");
    log("mount", m);
    assert.ok(m.ok, m.output); assert.equal(m.state, "mounted");
    assert.equal((await shell.mountLive("/mnt/live")).state, "ok", "idempotent while connected");
    const mounts = await sh("grep ' /mnt/live ' /proc/mounts");
    assert.match(mounts.out, /^192\.168\.86\.1 \/mnt\/live 9p .*trans=tcp/m);
    assert.match(mounts.out, /msize=524288/);

    // ---- guest -> page ----------------------------------------------------------------------
    const g = await sh([
      "cd /mnt/live && cat hello.txt sub/a.txt",
      "echo created > new.txt && echo appended >> new.txt",
      "printf abcdef > trunc.txt && truncate -s 3 trunc.txt",
      "echo r > ren-src.txt && mv ren-src.txt ren-dst.txt",
      "echo gone > rm.txt && rm rm.txt",
      "mkdir -p d1/d2 && echo deep > d1/d2/f.txt && mkdir emptydir && rmdir emptydir",
      "printf '#!/bin/sh\\necho script-ok\\n' > s.sh && chmod +x s.sh && ./s.sh && stat -c %a s.sh",
      "touch -d @1700000000 d1/d2/f.txt && stat -c %Y d1/d2/f.txt",
      "ls -la /mnt/live | wc -l",
    ].join("\n"));
    assert.equal(g.exitCode, 0, g.err);
    assert.match(g.out, /hello from the page\nnested\n/);
    assert.match(g.out, /script-ok\n755\n1700000000\n/);
    assert.equal(dec(await vfs.read("/workspace/new.txt")), "created\nappended\n");
    assert.equal(dec(await vfs.read("/workspace/trunc.txt")), "abc");
    assert.ok(vfs.exists("/workspace/ren-dst.txt") && !vfs.exists("/workspace/ren-src.txt"));
    assert.ok(!vfs.exists("/workspace/rm.txt") && !vfs.exists("/workspace/emptydir"));
    assert.equal(dec(await vfs.read("/workspace/d1/d2/f.txt")), "deep\n");
    assert.equal(Math.floor(vfs.info("/workspace/d1/d2/f.txt").mtimeMs / 1000), 1700000000);
    assert.equal(vfs.modeOf("/workspace/s.sh"), 0o755);
    const ln = await sh("ln -s hello.txt /mnt/live/link 2>&1; echo rc=$?");
    assert.match(ln.out, /not supported|not permitted/i); assert.match(ln.out, /rc=1/);

    // ---- page -> guest (no drop_caches) ----------------------------------------------------
    vfs.write("/workspace/hello.txt", enc("EDITED on the page\n"));
    vfs.write("/workspace/page-new.txt", enc("page file\n"));
    vfs.remove("/workspace/sub/a.txt");
    vfs.setAttributes("/workspace/page-new.txt", { mode: 0o600 });
    const p = await sh("cd /mnt/live && cat hello.txt page-new.txt && stat -c '%a %s' page-new.txt hello.txt && (test -e sub/a.txt && echo STILL || echo GONE)");
    assert.equal(p.out, "EDITED on the page\npage file\n600 10\n644 19\nGONE\n");

    // ---- 8 MiB both ways ---------------------------------------------------------------------
    const r = await sh("sha256sum /mnt/live/big.bin", 150);
    assert.equal(r.out.split(" ")[0], sha(big), "guest reads the page's 8 MiB file byte-exact");
    const w = await sh("dd if=/dev/urandom of=/tmp/g.bin bs=1M count=8 2>/dev/null && cp /tmp/g.bin /mnt/live/g.bin && sha256sum /tmp/g.bin && rm /tmp/g.bin", 150);
    assert.equal(w.exitCode, 0, w.err);
    const written = await vfs.read("/workspace/g.bin");
    assert.equal(written.length, 8 * 1024 * 1024);
    assert.equal(sha(written), w.out.split(" ")[0], "guest's 8 MiB write reaches the VFS byte-exact");

    // ---- connection drop + remount -----------------------------------------------------------
    shell.p9.closeAll();
    const dropped = await sh("timeout -s KILL 20 cat /mnt/live/hello.txt; echo rc=$?");
    assert.match(dropped.out, /rc=[1-9]/, "a dropped connection fails fast instead of hanging");
    const re = await shell.mountLive("/mnt/live");
    log("remount", re);
    assert.ok(re.ok, re.output); assert.equal(re.state, "remounted");
    const after = await sh("cat /mnt/live/hello.txt");
    assert.equal(after.out, "EDITED on the page\n");
    assert.deepEqual(dialed, [], "only the 9p intercept was used, never the network");
    log("p9 stats", JSON.stringify({ ...shell.p9.stats, byType: undefined }));
  } finally {
    shell.dispose();
  }
});

test("live /workspace: commands run on the mount, /scratch is VM-local, a drop is remounted, a failed mount is a clear error and then recovers", { skip: heavy || (!ready && `no 9pnet_fd image at ${VENDOR}`), timeout: 360000 }, async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  vfs.write("/workspace/proj/readme.txt", enc("page readme\n"));
  const big = new Uint8Array(crypto.randomBytes(2 * 1024 * 1024));
  vfs.write("/workspace/proj/big.bin", big);
  const network = Promise.resolve({ async connect() { throw new Error("no network in this test"); } });
  const shell = createLinuxShell({ vfs, network, assets });
  async function sh(command, directory = "/workspace/proj") {
    let out = "", err = "";
    const output = (stream, bytes) => { const s = typeof bytes === "string" ? bytes : dec(bytes); if (stream === "stdout") out += s; else err += s; };
    const t = Date.now();
    const { exitCode } = await shell.exec({ command, directory, env: {}, timeout: 120, output, setCancel() {} });
    log(`$ ${command.slice(0, 70)} -> ${exitCode} (${Date.now() - t} ms)${err.trim() ? " stderr: " + err.trim().slice(-300) : ""}`);
    return { exitCode, out, err };
  }
  try {
    const first = await sh("grep ' /workspace ' /proc/mounts; cat readme.txt; echo guest > g.txt");
    assert.equal(first.exitCode, 0, first.err);
    assert.match(first.out, /^192\.168\.86\.1 \/workspace 9p .*trans=tcp/m);
    assert.match(first.out, /page readme\n$/);
    assert.doesNotMatch(first.err, /COPY/);
    assert.equal(dec(await vfs.read("/workspace/proj/g.txt")), "guest\n", "guest write is in the VFS when the command returns");
    assert.equal((await shell.workspace()).mode, "live");
    vfs.write("/workspace/proj/readme.txt", enc("edited\n"));
    const r = await sh("cat readme.txt; sha256sum big.bin");
    assert.equal(r.out, `edited\n${sha(big)}  big.bin\n`);
    const s = await sh("echo tmp > s.txt && pwd && cat s.txt", "/scratch");
    assert.equal(s.out, "/scratch\ntmp\n");
    assert.ok(![...vfs.walk("/workspace")].some((p) => p.endsWith("/s.txt")), "/scratch is not part of the page files");
    shell.p9.closeAll();
    const after = await sh("cat readme.txt");
    assert.equal(after.out, "edited\n", "the dropped mount was remounted before the command");
    assert.equal((await shell.workspace()).detail, "remounted");
    // removals both ways
    vfs.remove("/workspace/proj/g.txt");
    assert.equal((await sh("test -e g.txt; echo $?; rm readme.txt")).out, "1\n");
    assert.equal(vfs.exists("/workspace/proj/readme.txt"), false, "guest removal is in the VFS");

    // Mount failure: the 9p server refuses connections -> the command is NOT run (no stale or
    // empty /workspace) and fails with a clear, retryable error; the next command remounts.
    const p9 = shell.p9;
    const connect = p9.connect;
    p9.connect = () => { throw new Error("refused (test)"); };
    p9.closeAll();
    await assert.rejects(sh("echo should-not-run > never.txt"), (e) => e.code === "shell_unavailable" && /Linux could not mount \/workspace \(.+\); the command was not run\. Try again\./.test(e.message));
    assert.equal(vfs.exists("/workspace/proj/never.txt"), false);
    assert.equal((await shell.workspace()).mode, "unavailable");
    p9.connect = connect;
    const back = await sh("ls; echo ok > back.txt");
    assert.equal(back.exitCode, 0, back.err);
    assert.match(back.out, /big\.bin/);
    assert.equal(dec(await vfs.read("/workspace/proj/back.txt")), "ok\n");
    assert.equal((await shell.workspace()).mode, "live");
  } finally {
    shell.dispose();
  }
});
