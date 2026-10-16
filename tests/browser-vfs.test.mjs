// Lazy-loading browser filesystem (apps/browser/browser-vfs.js): contents are read on demand,
// cached within a budget, saved in batches; appends to one file are ordered.
import test from "node:test";
import assert from "node:assert/strict";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// Counts content reads so tests can see what is loaded lazily.
class CountingBackend extends MemoryBackend {
  reads = [];
  async readContent(id) { this.reads.push(id); return super.readContent(id); }
}

test("startup loads only metadata; contents are read on first use, then cached", async () => {
  const backend = new CountingBackend();
  const first = await Vfs.open({ backend });
  first.write("/workspace/a.txt", enc("alpha"));
  first.write("/workspace/sub/b.txt", enc("bravo!"));
  await first.flush();
  const vfs = await Vfs.open({ backend });
  assert.equal(backend.reads.length, 0, "no contents read at startup");
  assert.deepEqual(vfs.readdir("/workspace"), ["a.txt", "sub"]);
  assert.equal(vfs.info("/workspace/sub/b.txt").size, 6, "sizes known without reading");
  assert.equal(vfs.usage().bytes, 11);
  assert.equal(dec(await vfs.read("/workspace/a.txt")), "alpha");
  assert.equal(dec(await vfs.read("/workspace/a.txt")), "alpha");
  assert.equal(backend.reads.length, 1, "second read served from cache");
});

test("appends to one file stay in order, even when the file is not loaded yet", async () => {
  const backend = new MemoryBackend();
  const seed = await Vfs.open({ backend });
  seed.write("/data/log.jsonl", enc("0\n"));
  await seed.flush();
  const vfs = await Vfs.open({ backend });
  await Promise.all(Array.from({ length: 20 }, (_, i) => vfs.append("/data/log.jsonl", enc(`${i + 1}\n`))));
  assert.equal(dec(await vfs.read("/data/log.jsonl")), Array.from({ length: 21 }, (_, i) => `${i}\n`).join(""));
  await vfs.flush();
  const again = await Vfs.open({ backend });
  assert.equal((await again.read("/data/log.jsonl")).byteLength, vfs.info("/data/log.jsonl").size);
  await again.append("/data/new.txt", enc("created"));
  assert.equal(dec(await again.read("/data/new.txt")), "created");
});

test("rename keeps contents without rewriting them; remove deletes them from storage", async () => {
  const backend = new CountingBackend();
  const vfs = await Vfs.open({ backend });
  vfs.write("/workspace/dir/file.txt", enc("payload"));
  await vfs.flush();
  const reopened = await Vfs.open({ backend });
  reopened.rename("/workspace/dir", "/workspace/moved");
  await reopened.flush();
  assert.equal(backend.reads.length, 0, "rename read no contents");
  const third = await Vfs.open({ backend });
  assert.equal(dec(await third.read("/workspace/moved/file.txt")), "payload");
  third.remove("/workspace/moved", { recursive: true });
  await third.flush();
  const fourth = await Vfs.open({ backend });
  assert.equal(fourth.exists("/workspace/moved"), false);
  assert.equal((await backend.readContent([...backend.reads].pop())), undefined, "content record deleted");
});

test("a write while a read is loading wins; truncate works on unloaded files", async () => {
  let release;
  class SlowBackend extends MemoryBackend { async readContent(id) { await new Promise((r) => { release = r; }); return super.readContent(id); } }
  const backend = new SlowBackend();
  const seed = await Vfs.open({ backend });
  seed.write("/workspace/x.txt", enc("old contents"));
  await seed.flush();
  const vfs = await Vfs.open({ backend });
  const pending = vfs.read("/workspace/x.txt");
  vfs.write("/workspace/x.txt", enc("new"));
  release();
  await pending;
  assert.equal(dec(await vfs.read("/workspace/x.txt")), "new");
  const other = await Vfs.open({ backend });
  const t = other.truncate("/workspace/x.txt", 3);
  release();
  await t;
  assert.equal(dec(await other.read("/workspace/x.txt")), "old");
});

test("cache stays within budget; unsaved data is never dropped", async () => {
  const backend = new CountingBackend();
  const vfs = await Vfs.open({ backend });
  const big = new Uint8Array(20 * 1024 * 1024);
  for (let i = 0; i < 5; i++) { big[0] = i; vfs.write(`/workspace/big${i}.bin`, big); }
  assert.equal(vfs.usage().cachedBytes, 100 * 1024 * 1024, "unsaved contents all kept");
  await vfs.flush();
  assert.ok(vfs.usage().cachedBytes <= 64 * 1024 * 1024, `cache trimmed after saving (${vfs.usage().cachedBytes})`);
  for (let i = 0; i < 5; i++) assert.equal((await vfs.read(`/workspace/big${i}.bin`))[0], i, "evicted files read back from storage");
});
