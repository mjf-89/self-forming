// Cold-boot the trimmed v86 Alpine image once and save a post-boot STATE SNAPSHOT (shell ready +
// NIC up) for fast restores. Writes the gzip'd snapshot into the shipped vendor tree:
//   apps/browser/vendor/v86/image/alpine-state.bin.gz        (default boot path, config-bound)
// An uncompressed alpine-state.bin is also written next to it for inspection/timing.
//
// The snapshot is CONFIG-BOUND: it is restored by browser-v86.js with the SAME memory size and
// net_device type (ENGINE_DEFAULTS in apps/browser/browser-v86-worker.js). This script uses the
// same defaults by construction (it does not override memoryMB/netType).
//
// Usage: node scripts/v86-snapshot.mjs [save|restore]
import { createV86Engine } from "../plugins/exec-linux/web/browser/browser-v86-worker.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const dir = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.V86_VENDOR || path.join(dir, "../apps/browser/vendor/v86");
const IMAGE = path.join(VENDOR, "image");
const mode = process.argv[2] || "save";
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

const assets = {
  libv86Url: pathToFileURL(path.join(VENDOR, "libv86.mjs")).href,
  wasmPath: path.join(VENDOR, "v86.wasm"),
  biosUrl: path.join(VENDOR, "seabios.bin"),
  vgaBiosUrl: path.join(VENDOR, "vgabios.bin"),
  basefsUrl: path.join(IMAGE, "alpine-fs.json"),
  baseUrl: path.join(IMAGE, "flat") + "/",
};

if (mode === "restore") {
  const raw = fs.readFileSync(path.join(IMAGE, "alpine-state.bin.gz"));
  const stateBuffer = zlib.gunzipSync(raw);
  const engine = createV86Engine({
    assets: { ...assets, stateBuffer: stateBuffer.buffer.slice(stateBuffer.byteOffset, stateBuffer.byteOffset + stateBuffer.byteLength) },
    onStatus: (p, d) => log("status", p, d || ""),
  });
  await engine.boot();
  log("restored; shell ready");
  let out = "";
  const r = await engine.run("uname -r; ip -o addr show eth0 2>/dev/null | head -1", {}, (c) => (out += c));
  log("probe ->", JSON.stringify(out.replace(/sh: can't.*\n/, "").trim()), "code", r.exitCode);
  await engine.dispose();
} else {
  const engine = createV86Engine({ assets, onStatus: (p, d) => log("status", p, d || "") });
  await engine.boot();
  log("cold boot ready");
  const state = Buffer.from(await engine.saveState());
  fs.mkdirSync(IMAGE, { recursive: true });
  // Only the gzip'd snapshot is shipped (the raw .bin is ~2x larger and is never needed at
  // runtime: browser-v86.js inflates the .gz). Keep a raw copy only if asked, for inspection.
  fs.writeFileSync(path.join(IMAGE, "alpine-state.bin.gz"), zlib.gzipSync(state, { level: 9 }));
  if (process.env.V86_KEEP_RAW) fs.writeFileSync(path.join(IMAGE, "alpine-state.bin"), state);
  else try { fs.unlinkSync(path.join(IMAGE, "alpine-state.bin")); } catch { /* none */ }
  log("saved", (state.byteLength / 1e6).toFixed(1), "MB raw;",
    (fs.statSync(path.join(IMAGE, "alpine-state.bin.gz")).size / 1e6).toFixed(1), "MB gz");
  await engine.dispose();
}
process.exit(0);
