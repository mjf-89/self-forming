// exec-linux p9-server.js: 9P2000.L server over the page VFS (live /workspace, phase 1).
// A small JS 9p client drives every operation over the byte-stream interface the Linux shell's
// transport intercept uses; no VM involved.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createP9Server, ERRNO } from "../plugins/exec-linux/web/browser/p9-server.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal 9P2000.L client ------------------------------------------------------------------
class W {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); return this; }
  u16(v) { this.a.push(v & 255, (v >> 8) & 255); return this; }
  u32(v) { for (let i = 0; i < 4; i++) this.a.push((v >>> (8 * i)) & 255); return this; }
  u64(v) { this.u32(v % 2 ** 32); return this.u32(Math.floor(v / 2 ** 32)); }
  str(s) { const e = enc(s); this.u16(e.length); for (const b of e) this.a.push(b); return this; }
  bytes(b) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
}
class R {
  constructor(b) { this.b = b; this.o = 7; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.v.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.v.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const lo = this.u32(), hi = this.u32(); return hi * 2 ** 32 + lo; }
  str() { const n = this.u16(); const s = dec(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  qid() { return { type: this.u8(), version: this.u32(), path: this.u64() }; }
  bytes(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
}
class P9Err extends Error { constructor(errno) { super(`9p errno ${errno}`); this.errno = errno; } }

function frame(type, tag, body) {
  const w = new W().u32(0).u8(type).u16(tag);
  const out = new Uint8Array(7 + body.a.length);
  out.set(w.a); out.set(body.a, 7);
  new DataView(out.buffer).setUint32(0, out.length, true);
  return out;
}

function client(stream, { fragment = 0 } = {}) {
  const waiting = new Map();
  let tagSeq = 1, buf = new Uint8Array(0), closed = false;
  const order = [];
  (async () => {
    for (;;) {
      const chunk = await stream.read();
      if (chunk === undefined) { closed = true; for (const [, w] of waiting) w.reject(new Error("closed")); waiting.clear(); return; }
      const nb = new Uint8Array(buf.length + chunk.length); nb.set(buf); nb.set(chunk, buf.length); buf = nb;
      while (buf.length >= 7) {
        const size = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
        if (buf.length < size) break;
        const msg = buf.slice(0, size); buf = buf.slice(size);
        const tag = msg[5] | (msg[6] << 8);
        order.push(tag);
        const w = waiting.get(tag); waiting.delete(tag);
        if (!w) continue;
        if (msg[4] === 7) w.reject(new P9Err(new R(msg).u32()));
        else if (msg[4] !== w.type + 1) w.reject(new Error(`unexpected reply type ${msg[4]} for ${w.type}`));
        else w.resolve(new R(msg));
      }
    }
  })();
  const send = (bytes) => {
    if (!fragment) return stream.write(bytes);
    for (let i = 0; i < bytes.length; i += fragment) stream.write(bytes.subarray(i, i + fragment));
  };
  function encode(type, fill, tag = tagSeq++ % 65000 || tagSeq++) {
    const body = new W(); fill?.(body);
    return { tag, bytes: frame(type, tag, body) };
  }
  function rpc(type, fill) {
    const { tag, bytes } = encode(type, fill);
    const p = new Promise((resolve, reject) => waiting.set(tag, { type, resolve, reject }));
    send(bytes);
    return p;
  }
  /** Send several requests in ONE write (pipelined) and return their reply promises. */
  function batch(list) {
    const parts = [], promises = [];
    for (const [type, fill] of list) {
      const { tag, bytes } = encode(type, fill);
      promises.push(new Promise((resolve, reject) => waiting.set(tag, { type, resolve, reject })));
      parts.push(bytes);
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    send(all);
    return promises;
  }
  let fidSeq = 100;
  const c = {
    stream, order, get closed() { return closed; }, rpc, batch, send, encode,
    newFid: () => fidSeq++,
    async version(msize = 65536, v = "9P2000.L") { const r = await rpc(100, (w) => w.u32(msize).str(v)); return { msize: r.u32(), version: r.str() }; },
    async attach(fid = 1) { return (await rpc(104, (w) => w.u32(fid).u32(0xffffffff).str("root").str("").u32(0))).qid(); },
    async walk(fid, newfid, names) { const r = await rpc(110, (w) => { w.u32(fid).u32(newfid).u16(names.length); for (const n of names) w.str(n); }); const n = r.u16(); return Array.from({ length: n }, () => r.qid()); },
    async getattr(fid) {
      const r = await rpc(24, (w) => w.u32(fid).u64(0x7ff));
      const valid = r.u64(), qid = r.qid(), mode = r.u32(), uid = r.u32(), gid = r.u32(), nlink = r.u64(); r.u64();
      const size = r.u64(); r.u64(); r.u64(); r.u64(); r.u64(); const mtime = r.u64(), mtimeNs = r.u64();
      return { valid, qid, mode, uid, gid, nlink, size, mtime, mtimeNs };
    },
    async setattr(fid, { valid, mode = 0, size = 0, mtime = 0, mtimeNs = 0 }) {
      await rpc(26, (w) => w.u32(fid).u32(valid).u32(mode).u32(0).u32(0).u64(size).u64(0).u64(0).u64(mtime).u64(mtimeNs));
    },
    async lopen(fid, flags) { const r = await rpc(12, (w) => w.u32(fid).u32(flags)); return { qid: r.qid(), iounit: r.u32() }; },
    async lcreate(fid, name, flags = 1, mode = 0o644) { const r = await rpc(14, (w) => w.u32(fid).str(name).u32(flags).u32(mode).u32(0)); return { qid: r.qid(), iounit: r.u32() }; },
    async read(fid, offset, count) { const r = await rpc(116, (w) => w.u32(fid).u64(offset).u32(count)); const n = r.u32(); return r.bytes(n).slice(); },
    async write(fid, offset, data) { const r = await rpc(118, (w) => w.u32(fid).u64(offset).u32(data.length).bytes(data)); return r.u32(); },
    async readdir(fid, offset = 0, count = 8192) {
      const r = await rpc(40, (w) => w.u32(fid).u64(offset).u32(count));
      const n = r.u32(), end = r.o + n, out = [];
      while (r.o < end) out.push({ qid: r.qid(), offset: r.u64(), type: r.u8(), name: r.str() });
      return out;
    },
    async readdirAll(fid, count = 8192) {
      const all = []; let off = 0;
      for (;;) { const page = await c.readdir(fid, off, count); if (!page.length) return all; all.push(...page); off = page.at(-1).offset; }
    },
    mkdir: async (dfid, name, mode = 0o755) => (await rpc(72, (w) => w.u32(dfid).str(name).u32(mode).u32(0))).qid(),
    unlinkat: (dfid, name, flags = 0) => rpc(76, (w) => w.u32(dfid).str(name).u32(flags)),
    renameat: (ofid, oname, nfid, nname) => rpc(74, (w) => w.u32(ofid).str(oname).u32(nfid).str(nname)),
    rename: (fid, dfid, name) => rpc(20, (w) => w.u32(fid).u32(dfid).str(name)),
    fsync: (fid) => rpc(50, (w) => w.u32(fid).u32(0)),
    clunk: (fid) => rpc(120, (w) => w.u32(fid)),
    remove: (fid) => rpc(122, (w) => w.u32(fid)),
    async statfs(fid) { const r = await rpc(8, (w) => w.u32(fid)); return { type: r.u32(), bsize: r.u32(), blocks: r.u64(), bfree: r.u64(), bavail: r.u64(), files: r.u64(), ffree: r.u64(), fsid: r.u64(), namelen: r.u32() }; },
  };
  return c;
}

const errno = (code) => (e) => e instanceof P9Err && e.errno === code;
async function setup({ msize = 65536, fragment = 0, files = {}, serverOptions = {} } = {}) {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  for (const [p, content] of Object.entries(files)) vfs.write(p, typeof content === "string" ? enc(content) : content);
  const server = createP9Server(vfs, { commitDelayMs: 20, commitMaxDelayMs: 100, ...serverOptions });
  const c = client(server.connect(), { fragment });
  const v = await c.version(msize);
  await c.attach(1);
  return { vfs, server, c, v };
}
async function openFile(c, names, flags = 0) { const fid = c.newFid(); await c.walk(1, fid, names); await c.lopen(fid, flags); return fid; }

// ---- tests ------------------------------------------------------------------------------------
test("version negotiates msize and rejects other protocol versions", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const server = createP9Server(vfs);
  const a = client(server.connect());
  assert.deepEqual(await a.version(4 << 20), { msize: 1 << 20, version: "9P2000.L" }, "capped at the server maximum");
  const b = client(server.connect());
  assert.deepEqual(await b.version(8192), { msize: 8192, version: "9P2000.L" });
  const u = client(server.connect());
  assert.equal((await u.version(8192, "9P2000.u")).version, "unknown");
  await assert.rejects(u.attach(1), errno(ERRNO.EPROTO), "attach requires a 9P2000.L session");
  assert.equal(server.connections, 3);
  server.closeAll();
  assert.equal(server.connections, 0);
});

test("walk, getattr, read, readdir over a fragmented stream; qids stable per node", async () => {
  const { vfs, c } = await setup({ fragment: 3, files: { "/workspace/a.txt": "alpha\n", "/workspace/sub/dir/b.txt": "bravo" } });
  const qs = await c.walk(1, 2, ["sub", "dir", "b.txt"]);
  assert.equal(qs.length, 3);
  assert.equal(qs[0].type, 0x80); assert.equal(qs[2].type, 0);
  const st = await c.getattr(2);
  assert.equal(st.size, 5); assert.equal(st.mode, 0o100644); assert.equal(st.nlink, 1);
  assert.equal(st.mtime, Math.floor(vfs.info("/workspace/sub/dir/b.txt").mtimeMs / 1000));
  assert.equal((await c.getattr(1)).mode, 0o040755);
  const { iounit } = await c.lopen(2, 0);
  assert.equal(iounit, 65536 - 24);
  assert.equal(dec(await c.read(2, 0, 100)), "bravo");
  assert.equal(dec(await c.read(2, 2, 2)), "av");
  assert.equal((await c.read(2, 10, 100)).length, 0, "read past EOF is empty");
  // partial walk: prefix qids, newfid NOT bound
  const partial = await c.walk(1, 3, ["sub", "missing", "x"]);
  assert.equal(partial.length, 1);
  await assert.rejects(c.getattr(3), errno(ERRNO.EBADF));
  await assert.rejects(c.walk(1, 3, ["nope"]), errno(ERRNO.ENOENT));
  await assert.rejects(c.walk(2, 3, ["x"]), errno(ERRNO.ENOTDIR));
  // clone + same qid
  const again = await c.walk(1, 4, ["sub", "dir", "b.txt"]);
  assert.deepEqual(again[2], qs[2]);
  // readdir with small pages
  const d = c.newFid(); await c.walk(1, d, []); await c.lopen(d, 0);
  const names = (await c.readdirAll(d, 64)).map((e) => e.name);
  assert.deepEqual(names, [".", "..", "a.txt", "sub"]);
  await c.clunk(d);
  await assert.rejects(c.clunk(d), errno(ERRNO.EBADF));
});

test("root confinement: .. stays at the export root, slashes and outside paths are rejected", async () => {
  const { vfs, c } = await setup({ files: { "/workspace/in.txt": "in", "/tmp/secret.txt": "secret", "/data/x": "x" } });
  const root = (await c.getattr(1)).qid;
  const up = await c.walk(1, 2, ["..", "..", ".."]);
  assert.equal(up.length, 3);
  for (const q of up) assert.deepEqual(q, root, ".. at the root is the root");
  assert.equal((await c.walk(1, 3, ["..", "tmp", "secret.txt"])).length, 1, "partial walk: stops at the root");
  await assert.rejects(c.getattr(3), errno(ERRNO.EBADF), "newfid not bound");
  await assert.rejects(c.walk(1, 3, ["../tmp"]), errno(ERRNO.EINVAL));
  await assert.rejects(c.walk(1, 3, ["a/b"]), errno(ERRNO.EINVAL));
  await assert.rejects(c.lcreate(1, "../escape.txt"), errno(ERRNO.EINVAL));
  await assert.rejects(c.mkdir(1, ".."), errno(ERRNO.EINVAL));
  await assert.rejects(c.renameat(1, "in.txt", 1, "../moved"), errno(ERRNO.EINVAL));
  const d = c.newFid(); await c.walk(1, d, [".."]); await c.lopen(d, 0);
  assert.ok(!(await c.readdirAll(d)).some((e) => e.name === "tmp"), "listing .. shows the export root");
  assert.ok(vfs.exists("/tmp/secret.txt") && !vfs.exists("/escape.txt"));
  await assert.rejects(c.remove(1), errno(ERRNO.EACCES), "the export root cannot be removed");
});

test("create, write, append, truncate, chmod, utimes reach the VFS; reads see buffered writes", async () => {
  const { vfs, c } = await setup();
  const f = c.newFid(); await c.walk(1, f, []);
  await c.lcreate(f, "new.txt", 1 /* O_WRONLY */, 0o644);
  assert.ok(vfs.exists("/workspace/new.txt"), "visible as soon as it is created");
  assert.equal(await c.write(f, 0, enc("hello ")), 6);
  assert.equal(await c.write(f, 6, enc("world")), 5);
  const r = await openFile(c, ["new.txt"]);
  assert.equal(dec(await c.read(r, 0, 100)), "hello world", "reads through the server see buffered data");
  assert.equal((await c.getattr(r)).size, 11);
  await c.clunk(f);
  assert.equal(dec(await vfs.read("/workspace/new.txt")), "hello world", "clunk commits");
  // O_APPEND writes go to the end whatever the offset
  const a = await openFile(c, ["new.txt"], 1 | 0o2000);
  await c.write(a, 0, enc("!"));
  await c.clunk(a);
  assert.equal(dec(await vfs.read("/workspace/new.txt")), "hello world!");
  // overwrite in the middle, then truncate via setattr (no open fid)
  const m = await openFile(c, ["new.txt"], 2);
  await c.write(m, 0, enc("J"));
  await c.clunk(m);
  assert.equal(dec(await vfs.read("/workspace/new.txt")), "Jello world!");
  const t = c.newFid(); await c.walk(1, t, ["new.txt"]);
  await c.setattr(t, { valid: 8, size: 5 });
  assert.equal(dec(await vfs.read("/workspace/new.txt")), "Jello");
  await c.setattr(t, { valid: 8, size: 8 });
  assert.deepEqual([...(await vfs.read("/workspace/new.txt"))].slice(5), [0, 0, 0], "extending fills zeros");
  // O_TRUNC on open
  const tr = await openFile(c, ["new.txt"], 1 | 0o1000);
  await c.write(tr, 0, enc("x"));
  await c.fsync(tr);
  assert.equal(dec(await vfs.read("/workspace/new.txt")), "x", "fsync commits");
  await c.clunk(tr);
  // chmod + utimes
  await c.setattr(t, { valid: 1, mode: 0o755 });
  assert.equal(vfs.modeOf("/workspace/new.txt"), 0o755);
  assert.equal((await c.getattr(t)).mode, 0o100755);
  await c.setattr(t, { valid: 32 | 256, mtime: 1700000000, mtimeNs: 250e6 });
  assert.equal(vfs.info("/workspace/new.txt").mtimeMs, 1700000000250);
  assert.equal((await c.getattr(t)).mtime, 1700000000);
  // create with an explicit mode, and an existing name
  const e = c.newFid(); await c.walk(1, e, []);
  await c.lcreate(e, "run.sh", 1, 0o755);
  assert.equal(vfs.modeOf("/workspace/run.sh"), 0o755);
  await c.clunk(e);
  const e2 = c.newFid(); await c.walk(1, e2, []);
  await assert.rejects(c.lcreate(e2, "run.sh"), errno(ERRNO.EEXIST));
  // writes on a read-only fid are refused
  const ro = await openFile(c, ["run.sh"], 0);
  await assert.rejects(c.write(ro, 0, enc("x")), errno(ERRNO.EBADF));
  await assert.rejects(c.read(c.newFid(), 0, 1), errno(ERRNO.EBADF));
});

test("buffered writes are committed after a short delay even while the file stays open", async () => {
  const { vfs, c } = await setup();
  const f = c.newFid(); await c.walk(1, f, []);
  await c.lcreate(f, "log.txt", 1);
  await c.write(f, 0, enc("line 1\n"));
  await sleep(60);
  assert.equal(dec(await vfs.read("/workspace/log.txt")), "line 1\n");
  await c.write(f, 7, enc("line 2\n"));
  await sleep(60);
  assert.equal(dec(await vfs.read("/workspace/log.txt")), "line 1\nline 2\n");
});

test("mkdir, unlinkat, renameat, rename, remove with POSIX errors; qids survive renames", async () => {
  const { vfs, c } = await setup({ files: { "/workspace/a.txt": "a", "/workspace/full/x": "x", "/workspace/b.txt": "b" } });
  const dq = await c.mkdir(1, "d", 0o700);
  assert.equal(dq.type, 0x80);
  assert.equal(vfs.get("/workspace/d").kind, "directory");
  assert.equal(vfs.modeOf("/workspace/d"), 0o700);
  await assert.rejects(c.mkdir(1, "d"), errno(ERRNO.EEXIST));
  await assert.rejects(c.unlinkat(1, "full", 0), errno(ERRNO.EISDIR));
  await assert.rejects(c.unlinkat(1, "full", 0x200), errno(ERRNO.ENOTEMPTY));
  await assert.rejects(c.unlinkat(1, "a.txt", 0x200), errno(ERRNO.ENOTDIR));
  await assert.rejects(c.unlinkat(1, "nope", 0), errno(ERRNO.ENOENT));
  // rename a file: same qid at the new name, old name gone
  const before = (await c.walk(1, 10, ["a.txt"]))[0];
  await c.renameat(1, "a.txt", 1, "c.txt");
  assert.ok(!vfs.exists("/workspace/a.txt") && dec(await vfs.read("/workspace/c.txt")) === "a");
  assert.deepEqual((await c.walk(1, 11, ["c.txt"]))[0].path, before.path);
  assert.equal(dec(await c.read(await openFile(c, ["c.txt"]), 0, 9)), "a");
  // rename over an existing file replaces it; file over dir / dir over file / into itself fail
  await c.renameat(1, "c.txt", 1, "b.txt");
  assert.equal(dec(await vfs.read("/workspace/b.txt")), "a");
  await assert.rejects(c.renameat(1, "b.txt", 1, "d"), errno(ERRNO.EISDIR));
  await assert.rejects(c.renameat(1, "full", 1, "b.txt"), errno(ERRNO.ENOTDIR));
  vfs.write("/workspace/d/occupied", enc("o"));
  await assert.rejects(c.renameat(1, "full", 1, "d"), errno(ERRNO.ENOTEMPTY));
  await assert.rejects(c.renameat(1, "full", 1, "full/inside"), errno(ERRNO.EINVAL));
  // a directory rename keeps fids under it working (paths rewritten)
  vfs.mkdir("/workspace/m/n", true); vfs.write("/workspace/m/n/f.txt", enc("deep"));
  const deep = await openFile(c, ["m", "n", "f.txt"]);
  await c.renameat(1, "m", 1, "m2");
  assert.equal(dec(await c.read(deep, 0, 10)), "deep");
  assert.equal((await c.getattr(deep)).size, 4);
  // Trename (fid-based)
  const g = c.newFid(); await c.walk(1, g, ["m2", "n", "f.txt"]);
  await c.rename(g, 1, "top.txt");
  assert.equal(dec(await vfs.read("/workspace/top.txt")), "deep");
  // Tremove
  const rm = c.newFid(); await c.walk(1, rm, ["top.txt"]);
  await c.remove(rm);
  assert.ok(!vfs.exists("/workspace/top.txt"));
  await assert.rejects(c.getattr(rm), errno(ERRNO.EBADF), "remove clunks the fid");
  await assert.rejects(c.unlinkat(1, "m2", 0x200), errno(ERRNO.ENOTEMPTY));
  const m2 = c.newFid(); await c.walk(1, m2, ["m2"]);
  await c.unlinkat(m2, "n", 0x200);
  await c.unlinkat(1, "m2", 0x200);
  assert.ok(!vfs.exists("/workspace/m2"));
});

test("replacing an empty directory by rename follows POSIX", async () => {
  const { vfs, c } = await setup({ files: { "/workspace/src/x": "x" } });
  await c.mkdir(1, "empty");
  await c.renameat(1, "src", 1, "empty");
  assert.equal(dec(await vfs.read("/workspace/empty/x")), "x");
  assert.ok(!vfs.exists("/workspace/src"));
});

test("unlink while open: the open fid keeps its data; page-removed files go stale", async () => {
  const { vfs, c } = await setup({ files: { "/workspace/tmp.bin": "keep me", "/workspace/page.txt": "p" } });
  const f = await openFile(c, ["tmp.bin"], 2);
  await c.unlinkat(1, "tmp.bin", 0);
  assert.ok(!vfs.exists("/workspace/tmp.bin"));
  assert.equal(dec(await c.read(f, 0, 100)), "keep me");
  await c.write(f, 7, enc("!"));
  assert.equal(dec(await c.read(f, 0, 100)), "keep me!");
  assert.equal((await c.getattr(f)).nlink, 0);
  await c.clunk(f);
  assert.ok(!vfs.exists("/workspace/tmp.bin"), "an orphan is never written back");
  const p = await openFile(c, ["page.txt"]);
  vfs.remove("/workspace/page.txt");
  await assert.rejects(c.read(p, 0, 1), errno(ERRNO.ENOENT));
});

test("page edits are visible on the next read; fsync persists to the backend", async () => {
  const backend = new MemoryBackend();
  const vfs = await Vfs.open({ backend });
  vfs.write("/workspace/live.txt", enc("v1"));
  const server = createP9Server(vfs);
  const c = client(server.connect());
  await c.version(65536); await c.attach(1);
  const f = await openFile(c, ["live.txt"], 2);
  assert.equal(dec(await c.read(f, 0, 10)), "v1");
  vfs.write("/workspace/live.txt", enc("version 2"));
  assert.equal(dec(await c.read(f, 0, 10)), "version 2");
  assert.equal((await c.getattr(f)).size, 9);
  await c.write(f, 0, enc("V"));
  await c.fsync(f);
  const reopened = await Vfs.open({ backend });
  assert.equal(dec(await reopened.read("/workspace/live.txt")), "Version 2", "fsync awaited vfs.flush()");
});

test("statfs, locks, and unsupported ops give clean errors", async () => {
  const { c } = await setup({ files: { "/workspace/a": "a" } });
  const s = await c.statfs(1);
  assert.equal(s.type, 0x01021997); assert.equal(s.bsize, 4096); assert.equal(s.namelen, 255);
  assert.ok(s.blocks >= s.bfree);
  await assert.rejects(c.rpc(16, (w) => w.u32(1).str("ln").str("a").u32(0)), errno(ERRNO.EOPNOTSUPP), "symlink");
  await assert.rejects(c.rpc(18, (w) => w.u32(1).str("dev").u32(0o20644).u32(1).u32(3).u32(0)), errno(ERRNO.EOPNOTSUPP), "mknod");
  await assert.rejects(c.rpc(70, (w) => w.u32(1).u32(1).str("hard")), errno(ERRNO.EOPNOTSUPP), "link");
  await assert.rejects(c.rpc(30, (w) => w.u32(1).u32(50).u16(0)), errno(ERRNO.EOPNOTSUPP), "xattrwalk");
  await assert.rejects(c.rpc(32, (w) => w.u32(1).str("user.x").u64(1).u32(0)), errno(ERRNO.EOPNOTSUPP), "xattrcreate");
  await assert.rejects(c.rpc(102, (w) => w.u32(9).str("u").str("").u32(0)), errno(ERRNO.EOPNOTSUPP), "auth");
  await c.walk(1, 5, ["a"]);
  await assert.rejects(c.rpc(22, (w) => w.u32(5)), errno(ERRNO.EINVAL), "readlink");
  await assert.rejects(c.rpc(99, () => {}), errno(ERRNO.EOPNOTSUPP), "unknown message type");
  const lock = await c.rpc(52, (w) => w.u32(5).u8(1).u32(0).u64(0).u64(0).u32(42).str("guest"));
  assert.equal(lock.u8(), 0, "lock granted");
  const gl = await c.rpc(54, (w) => w.u32(5).u8(1).u64(0).u64(10).u32(42).str("guest"));
  assert.equal(gl.u8(), 2, "getlock: unlocked");
  await assert.rejects(c.rpc(26, (w) => w.u32(77).u32(0).u32(0).u32(0).u32(0).u64(0).u64(0).u64(0).u64(0).u64(0)), errno(ERRNO.EBADF), "setattr on an unknown fid");
  await assert.rejects(c.rpc(116, (w) => w.u32(1).u64(0)), errno(ERRNO.EINVAL), "truncated message");
});

test("concurrent tags: pipelined requests all answered (out of order allowed); flush waits", async () => {
  const files = {};
  for (let i = 0; i < 40; i++) files[`/workspace/f${i}.txt`] = `file ${i}`;
  const { c } = await setup({ files });
  const fids = [];
  for (let i = 0; i < 40; i++) fids.push(await openFile(c, [`f${i}.txt`]));
  const replies = c.batch([
    ...fids.map((fid) => [116, (w) => w.u32(fid).u64(0).u32(100)]),
    ...fids.map((fid) => [24, (w) => w.u32(fid).u64(0x7ff)]),
  ]);
  const results = await Promise.all(replies);
  for (let i = 0; i < 40; i++) { const r = results[i]; const n = r.u32(); assert.equal(dec(r.bytes(n)), `file ${i}`); }
  // flush of an in-flight tag is answered after it
  const { tag, bytes } = c.encode(116, (w) => w.u32(fids[0]).u64(0).u32(100));
  const readP = new Promise((resolve) => setTimeout(resolve, 0));
  const fl = c.encode(108, (w) => w.u16(tag));
  const both = new Uint8Array(bytes.length + fl.bytes.length); both.set(bytes); both.set(fl.bytes, bytes.length);
  const seen = c.order.length;
  c.send(both);
  await readP;
  for (let i = 0; i < 100 && c.order.length < seen + 2; i++) await sleep(5);
  assert.deepEqual(c.order.slice(seen), [tag, fl.tag], "Rread before Rflush");
});

test("8 MiB file: chunked reads and writes are byte-exact; replies stay within msize", async () => {
  const big = new Uint8Array(crypto.randomBytes(8 * 1024 * 1024));
  const { vfs, c, v } = await setup({ msize: 512 * 1024, files: { "/workspace/big.bin": big } });
  const f = await openFile(c, ["big.bin"]);
  const parts = []; let off = 0;
  for (;;) { const chunk = await c.read(f, off, 1 << 20); assert.ok(chunk.length <= v.msize - 11); if (!chunk.length) break; parts.push(chunk); off += chunk.length; }
  const got = Buffer.concat(parts);
  assert.equal(crypto.createHash("sha256").update(got).digest("hex"), crypto.createHash("sha256").update(big).digest("hex"));
  // write it back to a new file in iounit-sized chunks, several in flight at once
  const w = c.newFid(); await c.walk(1, w, []);
  const { iounit } = await c.lcreate(w, "copy.bin", 1);
  const pending = [];
  for (let o = 0; o < big.length; o += iounit) {
    const chunk = big.subarray(o, Math.min(big.length, o + iounit));
    pending.push(c.rpc(118, (x) => x.u32(w).u64(o).u32(chunk.length).bytes(chunk)));
    if (pending.length >= 8) await Promise.all(pending.splice(0));
  }
  await Promise.all(pending);
  await c.clunk(w);
  const copy = await vfs.read("/workspace/copy.bin");
  assert.equal(copy.length, big.length);
  assert.ok(Buffer.from(copy).equals(Buffer.from(big)));
});

test("framing: oversized frames close the connection; closing commits open writes", async () => {
  const { vfs, server, c } = await setup({ msize: 8192 });
  const f = c.newFid(); await c.walk(1, f, []);
  await c.lcreate(f, "pending.txt", 1);
  await c.write(f, 0, enc("unflushed"));
  const bad = new Uint8Array(16); new DataView(bad.buffer).setUint32(0, 100000, true);
  c.send(bad);
  for (let i = 0; i < 50 && !c.closed; i++) await sleep(5);
  assert.ok(c.closed, "frame larger than msize closes the stream");
  assert.equal(server.connections, 0);
  for (let i = 0; i < 50 && !vfs.exists("/workspace/pending.txt"); i++) await sleep(5);
  await sleep(20);
  assert.equal(dec(await vfs.read("/workspace/pending.txt")), "unflushed");
  // a fresh connection works (remount)
  const c2 = client(server.connect());
  await c2.version(8192); await c2.attach(1);
  assert.equal(dec(await c2.read(await openFile(c2, ["pending.txt"]), 0, 100)), "unflushed");
  const small = new Uint8Array(4); new DataView(small.buffer).setUint32(0, 3, true);
  c2.send(small);
  for (let i = 0; i < 50 && !c2.closed; i++) await sleep(5);
  assert.ok(c2.closed, "frame smaller than a header closes the stream");
});

test("server.sync() commits every buffered write", async () => {
  const { vfs, server, c } = await setup({ serverOptions: { commitDelayMs: 60000, commitMaxDelayMs: 60000 } });
  const f = c.newFid(); await c.walk(1, f, []);
  await c.lcreate(f, "s.txt", 1);
  await c.write(f, 0, enc("synced"));
  assert.equal((await vfs.read("/workspace/s.txt")).length, 0);
  await server.sync();
  assert.equal(dec(await vfs.read("/workspace/s.txt")), "synced");
});
