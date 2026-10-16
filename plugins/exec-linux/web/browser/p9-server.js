// exec-linux: a 9P2000.L file server over the PAGE VFS (core-execution browser-vfs.js), so the
// Linux guest can mount the page's /workspace LIVE over its virtual NIC:
//   guest: insmod 9pnet_fd; mount -t 9p -o trans=tcp,port=564,version=9p2000.L,cache=none \
//          192.168.86.1 <dir>
//   page:  the shell's transport.connect("192.168.86.1", 564) returns server.connect() instead of
//          a network stream (linux-shell.js). Guest TCP already leaves the worker as tcp-open.
//
// createP9Server(vfs, { root }) -> { connect(), sync(), closeAll(), stats, connections }
//   connect() -> stream { read(): Promise<Uint8Array|undefined>, write(bytes), close() }: the
//   same byte-stream shape as a network transport stream (undefined = EOF).
//
// Semantics:
//  - Exports exactly `root` of the VFS (default /workspace). Walk names are single components;
//    ".." at the export root stays at the root, so a fid can never name a path outside it.
//  - qid.path is stable per VFS node object (survives renames and in-place writes; a removed and
//    re-created file gets a new qid). Fids hold (path, node); if the page removes or replaces a
//    node behind an open fid, that fid fails with ENOENT (the guest re-walks on its next lookup).
//  - Reads come from the VFS (whole file loaded once per revision per fid, replies bounded by
//    msize). Page edits are visible to the guest's next read (cache=none: no guest page cache).
//  - Writes go to a per-node buffer (the VFS write API is whole-file) and are committed to the
//    VFS with vfs.write() when the last writable fid is clunked, on fsync, on setattr, when the
//    connection ends, and at most `commitMaxDelayMs` after a write (idle `commitDelayMs`). fsync
//    additionally awaits vfs.flush() (IndexedDB). Reads/getattr through the server see buffered
//    data. Concurrent page edits to a file the guest is writing: the guest's commit wins.
//  - Files removed/renamed-over while the guest still has them open keep working for those fids
//    (orphan copy, discarded on clunk), as POSIX expects for unlink-while-open.
//  - Modes: permission bits are the VFS node `mode` (default 0644 files / 0755 dirs); uid/gid
//    are always 0 and chown is accepted and ignored. Symlinks, device nodes, hard links and
//    xattrs are not supported (EOPNOTSUPP); POSIX locks are granted (single client).

export const P9_HOST = "192.168.86.1";
export const P9_PORT = 564;

const T = {
  lerror: 6, statfs: 8, lopen: 12, lcreate: 14, symlink: 16, mknod: 18, rename: 20, readlink: 22,
  getattr: 24, setattr: 26, xattrwalk: 30, xattrcreate: 32, readdir: 40, fsync: 50, lock: 52, getlock: 54,
  link: 70, mkdir: 72, renameat: 74, unlinkat: 76, version: 100, auth: 102, attach: 104, flush: 108,
  walk: 110, read: 116, write: 118, clunk: 120, remove: 122,
};
const RLERROR = 7;
export const ERRNO = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22,
  EFBIG: 27, ENOSPC: 28, ENAMETOOLONG: 36, ENOTEMPTY: 39, EPROTO: 71, EOPNOTSUPP: 95,
};
const E = ERRNO;
const QT_DIR = 0x80, QT_FILE = 0;
const S_IFDIR = 0o040000, S_IFREG = 0o100000;
const DOTL_ACCMODE = 3, DOTL_TRUNC = 0o1000, DOTL_APPEND = 0o2000;
const AT_REMOVEDIR = 0x200;
const ATTR = { MODE: 1, UID: 2, GID: 4, SIZE: 8, ATIME: 16, MTIME: 32, CTIME: 64, ATIME_SET: 128, MTIME_SET: 256 };
const IOHDRSZ = 24;          // Rlopen iounit = msize - 24 (Linux P9_IOHDRSZ)
const RREAD_HDR = 11;        // size[4] type[1] tag[2] count[4]
const MIN_MSIZE = 4096;
const MAX_WALK = 16;

const td = new TextDecoder(), te = new TextEncoder();

