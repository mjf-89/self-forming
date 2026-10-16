// Optional per-node permission bits in the page VFS (browser-vfs.js): defaults, persistence with
// metadata, backward compatibility with records written before modes existed.
import test from "node:test";
import assert from "node:assert/strict";
import { Vfs, MemoryBackend, DEFAULT_FILE_MODE, DEFAULT_DIR_MODE } from "../plugins/core-execution/web/browser/browser-vfs.js";

const enc = (s) => new TextEncoder().encode(s);

test("defaults: 0644 files, 0755 directories; records stay mode-free until a mode is set", async () => {
  const backend = new MemoryBackend();
  const vfs = await Vfs.open({ backend });
  vfs.write("/workspace/a.txt", enc("a"));
  vfs.mkdir("/workspace/d");
  assert.equal(DEFAULT_FILE_MODE, 0o644); assert.equal(DEFAULT_DIR_MODE, 0o755);
  assert.equal(vfs.modeOf("/workspace/a.txt"), 0o644);
  assert.equal(vfs.modeOf("/workspace/d"), 0o755);
  await vfs.flush();
  const meta = new Map(await backend.loadMeta());
  assert.deepEqual(Object.keys(meta.get("/workspace/a.txt")).sort(), ["id", "kind", "mtimeMs", "size"]);
  assert.deepEqual(Object.keys(meta.get("/workspace/d")).sort(), ["kind", "mtimeMs"]);
  assert.deepEqual(Object.keys(vfs.info("/workspace/a.txt")).sort(), ["kind", "mtimeMs", "name", "path", "size"], "info() shape unchanged");
});

test("setAttributes(mode, mtimeMs) persists and survives writes, appends, truncation and renames", async () => {
  const backend = new MemoryBackend();
  const vfs = await Vfs.open({ backend });
  vfs.write("/workspace/run.sh", enc("#!/bin/sh\necho hi\n"));
  const changes = [];
  vfs.onChange((paths) => changes.push(...paths));
  vfs.setAttributes("/workspace/run.sh", { mode: 0o755 });
  assert.deepEqual(changes, ["/workspace/run.sh"], "setAttributes notifies listeners");
  vfs.setAttributes("/workspace/run.sh", { mtimeMs: 1600000000000 });
  assert.equal(vfs.info("/workspace/run.sh").mtimeMs, 1600000000000);
  vfs.write("/workspace/run.sh", enc("#!/bin/sh\necho changed\n"));
  await vfs.append("/workspace/run.sh", enc("echo more\n"));
  await vfs.truncate("/workspace/run.sh", 5);
  vfs.mkdir("/workspace/bin");
  vfs.setAttributes("/workspace/bin", { mode: 0o700 });
  vfs.rename("/workspace/run.sh", "/workspace/bin/run.sh");
  assert.equal(vfs.modeOf("/workspace/bin/run.sh"), 0o755);
  await vfs.flush();
  const again = await Vfs.open({ backend });
  assert.equal(again.modeOf("/workspace/bin/run.sh"), 0o755);
  assert.equal(again.modeOf("/workspace/bin"), 0o700);
  assert.equal(new TextDecoder().decode(await again.read("/workspace/bin/run.sh")), "#!/bi");
  assert.throws(() => vfs.setAttributes("/workspace/bin", { mode: 0o10000 }), { code: "invalid" });
  assert.throws(() => vfs.setAttributes("/workspace/bin", { mode: 1.5 }), { code: "invalid" });
  assert.throws(() => vfs.setAttributes("/workspace/missing", { mode: 0o600 }), { code: "not_found" });
  assert.throws(() => vfs.setAttributes("/etc", { mode: 0o600 }), { code: "not_found" });
  vfs.write("/workspace/x", enc("x"));
  assert.throws(() => vfs.setAttributes("/workspace/x", { mtimeMs: NaN }), { code: "invalid" });
});

test("old records without mode load with defaults; invalid stored modes are ignored", async () => {
  const backend = new MemoryBackend();
  await backend.save({
    meta: [
      ["/workspace", { kind: "directory", mtimeMs: 1 }],
      ["/workspace/old.txt", { kind: "file", mtimeMs: 2, size: 3, id: "old-id" }],
      ["/workspace/bad.txt", { kind: "file", mtimeMs: 2, size: 0, id: "bad-id", mode: "rwx" }],
      ["/workspace/exec", { kind: "file", mtimeMs: 2, size: 0, id: "exec-id", mode: 0o750 }],
    ],
    content: [["old-id", enc("old")]],
  });
  const vfs = await Vfs.open({ backend });
  assert.equal(vfs.modeOf("/workspace/old.txt"), 0o644);
  assert.equal(vfs.modeOf("/workspace/bad.txt"), 0o644);
  assert.equal(vfs.modeOf("/workspace/exec"), 0o750);
  assert.equal(vfs.modeOf("/workspace"), 0o755);
  assert.equal(new TextDecoder().decode(await vfs.read("/workspace/old.txt")), "old");
});
