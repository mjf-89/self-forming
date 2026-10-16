// Browser-only Git: no runtime CDN, credential store or invented identity. The one Node shim is a
// global Buffer (vendored, see vendor/buffer), which isomorphic-git requires in browsers.
import "./browser-buffer-global.js";
import git from "../../../apps/browser/vendor/isomorphic-git/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encodingOf = (options) => typeof options === "string" ? options : options?.encoding;
function bytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Expected text, ArrayBuffer or a typed array");
}
function error(code, message, path) {
  return Object.assign(new Error(message), { code, ...(path === undefined ? {} : { path }) });
}
const errorCodes = {
  not_found: "ENOENT", not_directory: "ENOTDIR", is_directory: "EISDIR",
  permission_denied: "EACCES", invalid: "EINVAL", unknown: "EIO",
};
function fsError(cause, path) {
  // RPC errors retain code/path but not the VfsError prototype. Never infer ENOENT
  // from generic failure: permission and persistence errors must remain errors.
  const code = errorCodes[cause?.code] || cause?.code || "EIO";
  return Object.assign(error(code, cause?.message || "Filesystem operation failed", cause?.path ?? path), { cause });
}
function absolute(path, cwd) {
  if (typeof path !== "string" || path.includes("\0")) throw error("EINVAL", "Expected a path without NUL", path);
  const parts = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Adapt the console worker's async fs (or its raw RPC-result shapes) to Git's
 * Node-style promise filesystem. Vfs itself uses read/write/info: give this
 * function the worker facade, not the Vfs instance. Exported for integration tests.
 * Missing symlinks fail explicitly. VFS has no executable bits; writes requesting
 * them fail rather than silently corrupting the checked-out tree.
 */
export function createGitFs(fs, cwd = "/workspace") {
  const source = fs?.promises || fs;
  for (const name of ["readFile", "writeFile", "stat", "readdir", "mkdir", "rm"]) {
    if (typeof source?.[name] !== "function") throw new TypeError(`Git fs requires async ${name}()`);
  }
  cwd = absolute(cwd, "/");
  const at = (path) => absolute(path, cwd);
  const invoke = async (op, path, ...args) => {
    path = at(path);
    try { return await source[op](path, ...args); }
    catch (cause) { throw fsError(cause, path); }
  };
  const stat = async (path, lstat = false) => {
    const info = await invoke(lstat && source.lstat ? "lstat" : "stat", path);
    const directory = info.kind === "directory" || info.isDirectory?.() === true;
    const symlink = info.kind === "symlink" || info.isSymbolicLink?.() === true;
    const mtimeMs = Number(info.mtimeMs ?? info.mtime?.valueOf() ?? 0);
    const ctimeMs = Number(info.ctimeMs ?? info.ctime?.valueOf() ?? mtimeMs);
    return {
      ...info, size: Number(info.size ?? 0), mtimeMs, ctimeMs,
      mtime: new Date(mtimeMs), ctime: new Date(ctimeMs),
      mode: info.mode ?? (directory ? 0o40755 : symlink ? 0o120777 : 0o100644),
      dev: info.dev ?? 0, uid: info.uid ?? 0, gid: info.gid ?? 0,
      // VFS has no inodes or change counters and its millisecond mtime can repeat.
      // Upstream compares ONLY whole seconds for index cache hits. NaN means
      // "unknown inode": the index serializes it as zero, but it never compares
      // equal, forcing rehashing even after reload and same-clock-tick edits.
      // Do not invent a stable inode and accidentally enable unsafe cache hits.
      ino: info.ino ?? Number.NaN,
      isFile: () => !directory && !symlink,
      isDirectory: () => directory, isSymbolicLink: () => symlink,
    };
  };
  const api = {
    async readFile(path, options) {
      const data = await invoke("readFile", path);
      const encoding = encodingOf(options);
      if (encoding && !["utf8", "utf-8", "buffer"].includes(encoding)) throw error("ENOTSUP", "Only UTF-8 encoding is supported", path);
      return encoding && encoding !== "buffer" ? (typeof data === "string" ? data : decoder.decode(bytes(data))) : bytes(data);
    },
    async writeFile(path, data, options) {
      if (options?.mode !== undefined && (options.mode & 0o111)) {
        throw error("ENOTSUP", "Browser VFS cannot preserve executable file modes", at(path));
      }
      return invoke("writeFile", path, bytes(data));
    },
    stat: (path) => stat(path),
    lstat: (path) => stat(path, true),
    async readdir(path) {
      const entries = await invoke("readdir", path);
      return entries.map((entry) => typeof entry === "string" ? entry : entry.name);
    },
    async mkdir(path, options) {
      const recursive = Boolean(options?.recursive);
      // VFS reports existing directory as `invalid`, not EEXIST. A preflight
      // distinguishes this from genuinely invalid paths, without message matching.
      try {
        const info = await stat(path);
        if (recursive && info.isDirectory()) return;
        throw error("EEXIST", "File or directory already exists", at(path));
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
      try { return await invoke("mkdir", path, { recursive }); }
      catch (cause) {
        if (cause.code === "EINVAL" || cause.code === "ENOTDIR") {
          try { await stat(path); } catch { throw cause; }
          throw error("EEXIST", "File or directory already exists", at(path));
        }
        throw cause;
      }
    },
    async unlink(path) {
      if ((await stat(path, true)).isDirectory()) throw error("EISDIR", "Is a directory", at(path));
      return invoke("rm", path, { recursive: false, force: false });
    },
    async rmdir(path, options) {
      if (!(await stat(path)).isDirectory()) throw error("ENOTDIR", "Not a directory", at(path));
      if (!options?.recursive && (await api.readdir(path)).length) throw error("ENOTEMPTY", "Directory is not empty", at(path));
      return invoke("rm", path, { recursive: Boolean(options?.recursive), force: false });
    },
    async rm(path, options) {
      let info;
      try { info = await stat(path, true); }
      catch (cause) { if (options?.force && cause.code === "ENOENT") return; throw cause; }
      if (info.isDirectory() && !options?.recursive) throw error("EISDIR", "Use recursive removal for directories", at(path));
      return invoke("rm", path, { recursive: Boolean(options?.recursive), force: Boolean(options?.force) });
    },
    async readlink(path, options) {
      if (source.readlink) return invoke("readlink", path, options);
      await stat(path);
      throw error("EINVAL", "Browser VFS does not contain symbolic links", at(path));
    },
    async symlink(target, path) {
      if (!source.symlink) throw error("ENOTSUP", "Browser VFS does not support symbolic links", at(path));
      try { return await source.symlink(target, at(path)); }
      catch (cause) { throw fsError(cause, at(path)); }
    },
  };
  return { promises: api };
}

function safeUrl(value, remote = false) {
  let url;
  try { url = new URL(value); } catch { throw error("InvalidGitUrl", "Git requires an absolute HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol)) throw error("InvalidGitUrl", "Only Git over HTTP(S) is supported");
  if (url.username || url.password || (remote && (url.search || url.hash))) {
    // Do not echo the supplied URL: it might contain a credential.
    throw error("UnsafeGitUrl", "Use a credential-free Git URL; supply credentials through onAuth instead");
  }
  return url;
}
function streamBody(body) {
  if (body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
  if (typeof body.getReader === "function") return body;
  const iterator = body[Symbol.asyncIterator]?.() || body[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("Git HTTP body must be bytes, a stream, or an iterable of byte chunks");
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(bytes(value));
      } catch (cause) { controller.error(cause); }
    },
    async cancel(reason) { await iterator.return?.(reason); },
  }, { highWaterMark: 0 });
}
async function* responseChunks(body) {
  if (!body) return;
  const reader = body.getReader();
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; return; }
      yield bytes(value);
    }
  } finally {
    try { if (!complete) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

/** Fetch transport with backpressure in both directions. No arrayBuffer()/Blob
 * accumulation, cookie auth, retries, credential persistence or CDN. Streaming
 * uploads require browser Fetch duplex support and an HTTP/2-or-3 endpoint;
 * unsupported browsers/endpoints fail rather than buffering a pack silently.
 */
export function createGitHttp(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("Git HTTP requires fetch");
  return {
    async request({ url, method = "GET", headers = {}, body, signal, fetchOptions = {} }) {
      safeUrl(url);
      const requestBody = streamBody(body);
      const requestHeaders = new Headers(fetchOptions.headers);
      new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
      const init = {
        ...fetchOptions, method, headers: requestHeaders,
        body: requestBody, signal: signal ?? fetchOptions.signal,
        credentials: "omit", // Never use the browser's persistent cookie jar.
      };
      if (requestBody && typeof requestBody.getReader === "function") init.duplex = "half";
      const response = await fetchImpl(url, init);
      return {
        url: response.url || url, method,
        statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseChunks(response.body),
      };
    },
  };
}

const operations = [
  "init", "status", "statusMatrix", "add", "remove", "commit", "log",
  "branch", "deleteBranch", "renameBranch", "currentBranch", "listBranches", "checkout",
  "clone", "fetch", "pull", "push", "merge", "fastForward",
  "addRemote", "deleteRemote", "listRemotes", "getRemoteInfo", "getRemoteInfo2", "listServerRefs",
  "listFiles", "listTags", "tag", "annotatedTag", "deleteTag", "resolveRef", "expandRef",
  "readBlob", "readCommit", "readTree", "readTag", "isIgnored", "isDescendent", "findMergeBase",
  "getConfig", "getConfigAll", "resetIndex", "abortMerge",
];
const needsAuthor = new Set(["commit", "merge", "pull"]);
function identity(value) {
  if (!value || typeof value.name !== "string" || !value.name.trim() || typeof value.email !== "string") {
    throw error("AuthorRequired", "Supply an explicit { name, email } identity or an onAuthor callback");
  }
  return { ...value };
}

/**
 * createBrowserGit({ fs, fetch?, cwd = '/workspace', onAuthor?, onAuth?,
 *                    onAuthSuccess?, onAuthFailure? })
 *
 * Returns bound async methods listed above, plus version(). Each method takes
 * the upstream isomorphic-git options object and returns its upstream result.
 * fs/http/dir are bound (cannot be overridden); gitdir can select another git
 * directory. Repository paths are not a security sandbox: VFS enforces roots.
 *
 * commit/merge/pull require options.author or await onAuthor({ operation, dir });
 * annotatedTag requires options.tagger or that callback. An explicit committer
 * is optional, defaulting to that same user-provided identity, never config.
 * Callback defaults can be overridden per operation. Auth callbacks are upstream
 * onAuth(url, auth), onAuthSuccess(url, auth), onAuthFailure(url, auth). Return
 * credentials (or {cancel:true}) only for that request. Nothing is saved here.
 * No setConfig API: identity/auth must remain explicit. URLs cannot embed auth,
 * queries or fragments. Progress/message callbacks are passed through unchanged.
 */
export function createBrowserGit({ fs, fetch: fetchImpl, cwd = "/workspace", onAuthor, onAuth, onAuthSuccess, onAuthFailure } = {}) {
  const dir = absolute(cwd, "/");
  const filesystem = createGitFs(fs, dir);
  const http = createGitHttp(fetchImpl);
  const defaults = { onAuth, onAuthSuccess, onAuthFailure };
  const api = { version: () => git.version() };
  for (const operation of operations) {
    api[operation] = async (options = {}) => {
      const args = { ...defaults, ...options, fs: filesystem, http, dir };
      if (args.url !== undefined) safeUrl(args.url, true);
      if (args.corsProxy !== undefined) safeUrl(args.corsProxy, true);
      if (needsAuthor.has(operation) || operation === "annotatedTag") {
        const key = operation === "annotatedTag" ? "tagger" : "author";
        args[key] = identity(args[key] ?? await (options.onAuthor ?? onAuthor)?.({ operation, dir }));
        if (key === "author") args.committer = identity(args.committer ?? args.author);
      }
      delete args.onAuthor;
      return git[operation](args);
    };
  }
  return Object.freeze(api);
}