class P9Error extends Error { constructor(errno, message = "") { super(message || `errno ${errno}`); this.errno = errno; } }
const fail = (errno, message) => { throw new P9Error(errno, message); };
function errnoOf(error) {
  if (error instanceof P9Error) return error.errno;
  switch (error?.code) {
    case "not_found": return E.ENOENT;
    case "not_directory": return E.ENOTDIR;
    case "is_directory": return E.EISDIR;
    case "permission_denied": return E.EACCES;
    case "invalid": return E.EINVAL;
    default: return E.EIO;
  }
}

// ---- wire encoding ----------------------------------------------------------------------------
class Writer {
  constructor(capacity = 64) { this.b = new Uint8Array(capacity); this.n = 0; }
  need(k) {
    if (this.n + k <= this.b.length) return;
    const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    nb.set(this.b.subarray(0, this.n)); this.b = nb;
  }
  u8(v) { this.need(1); this.b[this.n++] = v & 255; }
  u16(v) { this.need(2); this.b[this.n++] = v & 255; this.b[this.n++] = (v >>> 8) & 255; }
  u32(v) { this.need(4); for (let i = 0; i < 4; i++) this.b[this.n++] = (v >>> (8 * i)) & 255; }
  u64(v) { const n = Math.max(0, Math.floor(Number(v) || 0)); this.u32(n % 2 ** 32); this.u32(Math.floor(n / 2 ** 32)); }
  str(s) { const e = te.encode(s); this.u16(e.length); this.bytes(e); }
  bytes(a) { this.need(a.length); this.b.set(a, this.n); this.n += a.length; }
  qid(q) { this.u8(q.type); this.u32(q.version); this.u64(q.path); }
}
class Reader {
  constructor(b, o = 0) { this.b = b; this.o = o; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  room(k) { if (this.o + k > this.b.length) fail(E.EINVAL, "truncated message"); }
  u8() { this.room(1); return this.b[this.o++]; }
  u16() { this.room(2); const v = this.v.getUint16(this.o, true); this.o += 2; return v; }
  u32() { this.room(4); const v = this.v.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const lo = this.u32(), hi = this.u32(); return hi * 2 ** 32 + lo; }
  str() { const n = this.u16(); this.room(n); const s = td.decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  bytes(n) { this.room(n); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
}

const childPath = (dir, name) => (dir === "/" ? "" : dir) + "/" + name;
const parentPath = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
function checkName(name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) fail(E.EINVAL, "invalid name");
  if (te.encode(name).length > 255) fail(E.ENAMETOOLONG);
  return name;
}

/**
 * createP9Server(vfs, options) — see the header. Options: root ("/workspace"), maxMsize (1 MiB),
 * maxInflight (64 concurrent requests per connection), commitDelayMs (200), commitMaxDelayMs
 * (1000), maxFileBytes (1 GiB), log(...args).
 */
export function createP9Server(vfs, {
  root = "/workspace", maxMsize = 1 << 20, maxInflight = 64, commitDelayMs = 200, commitMaxDelayMs = 1000,
  maxFileBytes = 1 << 30, log = () => {},
} = {}) {
  if (!vfs) throw new TypeError("createP9Server needs a VFS");
  maxMsize = Math.max(MIN_MSIZE, Math.min(maxMsize, 16 << 20));
  const stats = { connects: 0, disconnects: 0, msgs: 0, errors: 0, bytesIn: 0, bytesOut: 0, commits: 0, byType: {} };
  const conns = new Set();
  const allFids = new Set();             // every live fid of every connection (path rewrites/orphans)
  const qids = new WeakMap(); let nextQid = 1;
  const queues = new WeakMap();          // node -> tail promise (data ops on one node run in order)
  const bufs = new Map();                // node -> write buffer { node, path, data, size, dirty, ... }
  const writers = new Map();             // node -> number of fids open for writing

  // ---- nodes, qids --------------------------------------------------------------------------
  function qidOf(node) {
    let id = qids.get(node);
    if (id === undefined) { id = nextQid++; qids.set(node, id); }
    const dir = node.kind === "directory";
    return { type: dir ? QT_DIR : QT_FILE, version: dir ? 0 : (((node.rev ?? 0) * 2654435761) ^ Math.floor(node.mtimeMs)) >>> 0, path: id };
  }
  function serial(node, fn) {
    const prev = queues.get(node) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    queues.set(node, tail);
    void tail.then(() => { if (queues.get(node) === tail) queues.delete(node); });
    return run;
  }
  /** The fid's node if it still lives at the fid's path (or an orphan), else ENOENT. */
  function nodeOf(f) {
    if (f.orphan) return f.node;
    const node = vfs.get(f.path);
    if (!node || node !== f.node) fail(E.ENOENT, "stale fid");
    return node;
  }
  const modeOf = (node) => node.mode ?? (node.kind === "directory" ? 0o755 : 0o644);

  // ---- write buffers -------------------------------------------------------------------------
  async function bufferFor(node, path, { load = true } = {}) {   // call inside serial(node)
    let b = bufs.get(node);
    if (b && !b.dirty && b.rev !== node.rev) { bufs.delete(node); clearTimeout(b.timer); b = undefined; } // page changed it
    if (b) return b;
    const current = load && node.size ? await vfs.read(path) : new Uint8Array(0);
    b = { node, path, data: new Uint8Array(Math.max(current.length, 4096)), size: current.length, dirty: false, rev: node.rev, timer: null, firstDirty: 0, mtimeMs: node.mtimeMs, error: null };
    b.data.set(current);
    bufs.set(node, b);
    return b;
  }
  function setSize(b, size) {
    if (size > maxFileBytes) fail(E.EFBIG);
    if (size > b.data.length) {
      const nb = new Uint8Array(Math.min(maxFileBytes, Math.max(size, b.data.length * 2)));
      nb.set(b.data.subarray(0, b.size)); b.data = nb;
    } else if (size < b.size) b.data.fill(0, size, b.size);
    b.size = size;
  }
  function markDirty(b) {
    b.mtimeMs = Date.now();
    if (!b.dirty) { b.dirty = true; b.firstDirty = Date.now(); }
    clearTimeout(b.timer);
    const wait = Math.max(0, Math.min(commitDelayMs, b.firstDirty + commitMaxDelayMs - Date.now()));
    b.timer = setTimeout(() => { void serial(b.node, () => commit(b)).catch(() => {}); }, wait);
  }
  /** Write a dirty buffer into the VFS (inside serial(node)). Throws P9Error(EIO) on failure. */
  function commit(b) {
    clearTimeout(b.timer); b.timer = null;
    if (!b.dirty || bufs.get(b.node) !== b) return;
    b.dirty = false;
    if (vfs.get(b.path) !== b.node) {
      log("p9: dropped buffered writes for a file moved/removed by the page:", b.path);
      bufs.delete(b.node);
      return;
    }
    try {
      vfs.write(b.path, b.data.subarray(0, b.size));
      b.rev = b.node.rev;
      stats.commits++;
    } catch (error) {
      b.error = error;
      log("p9: commit failed", b.path, error?.message);
      fail(errnoOf(error) === E.EACCES ? E.EACCES : E.EIO, error?.message);
    }
  }
  async function commitNode(node) { const b = bufs.get(node); if (b?.dirty) await serial(node, () => commit(b)); }
  function release(node) {           // last writable fid gone -> commit + free the buffer
    const n = (writers.get(node) ?? 1) - 1;
    if (n > 0) { writers.set(node, n); return Promise.resolve(); }
    writers.delete(node);
    return serial(node, () => {
      const b = bufs.get(node);
      if (!b || writers.has(node)) return;
      try { commit(b); } finally { if (!writers.has(node)) { clearTimeout(b.timer); bufs.delete(node); } }
    });
  }
  /** Before `node` disappears from the VFS: give open fids a private copy, drop its buffer. */
  async function orphan(node, path) {
    const open = [...allFids].filter((f) => f.node === node && f.open && !f.orphan);
    const b = bufs.get(node);
    if (open.length && node.kind === "file") {
      const data = b ? b.data.slice(0, b.size) : (await vfs.read(path)).slice();
      const copy = { data, size: data.length };
      for (const f of open) { f.orphan = copy; if (f.writable) f.orphanWriter = true; }
    }
    if (b) { clearTimeout(b.timer); bufs.delete(node); }
    if (node.kind === "file") writers.delete(node);
  }
  function rewritePaths(from, to) {
    const move = (p) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    for (const f of allFids) if (!f.orphan) f.path = move(f.path);
    for (const b of bufs.values()) b.path = move(b.path);
  }

  // ---- attributes ---------------------------------------------------------------------------
  function attrOf(f, node) {
    const dir = node.kind === "directory";
    const b = f.orphan ? null : bufs.get(node);
    const size = dir ? 4096 : f.orphan ? f.orphan.size : b ? b.size : node.size;
    const mtimeMs = b?.dirty ? b.mtimeMs : node.mtimeMs;
    return { dir, size, mtimeMs, mode: (dir ? S_IFDIR : S_IFREG) | (modeOf(node) & 0o7777), nlink: f.orphan ? 0 : dir ? 2 : 1 };
  }

  // ---- connections --------------------------------------------------------------------------
  function connect() {
    stats.connects++;
    const fids = new Map();
    const inflight = new Map();          // tag -> promise of its handler
    let msize = maxMsize, versioned = false, closed = false;
    let chunks = [], have = 0;           // inbound byte queue
    const outq = []; let outBytes = 0; const waiters = [];
    const maxOut = 4 * maxMsize + (1 << 20);
    const maxIn = (maxInflight + 2) * (maxMsize + 64);

    function push(bytes) {
      if (closed) return;
      stats.bytesOut += bytes.length;
      if (waiters.length) { waiters.shift()(bytes); return; }
      outq.push(bytes); outBytes += bytes.length;
    }
    function reply(type, tag, fill, capacity) {
      const w = new Writer(capacity ?? 64);
      w.u32(0); w.u8(type); w.u16(tag);
      if (fill) fill(w);
      const out = w.b.subarray(0, w.n);
      new DataView(out.buffer, out.byteOffset, 4).setUint32(0, w.n, true);
      push(w.b.length === w.n ? w.b : out.slice());
    }
    const error = (tag, errno) => { stats.errors++; reply(RLERROR, tag, (w) => w.u32(errno)); };

    const getFid = (id) => fids.get(id) ?? fail(E.EBADF, "unknown fid");
    function addFid(id, path, node) {
      const old = fids.get(id);
      if (old) dropFid(old);
      const f = { id, path, node, open: false, writable: false, append: false, listing: null, rcache: null, orphan: null };
      fids.set(id, f); allFids.add(f);
      return f;
    }
    function dropFid(f) {
      fids.delete(f.id); allFids.delete(f);
      if (f.writable && !f.orphanWriter) return release(f.node);
      return Promise.resolve();
    }
    const dirOf = (f) => { const node = nodeOf(f); if (node.kind !== "directory") fail(E.ENOTDIR); return node; };

    async function handle(type, tag, r) {
      switch (type) {
        case T.version: {
          const m = r.u32(), v = r.str();
          for (const f of [...fids.values()]) await dropFid(f).catch(() => {});
          msize = Math.max(MIN_MSIZE, Math.min(m, maxMsize));
          versioned = v === "9P2000.L";
          return reply(101, tag, (w) => { w.u32(msize); w.str(versioned ? "9P2000.L" : "unknown"); });
        }
        case T.auth: return error(tag, E.EOPNOTSUPP);
        case T.attach: {
          const fid = r.u32(); r.u32(); r.str(); r.str();
          if (!versioned) fail(E.EPROTO, "attach before version");
          const node = vfs.get(root);
          if (!node || node.kind !== "directory") fail(E.ENOENT, "export root missing");
          addFid(fid, root, node);
          return reply(105, tag, (w) => w.qid(qidOf(node)));
        }
        case T.walk: {
          const fid = r.u32(), newfid = r.u32(), n = r.u16();
          if (n > MAX_WALK) fail(E.EINVAL);
          const names = []; for (let i = 0; i < n; i++) names.push(r.str());
          const f = getFid(fid);
          if (newfid !== fid && fids.has(newfid)) fail(E.EBADF, "newfid in use");
          let path = f.path, node = nodeOf(f);
          const qs = [];
          for (const name of names) {
            if (node.kind !== "directory") { if (!qs.length) fail(E.ENOTDIR); break; }
            let next;
            if (name === "..") next = path === root ? root : parentPath(path);
            else if (name === ".") next = path;
            else { try { checkName(name); } catch (e) { if (!qs.length) throw e; break; } next = childPath(path, name); }
            const nn = vfs.get(next);
            if (!nn) { if (!qs.length) fail(E.ENOENT); break; }
            path = next; node = nn; qs.push(qidOf(nn));
          }
          if (qs.length === n) {
            if (newfid === fid) {
              if (f.open) fail(E.EBADF, "cannot walk an open fid in place");
              Object.assign(f, { path, node, rcache: null, listing: null });
            } else {
              if (n === 0 && f.orphan) fail(E.ENOENT);
              addFid(newfid, path, node);
            }
          }
          return reply(111, tag, (w) => { w.u16(qs.length); for (const q of qs) w.qid(q); });
        }
        case T.getattr: {
          const f = getFid(r.u32()); r.u64();
          const node = nodeOf(f), a = attrOf(f, node);
          const sec = Math.floor(a.mtimeMs / 1000), nsec = Math.floor((a.mtimeMs - sec * 1000) * 1e6);
          return reply(25, tag, (w) => {
            w.u64(0x7ff); w.qid(qidOf(node)); w.u32(a.mode); w.u32(0); w.u32(0);
            w.u64(a.nlink); w.u64(0); w.u64(a.size); w.u64(4096); w.u64(Math.ceil(a.size / 512));
            for (let i = 0; i < 3; i++) { w.u64(sec); w.u64(nsec); } // atime mtime ctime
            w.u64(0); w.u64(0); w.u64(0); w.u64(0);                 // btime gen data_version
          }, 160);
        }
        case T.setattr: {
          const f = getFid(r.u32());
          const valid = r.u32(), mode = r.u32(); r.u32(); r.u32();
          const size = r.u64(); r.u64(); r.u64(); const ms = r.u64(), mns = r.u64();
          const node = nodeOf(f);
          if (valid & ATTR.SIZE) {
            if (node.kind === "directory") fail(E.EISDIR);
            if (f.orphan) setOrphanSize(f.orphan, size);
            else await serial(node, async () => {
              const b = await bufferFor(node, f.path, { load: size > 0 });
              setSize(b, size); markDirty(b);
              if (!writers.has(node)) { commit(b); clearTimeout(b.timer); bufs.delete(node); }
            });
          }
          if (!f.orphan && (valid & (ATTR.MODE | ATTR.MTIME))) {
            await commitNode(node);
            const attrs = {};
            if (valid & ATTR.MODE) attrs.mode = mode & 0o7777;
            if (valid & ATTR.MTIME) attrs.mtimeMs = (valid & ATTR.MTIME_SET) ? ms * 1000 + Math.floor(mns / 1e6) : Date.now();
            if (typeof vfs.setAttributes === "function") vfs.setAttributes(f.path, attrs);
            else if (attrs.mode !== undefined) fail(E.EOPNOTSUPP, "this VFS has no modes");
          }
          return reply(27, tag);   // uid/gid/atime/ctime: accepted, not stored
        }
        case T.lopen: {
          const f = getFid(r.u32()), flags = r.u32();
          const node = nodeOf(f);
          if (f.open) fail(E.EINVAL, "fid already open");
          const acc = flags & DOTL_ACCMODE;
          if (node.kind === "directory") { if (acc !== 0) fail(E.EISDIR); }
          else if (acc !== 0) {
            f.writable = true; f.append = !!(flags & DOTL_APPEND);
            writers.set(node, (writers.get(node) ?? 0) + 1);
            if (flags & DOTL_TRUNC) await serial(node, async () => { const b = await bufferFor(node, f.path, { load: false }); setSize(b, 0); markDirty(b); });
          }
          f.open = true; f.listing = null;
          return reply(13, tag, (w) => { w.qid(qidOf(node)); w.u32(msize - IOHDRSZ); });
        }
        case T.lcreate: {
          const f = getFid(r.u32()), name = checkName(r.str()), flags = r.u32(), mode = r.u32(); r.u32();
          dirOf(f);
          const path = childPath(f.path, name);
          if (vfs.exists(path)) fail(E.EEXIST);
          if (f.open) fail(E.EINVAL);
          vfs.write(path, new Uint8Array(0));
          const perm = mode & 0o7777;
          if (perm !== 0o644 && typeof vfs.setAttributes === "function") vfs.setAttributes(path, { mode: perm });
          const node = vfs.get(path);
          Object.assign(f, { path, node, open: true, listing: null, rcache: null });
          if ((flags & DOTL_ACCMODE) !== 0) { f.writable = true; f.append = !!(flags & DOTL_APPEND); writers.set(node, (writers.get(node) ?? 0) + 1); }
          return reply(15, tag, (w) => { w.qid(qidOf(node)); w.u32(msize - IOHDRSZ); });
        }
        case T.read: {
          const f = getFid(r.u32()), off = r.u64(), count = r.u32();
          if (!f.open) fail(E.EBADF, "fid not open");
          const node = nodeOf(f);
          if (node.kind === "directory") fail(E.EISDIR);
          const max = Math.min(count, msize - RREAD_HDR);
          // The reply is built inside the node's queue so no write can change the bytes meanwhile.
          const send = (data, size) => {
            const n = off >= size ? 0 : Math.max(0, Math.min(max, size - off));
            reply(117, tag, (w) => { w.u32(n); if (n) w.bytes(data.subarray(off, off + n)); }, RREAD_HDR + n);
          };
          if (f.orphan) return send(f.orphan.data, f.orphan.size);
          return serial(node, async () => {
            const b = bufs.get(node);
            if (b && (b.dirty || b.rev === node.rev)) return send(b.data, b.size);
            if (!f.rcache || f.rcache.node !== node || f.rcache.rev !== node.rev) {
              f.rcache = null;
              const rev = node.rev, bytes = await vfs.read(f.path);
              if (vfs.get(f.path) !== node) fail(E.ENOENT);
              f.rcache = { node, rev, data: bytes };
            }
            send(f.rcache.data, f.rcache.data.length);
          });
        }
        case T.write: {
          const f = getFid(r.u32()), off = r.u64(), count = r.u32();
          const data = r.bytes(count);
          if (!f.open || !f.writable) fail(E.EBADF, "fid not open for writing");
          const node = nodeOf(f);
          if (f.orphan) {
            const o = f.orphan, at = f.append ? o.size : off;
            setOrphanSize(o, Math.max(o.size, at + count)); o.data.set(data, at);
          } else {
            await serial(node, async () => {
              const b = await bufferFor(node, f.path);
              const at = f.append ? b.size : off;
              if (at + count > maxFileBytes) fail(E.EFBIG);
              if (at + count > b.size) setSize(b, at + count);
              b.data.set(data, at);
              markDirty(b);
            });
          }
          return reply(119, tag, (w) => w.u32(count));
        }
        case T.readdir: {
          const f = getFid(r.u32()), off = r.u64(), count = r.u32();
          const node = dirOf(f);
          if (!f.open) fail(E.EBADF, "fid not open");
          if (off === 0 || !f.listing) f.listing = [".", "..", ...vfs.readdir(f.path)];  // snapshot per stream
          const limit = Math.min(count, msize - RREAD_HDR);
          const w2 = new Writer(Math.min(limit, 8192));
          for (let i = off; i < f.listing.length; i++) {
            const name = f.listing[i];
            const cp = name === "." ? f.path : name === ".." ? (f.path === root ? root : parentPath(f.path)) : childPath(f.path, name);
            const cn = name === "." ? node : vfs.get(cp);
            if (!cn) continue;
            const q = qidOf(cn), nb = te.encode(name).length;
            if (w2.n + 13 + 8 + 1 + 2 + nb > limit) break;
            w2.qid(q); w2.u64(i + 1); w2.u8(q.type === QT_DIR ? 4 : 8); w2.str(name);
          }
          return reply(41, tag, (w) => { w.u32(w2.n); w.bytes(w2.b.subarray(0, w2.n)); }, RREAD_HDR + w2.n);
        }
        case T.mkdir: {
          const f = getFid(r.u32()), name = checkName(r.str()), mode = r.u32(); r.u32();
          dirOf(f);
          const path = childPath(f.path, name);
          if (vfs.exists(path)) fail(E.EEXIST);
          vfs.mkdir(path, false);
          const perm = mode & 0o7777;
          if (perm !== 0o755 && typeof vfs.setAttributes === "function") vfs.setAttributes(path, { mode: perm });
          return reply(73, tag, (w) => w.qid(qidOf(vfs.get(path))));
        }
        case T.unlinkat: {
          const f = getFid(r.u32()), name = checkName(r.str()), flags = r.u32();
          dirOf(f);
          await unlinkPath(childPath(f.path, name), flags);
          return reply(77, tag);
        }
        case T.remove: {
          const f = getFid(r.u32());
          try {
            if (f.path === root) fail(E.EACCES);
            const node = nodeOf(f);
            await unlinkPath(f.path, node.kind === "directory" ? AT_REMOVEDIR : 0);
          } finally { await dropFid(f).catch(() => {}); }
          return reply(123, tag);
        }
        case T.renameat: {
          const of = getFid(r.u32()), oldname = checkName(r.str()), nf = getFid(r.u32()), newname = checkName(r.str());
          dirOf(of); dirOf(nf);
          await renamePath(childPath(of.path, oldname), childPath(nf.path, newname));
          return reply(75, tag);
        }
        case T.rename: {
          const f = getFid(r.u32()), df = getFid(r.u32()), name = checkName(r.str());
          nodeOf(f); dirOf(df);
          if (f.path === root) fail(E.EACCES);
          await renamePath(f.path, childPath(df.path, name));
          return reply(21, tag);
        }
        case T.fsync: {
          const f = getFid(r.u32()); r.u32();
          const node = nodeOf(f);
          if (!f.orphan) {
            await commitNode(node);
            try { await vfs.flush?.(); } catch (e) { fail(E.EIO, e?.message); }
          }
          return reply(51, tag);
        }
        case T.clunk: {
          const f = getFid(r.u32());
          const b = f.writable && !f.orphanWriter ? bufs.get(f.node) : null;
          await dropFid(f);
          if (b?.error) { const e = b.error; b.error = null; fail(errnoOf(e) === E.EACCES ? E.EACCES : E.EIO, e.message); }
          return reply(121, tag);
        }
        case T.statfs: {
          const f = getFid(r.u32()); nodeOf(f);
          const u = vfs.usage();
          const total = Math.max(1 << 20, Math.ceil(u.bytes / 4096) * 2);  // nominal: browser quota is not known here
          return reply(9, tag, (w) => {
            w.u32(0x01021997); w.u32(4096); w.u64(total); w.u64(total - Math.ceil(u.bytes / 4096)); w.u64(total - Math.ceil(u.bytes / 4096));
            w.u64(u.files + (1 << 20)); w.u64(1 << 20); w.u64(0x9f5); w.u32(255);
          });
        }
        case T.flush: {
          const oldtag = r.u16();
          const pending = inflight.get(oldtag);
          if (pending) await pending.catch(() => {});
          return reply(109, tag);
        }
        case T.lock: {
          const f = getFid(r.u32()); nodeOf(f);
          return reply(53, tag, (w) => w.u8(0));          // P9_LOCK_SUCCESS: single client, grant
        }
        case T.getlock: {
          const f = getFid(r.u32()); nodeOf(f);
          r.u8(); const start = r.u64(), length = r.u64(), procId = r.u32(), client = r.str();
          return reply(55, tag, (w) => { w.u8(2); w.u64(start); w.u64(length); w.u32(procId); w.str(client); }); // F_UNLCK
        }
        case T.readlink: { const f = getFid(r.u32()); nodeOf(f); fail(E.EINVAL, "not a symlink"); }
        // Unsupported by the page VFS: symlinks, device nodes, hard links, xattrs.
        case T.symlink: case T.mknod: case T.link: case T.xattrwalk: case T.xattrcreate:
          return error(tag, E.EOPNOTSUPP);
        default: return error(tag, E.EOPNOTSUPP);
      }
    }

    function setOrphanSize(o, size) {
      if (size > maxFileBytes) fail(E.EFBIG);
      if (size > o.data.length) { const nb = new Uint8Array(Math.max(size, o.data.length * 2)); nb.set(o.data.subarray(0, o.size)); o.data = nb; }
      else if (size < o.size) o.data.fill(0, size, o.size);
      o.size = size;
    }

    async function unlinkPath(path, flags) {
      const node = vfs.get(path) ?? fail(E.ENOENT);
      if (path === root) fail(E.EACCES);
      if (flags & AT_REMOVEDIR) {
        if (node.kind !== "directory") fail(E.ENOTDIR);
        if (vfs.readdir(path).length) fail(E.ENOTEMPTY);
      } else if (node.kind === "directory") fail(E.EISDIR);
      await serial(node, async () => {
        if (vfs.get(path) !== node) fail(E.ENOENT);
        await orphan(node, path);
        vfs.remove(path, { recursive: false });
      });
    }

    async function renamePath(from, to) {
      if (from === to) return;
      if (to.startsWith(from + "/")) fail(E.EINVAL, "cannot move a directory into itself");
      const src = vfs.get(from) ?? fail(E.ENOENT);
      const dst = vfs.get(to);
      if (dst) {
        if (src.kind === "directory" && dst.kind !== "directory") fail(E.ENOTDIR);
        if (src.kind !== "directory" && dst.kind === "directory") fail(E.EISDIR);
        if (dst.kind === "directory" && vfs.readdir(to).length) fail(E.ENOTEMPTY);
        await serial(dst, () => orphan(dst, to));
      }
      await serial(src, () => {
        if (vfs.get(from) !== src) fail(E.ENOENT);
        vfs.rename(from, to);
        rewritePaths(from, to);
      });
    }

    // ---- framing ----------------------------------------------------------------------------
    function peekU32() {
      let v = 0, i = 0;
      for (const c of chunks) for (let j = 0; j < c.length && i < 4; j++, i++) v += c[j] * 2 ** (8 * i);
      return v;
    }
    function take(n) {
      if (chunks[0].length >= n) {
        const c = chunks[0], out = c.subarray(0, n);
        if (c.length === n) chunks.shift(); else chunks[0] = c.subarray(n);
        have -= n; return out;
      }
      const out = new Uint8Array(n); let o = 0;
      while (o < n) {
        const c = chunks[0], k = Math.min(c.length, n - o);
        out.set(c.subarray(0, k), o); o += k;
        if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
      }
      have -= n; return out;
    }
    function pump() {
      while (!closed && have >= 4 && inflight.size < maxInflight && outBytes < maxOut) {
        const size = peekU32();
        if (size < 7 || size > msize) { log("p9: bad frame size", size); return shutdown(); }
        if (have < size) return;
        const msg = take(size);
        const type = msg[4], tag = msg[5] | (msg[6] << 8);
        stats.msgs++; stats.byType[type] = (stats.byType[type] || 0) + 1;
        const p = Promise.resolve().then(() => handle(type, tag, new Reader(msg, 7)))
          .catch((e) => { if (!(e instanceof P9Error)) log("p9: handler error", type, e?.message); error(tag, errnoOf(e)); })
          .finally(() => { if (inflight.get(tag) === p) inflight.delete(tag); pump(); });
        inflight.set(tag, p);
      }
    }
    function shutdown() {
      if (closed) return;
      closed = true;
      stats.disconnects++;
      chunks = []; have = 0; outq.length = 0; outBytes = 0;
      while (waiters.length) waiters.shift()(undefined);
      conns.delete(stream);
      // Commit whatever the guest wrote; open fids die with the connection.
      void Promise.allSettled([...inflight.values()]).then(() => Promise.allSettled([...fids.values()].map(dropFid)));
    }

    const stream = {
      read() {
        if (outq.length) {
          // Coalesce queued replies (fewer round trips through the worker bridge).
          let n = 0, k = 0;
          while (k < outq.length && (k === 0 || n + outq[k].length <= 256 * 1024)) n += outq[k++].length;
          const parts = outq.splice(0, k); outBytes -= n;
          let out;
          if (k === 1) out = parts[0];
          else { out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } }
          queueMicrotask(pump);
          return Promise.resolve(out);
        }
        if (closed) return Promise.resolve(undefined);
        return new Promise((resolve) => waiters.push(resolve));
      },
      write(bytes) {
        if (closed || !bytes?.length) return;
        stats.bytesIn += bytes.length;
        chunks.push(new Uint8Array(bytes)); have += bytes.length;   // copy: callers may reuse buffers
        if (have > maxIn) { log("p9: inbound queue overflow"); return shutdown(); }
        pump();
      },
      close() { shutdown(); },
      get closed() { return closed; },
    };
    conns.add(stream);
    return stream;
  }

  return {
    connect,
    /** Commit every buffered guest write to the VFS (optionally await IndexedDB persistence). */
    async sync({ persist = false } = {}) {
      await Promise.allSettled([...bufs.keys()].map((node) => commitNode(node)));
      if (persist) await vfs.flush?.();
    },
    /** Drop every connection (the guest sees EIO until it remounts). */
    closeAll() { for (const c of [...conns]) c.close(); },
    get connections() { return conns.size; },
    stats,
  };
}
