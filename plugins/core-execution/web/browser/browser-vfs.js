// Browser edition filesystem, persisted to IndexedDB with LAZY file contents:
//  - the tree (paths, kinds, sizes, dates) is loaded at startup and kept in memory;
//  - file contents are read from IndexedDB only when needed, and kept in a bounded cache
//    (least recently used, unsaved data is never dropped);
//  - changes are written back in batched transactions (~30 ms).
// So startup cost and memory depend on how much is used, not on how much is stored.
// Reads, appends and truncation are asynchronous; writes, listing and metadata are synchronous.

export class VfsError extends Error {
  constructor(code, message, path) {
    super(message);
    this.name = "VfsError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function normalizePath(path, cwd = "/", home = cwd) {
  let input = String(path ?? "");
  if (input.includes("\0")) throw new VfsError("invalid", "Paths cannot contain NUL", input);
  if (input === "~" || input.startsWith("~/")) input = home + input.slice(1);
  if (!input.startsWith("/")) input = `${cwd}/${input}`;
  const parts = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export const parentOf = (path) => path === "/" ? "/" : path.slice(0, path.lastIndexOf("/")) || "/";
export const nameOf = (path) => path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * IndexedDB persistence. Two stores:
 *   meta    path -> { kind, mtimeMs, size?, id?, mode? } (small, all read at startup)
 *   content id   -> Uint8Array                       (read on demand)
 * A file's content id stays the same across renames, so moving only touches `meta`.
 */
export class IdbBackend {
  backendName = "idb";
  constructor(name = "self-forming-fs") { this.name = name; this.db = undefined; }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("meta");
        request.result.createObjectStore("content");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable"));
      request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
    });
  }
  async loadMeta() {
    const store = this.db.transaction("meta", "readonly").objectStore("meta");
    const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()].map(requestPromise));
    return keys.map((key, index) => [key, values[index]]);
  }
  async readContent(id) {
    const value = await requestPromise(this.db.transaction("content", "readonly").objectStore("content").get(id));
    return value === undefined ? undefined : value instanceof Uint8Array ? value : new Uint8Array(value);
  }
  /** Apply meta and content puts (value) / deletes (undefined) in one atomic transaction. */
  save({ meta = [], content = [] }) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["meta", "content"], "readwrite");
      const metaStore = tx.objectStore("meta");
      const contentStore = tx.objectStore("content");
      for (const [id, data] of content) data ? contentStore.put(data, id) : contentStore.delete(id);
      for (const [path, record] of meta) record ? metaStore.put(record, path) : metaStore.delete(path);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save files"));
      tx.onabort = () => reject(tx.error ?? new Error("Saving files was aborted (storage full?)"));
    });
  }
  close() { this.db?.close(); }
}
function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Memory only (nothing survives a page reload). Same interface; for tests and private windows. */
export class MemoryBackend {
  backendName = "memory";
  #meta = new Map();
  #content = new Map();
  async open() {}
  async loadMeta() { return [...this.#meta].map(([path, record]) => [path, { ...record }]); }
  async readContent(id) { return this.#content.get(id)?.slice(); }
  async save({ meta = [], content = [] }) {
    for (const [id, data] of content) data ? this.#content.set(id, data.slice()) : this.#content.delete(id);
    for (const [path, record] of meta) record ? this.#meta.set(path, { ...record }) : this.#meta.delete(path);
  }
  close() {}
}

/** Remove storage left by earlier versions of the browser edition (best effort, once per start). */
async function removeLegacyStorage() {
  try { globalThis.indexedDB?.deleteDatabase?.("self-forming-vfs"); } catch { /* ignore */ }
  try {
    const root = await globalThis.navigator?.storage?.getDirectory?.();
    await root?.removeEntry?.("self-forming-vfs", { recursive: true });
  } catch { /* not present */ }
}

// Optional POSIX permission bits per node (e.g. the executable bit set by `chmod +x` in Linux).
// Records without `mode` (all records written before modes existed) use these defaults.
export const DEFAULT_FILE_MODE = 0o644;
export const DEFAULT_DIR_MODE = 0o755;
const validMode = (mode) => Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;

const CACHE_BYTES = 64 * 1024 * 1024; // file contents kept in memory beyond what is unsaved
let idCounter = 0;
const newContentId = () => globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

export class Vfs {
  // path -> directory { kind, mtimeMs, mode? } | file { kind, mtimeMs, size, id, mode?, data?: Uint8Array, rev }
  #nodes = new Map();
  #children = new Map();   // directory path -> Set(names)
  #dirty = new Set();      // paths whose meta must be saved
  #content = new Map();    // content id -> Uint8Array to save (snapshot taken at write time)
  #removedIds = new Set(); // content ids to delete
  #pending = new Set();    // content ids being saved right now (must not be evicted)
  #cache = new Map();      // content id -> node, insertion order = least recently used first
  #cachedBytes = 0;
  #appendQueue = new Map();// path -> promise chain (appends to one file run in order)
  #flushing = Promise.resolve();
  #timer;
  #listeners = new Set();
  #backend;
  #failure;

  constructor(backend, roots) {
    this.#backend = backend;
    this.roots = roots;
    this.#nodes.set("/", { kind: "directory", mtimeMs: Date.now() });
    this.#children.set("/", new Set());
  }

  static async open({ backend, roots = ["/workspace", "/tmp", "/data"] } = {}) {
    if (!backend) { backend = new IdbBackend(); void removeLegacyStorage(); }
    const vfs = new Vfs(backend, roots);
    await backend.open();
    const records = await backend.loadMeta();
    records.sort(([a], [b]) => a.split("/").length - b.split("/").length);
    for (const [path, record] of records) {
      if (typeof path !== "string" || !path.startsWith("/") || path === "/" || !record) continue;
      vfs.#ensureParents(path, false);
      const node = record.kind === "directory"
        ? { kind: "directory", mtimeMs: record.mtimeMs ?? Date.now() }
        : { kind: "file", mtimeMs: record.mtimeMs ?? Date.now(), size: record.size ?? 0, id: record.id ?? newContentId(), rev: 0 };
      if (validMode(record.mode)) node.mode = record.mode;
      vfs.#insert(path, node);
    }
    for (const root of roots) if (!vfs.#nodes.has(root)) vfs.mkdir(root, true);
    return vfs;
  }

  /** Which persistence backend is active: "idb" | "memory" (diagnostics). */
  get backendName() { return this.#backend?.backendName ?? "memory"; }

  // ------------------------------------------------------------ inspection (synchronous)
  /** Node metadata: { kind, mtimeMs, size? }. File contents are not included: use read(). */
  get(path) { return this.#nodes.get(path); }
  exists(path) { return this.#nodes.has(path); }
  info(path) {
    const node = this.#require(path);
    return { name: nameOf(path), path, kind: node.kind, size: node.kind === "file" ? node.size : 0, mtimeMs: node.mtimeMs };
  }
  /** Permission bits (0o7777): the stored mode, or 0o644 for files / 0o755 for directories. */
  modeOf(path) {
    const node = this.#require(path);
    return node.mode ?? (node.kind === "directory" ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE);
  }
  readdir(path) {
    const node = this.#require(path);
    if (node.kind !== "directory") throw new VfsError("not_directory", "Not a directory", path);
    return [...this.#children.get(path)].sort();
  }
  /** Every path at or below `path`, parents first. */
  walk(path) {
    const out = [];
    const visit = (current) => {
      out.push(current);
      for (const name of this.#children.get(current) ?? []) visit(current === "/" ? `/${name}` : `${current}/${name}`);
    };
    if (this.#nodes.has(path)) visit(path);
    return out;
  }
  usage() {
    let files = 0, bytes = 0;
    for (const node of this.#nodes.values()) if (node.kind === "file") { files++; bytes += node.size; }
    return { files, bytes, cachedBytes: this.#cachedBytes };
  }

  // ------------------------------------------------------------ contents (asynchronous)
  /** File contents. Do not modify the returned bytes (copy them first). */
  async read(path) {
    const node = this.#require(path);
    if (node.kind === "directory") throw new VfsError("is_directory", "Is a directory", path);
    return this.#load(node, path);
  }

  // ------------------------------------------------------------ mutation
  write(path, bytes) {
    this.#assertWritable(path);
    const existing = this.#nodes.get(path);
    if (existing?.kind === "directory") throw new VfsError("is_directory", "Is a directory", path);
    this.#ensureParents(path, true);
    const data = bytes.slice();
    if (existing) this.#setData(existing, data);
    else {
      const node = { kind: "file", mtimeMs: Date.now(), size: 0, id: newContentId(), rev: 0 };
      this.#insert(path, node);
      this.#setData(node, data);
    }
    this.#touch(path);
    return this.#nodes.get(path);
  }
  /** Append bytes (creating the file if needed). Appends to the same file run in call order. */
  append(path, bytes) {
    const copy = bytes.slice();
    const previous = this.#appendQueue.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      this.#assertWritable(path);
      const existing = this.#nodes.get(path);
      if (!existing) { this.write(path, copy); return; }
      if (existing.kind === "directory") throw new VfsError("is_directory", "Is a directory", path);
      const current = await this.#load(existing, path);
      if (this.#nodes.get(path) !== existing) { await this.append(path, copy); return; } // replaced meanwhile
      this.#setData(existing, concat(current, copy));
      this.#touch(path);
    });
    this.#appendQueue.set(path, next);
    void next.finally(() => { if (this.#appendQueue.get(path) === next) this.#appendQueue.delete(path); }).catch(() => {});
    return next;
  }
  async truncate(path, size) {
    const node = this.#require(path);
    this.#assertWritable(path);
    if (node.kind !== "file") throw new VfsError("is_directory", "Is a directory", path);
    const current = await this.#load(node, path);
    const data = new Uint8Array(size);
    data.set(current.subarray(0, Math.min(size, current.byteLength)));
    this.#setData(node, data);
    this.#touch(path);
  }
  mkdir(path, recursive = true) {
    this.#assertWritable(path);
    const existing = this.#nodes.get(path);
    if (existing) {
      if (existing.kind !== "directory") throw new VfsError("not_directory", "A file exists at this path", path);
      if (!recursive) throw new VfsError("invalid", "Directory already exists", path);
      return;
    }
    if (!recursive && !this.#nodes.has(parentOf(path))) throw new VfsError("not_found", "Parent directory does not exist", path);
    this.#ensureParents(path, true);
    this.#insert(path, { kind: "directory", mtimeMs: Date.now() });
    this.#touch(path);
  }
  remove(path, { recursive = false, force = false } = {}) {
    if (path === "/" || this.roots.includes(path)) throw new VfsError("permission_denied", "Workspace roots cannot be removed", path);
    this.#assertWritable(path);
    const node = this.#nodes.get(path);
    if (!node) { if (force) return; throw new VfsError("not_found", "No such file or directory", path); }
    if (node.kind === "directory" && this.#children.get(path).size && !recursive) throw new VfsError("invalid", "Directory is not empty", path);
    const removed = this.walk(path);
    for (const item of removed.reverse()) {
      const gone = this.#nodes.get(item);
      if (gone?.kind === "file") this.#dropContent(gone);
      this.#nodes.delete(item);
      this.#children.delete(item);
      this.#dirty.add(item);
    }
    this.#children.get(parentOf(path))?.delete(nameOf(path));
    this.#touch(path, false);
  }
  rename(source, destination) {
    this.#assertWritable(source);
    this.#assertWritable(destination);
    if (this.roots.includes(source)) throw new VfsError("permission_denied", "Workspace roots cannot be moved", source);
    const node = this.#require(source);
    if (source === destination) return;
    if (within(destination, source)) throw new VfsError("invalid", "Cannot move a folder into itself", destination);
    const target = this.#nodes.get(destination);
    if (target) {
      if (target.kind === "directory" && node.kind !== "directory") throw new VfsError("is_directory", "Destination is a directory", destination);
      if (target.kind === "directory" && this.#children.get(destination).size) throw new VfsError("invalid", "Destination directory is not empty", destination);
      this.remove(destination, { recursive: true });
    }
    this.#ensureParents(destination, true);
    const moved = this.walk(source);
    for (const from of moved) {
      const to = destination + from.slice(source.length);
      this.#nodes.set(to, this.#nodes.get(from));
      if (this.#children.has(from)) this.#children.set(to, this.#children.get(from));
      this.#nodes.delete(from);
      this.#children.delete(from);
      this.#dirty.add(from);
      this.#dirty.add(to);
    }
    this.#children.get(parentOf(source)).delete(nameOf(source));
    this.#children.get(parentOf(destination)).add(nameOf(destination));
    node.mtimeMs = Date.now();
    this.#touch(source, false);
    this.#touch(destination);
  }

  /**
   * Change metadata without touching contents: { mode } (permission bits 0..0o7777, persisted)
   * and/or { mtimeMs }. Used by the Linux live /workspace (chmod, touch -d, cp -p, tar).
   */
  setAttributes(path, { mode, mtimeMs } = {}) {
    const node = this.#require(path);
    this.#assertWritable(path);
    if (mode !== undefined && !validMode(mode)) throw new VfsError("invalid", "Mode must be an integer between 0 and 0o7777", path);
    if (mtimeMs !== undefined && !Number.isFinite(mtimeMs)) throw new VfsError("invalid", "mtimeMs must be a finite number", path);
    if (mode !== undefined) node.mode = mode;
    if (mtimeMs !== undefined) node.mtimeMs = mtimeMs;
    this.#touch(path);
  }

  /** Resolves once everything changed so far is saved. */
  async flush() {
    if (this.#failure) throw this.#failure;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const meta = [...this.#dirty].map((path) => {
      const node = this.#nodes.get(path);
      if (!node) return [path, undefined];
      const record = node.kind === "directory" ? { kind: "directory", mtimeMs: node.mtimeMs } : { kind: "file", mtimeMs: node.mtimeMs, size: node.size, id: node.id };
      if (node.mode !== undefined) record.mode = node.mode;
      return [path, record];
    });
    const content = [...this.#content];
    for (const id of this.#removedIds) content.push([id, undefined]);
    this.#dirty.clear();
    this.#content.clear();
    this.#removedIds.clear();
    const ids = content.map(([id]) => id);
    for (const id of ids) this.#pending.add(id);
    const previous = this.#flushing;
    this.#flushing = (async () => {
      await previous.catch(() => {});
      try { if (meta.length || content.length) await this.#backend.save({ meta, content }); }
      finally { for (const id of ids) this.#pending.delete(id); this.#evict(); }
    })();
    try { await this.#flushing; }
    catch (cause) { this.#failure = cause instanceof Error ? cause : new Error(String(cause)); throw this.#failure; }
  }

  /** listener(paths: string[]) after each change; returns an unsubscribe function. */
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  // ------------------------------------------------------------ internals
  async #load(node, path) {
    if (node.data) { this.#remember(node); return node.data; }
    if (!node.size) return this.#setCached(node, new Uint8Array(0));
    node.loading ??= (async () => {
      const rev = node.rev;
      const data = await this.#backend.readContent(node.id);
      if (data === undefined) throw new VfsError("io", "File contents are missing from browser storage", path);
      // A write that happened while loading wins over the older stored bytes.
      return node.rev === rev && !node.data ? this.#setCached(node, data) : node.data ?? data;
    })().finally(() => { node.loading = undefined; });
    return node.loading;
  }
  #setData(node, data) {
    node.rev = (node.rev ?? 0) + 1;
    node.mtimeMs = Date.now();
    node.size = data.byteLength;
    this.#content.set(node.id, data);
    this.#setCached(node, data);
  }
  #setCached(node, data) {
    if (node.data) this.#cachedBytes -= node.data.byteLength;
    node.data = data;
    this.#cachedBytes += data.byteLength;
    this.#remember(node);
    this.#evict();
    return data;
  }
  #remember(node) { this.#cache.delete(node.id); this.#cache.set(node.id, node); }
  #dropContent(node) {
    if (node.data) this.#cachedBytes -= node.data.byteLength;
    node.data = undefined;
    this.#cache.delete(node.id);
    this.#content.delete(node.id);
    this.#removedIds.add(node.id);
  }
  /** Drop least recently used contents beyond the budget; never unsaved or saving ones. */
  #evict() {
    if (this.#cachedBytes <= CACHE_BYTES) return;
    for (const [id, node] of this.#cache) {
      if (this.#cachedBytes <= CACHE_BYTES) break;
      if (this.#content.has(id) || this.#pending.has(id)) continue;
      if (node.data) this.#cachedBytes -= node.data.byteLength;
      node.data = undefined;
      this.#cache.delete(id);
    }
  }
  #require(path) {
    const node = this.#nodes.get(path);
    if (!node) {
      const parent = this.#nodes.get(parentOf(path));
      if (parent && parent.kind !== "directory") throw new VfsError("not_directory", "A parent is not a directory", path);
      throw new VfsError("not_found", "No such file or directory", path);
    }
    return node;
  }
  #assertWritable(path) {
    if (this.#failure) throw new VfsError("unknown", `Browser storage failed: ${this.#failure.message}`, path);
    if (!this.roots.some((root) => within(path, root)))
      throw new VfsError("permission_denied", `Only ${this.roots.join(", ")} can be changed`, path);
  }
  #insert(path, node) {
    this.#nodes.set(path, node);
    if (node.kind === "directory" && !this.#children.has(path)) this.#children.set(path, new Set());
    this.#children.get(parentOf(path))?.add(nameOf(path));
  }
  #ensureParents(path, markDirty) {
    const missing = [];
    for (let parent = parentOf(path); !this.#nodes.has(parent); parent = parentOf(parent)) missing.unshift(parent);
    const top = parentOf(missing[0] ?? path);
    if (this.#nodes.get(top)?.kind === "file") throw new VfsError("not_directory", "A parent is a file", path);
    for (const dir of missing) {
      this.#insert(dir, { kind: "directory", mtimeMs: Date.now() });
      if (markDirty) this.#dirty.add(dir);
    }
    if (this.#nodes.get(parentOf(path))?.kind === "file") throw new VfsError("not_directory", "A parent is a file", path);
  }
  #touch(path, markSelf = true) {
    if (markSelf) this.#dirty.add(path);
    if (!this.#timer) this.#timer = setTimeout(() => { void this.flush().catch(() => {}); }, 30);
    for (const listener of this.#listeners) {
      try { listener([path]); } catch { /* listeners are independent */ }
    }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
