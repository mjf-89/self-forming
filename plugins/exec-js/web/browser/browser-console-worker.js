// Browser edition: one JavaScript "command" runs in a fresh module Worker.
// The page owns the files; `fs` calls are forwarded to it with postMessage.
// Protocol (page -> worker): { type: "run", code, argv, cwd, home, env } (argv: process.argv)
//                            { type: "fs-result", callId, ok, value?, error? }
// Protocol (worker -> page): { type: "out", stream, text } | { type: "fs", callId, op, args } | { type: "done", exitCode }

let callSeq = 0;
const calls = new Map();
let cwd = "/workspace";

function send(message) { postMessage(message); }
function out(stream, text) { if (text) send({ type: "out", stream, text }); }

function call(op, ...args) {
  const callId = ++callSeq;
  return new Promise((resolve, reject) => {
    calls.set(callId, { resolve, reject });
    send({ type: "fs", callId, op, args, cwd });
  });
}

// Fetch response bytes only cross the worker boundary in answer to a pull.
// Uploads are buffered (Request bodies are not structured-cloneable everywhere).
let requestSeq = 0;
function netCall(requestId, op, fields = {}) {
  const callId = ++callSeq;
  return new Promise((resolve, reject) => {
    calls.set(callId, { resolve, reject, requestId });
    send({ type: "net", callId, requestId, op, ...fields });
  });
}
async function proxyFetch(input, init, tor = false) {
  const request = new Request(input, init);
  const requestId = ++requestSeq;
  let streamController;
  let uploadReader;
  let closed = false;
  const cleanup = () => { closed = true; request.signal.removeEventListener("abort", abort); };
  const cancel = (reason) => {
    if (closed) return;
    cleanup();
    send({ type: "net", requestId, op: "cancel" });
    for (const [id, pending] of calls) if (pending.requestId === requestId) {
      calls.delete(id);
      pending.reject(reason);
    }
  };
  const abort = () => {
    const reason = request.signal.reason ?? new DOMException("Request cancelled", "AbortError");
    cancel(reason);
    void uploadReader?.cancel(reason).catch(() => {});
    streamController?.error(reason);
  };
  if (request.signal.aborted) throw request.signal.reason;
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    let body;
    if (request.body) {
      uploadReader = request.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await uploadReader.read();
          if (done) break;
          chunks.push(value); size += value.byteLength;
        }
      } finally { uploadReader.releaseLock(); uploadReader = undefined; }
      if (request.signal.aborted) throw request.signal.reason;
      body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
    if (request.signal.aborted) throw request.signal.reason;
    const meta = await netCall(requestId, "start", { tor, url: request.url, init: {
      method: request.method, headers: [...request.headers], body,
      credentials: request.credentials, redirect: request.redirect,
      cache: request.cache, mode: request.mode, referrerPolicy: request.referrerPolicy,
      integrity: request.integrity, keepalive: request.keepalive,
    } });
    const stream = meta.hasBody ? new ReadableStream({
      start(controller) { streamController = controller; },
      async pull(controller) {
        try {
          const chunk = await netCall(requestId, "pull");
          if (closed) return;
          if (chunk.done) { cleanup(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { cancel(error); controller.error(error); }
      },
      cancel(reason) { cancel(reason ?? new DOMException("Stream cancelled", "AbortError")); },
    }, { highWaterMark: 0 }) : null;
    if (!meta.hasBody) cleanup();
    const response = new Response(stream, { status: meta.status, statusText: meta.statusText, headers: meta.headers });
    Object.defineProperties(response, {
      url: { value: meta.url || request.url }, redirected: { value: Boolean(meta.redirected) },
    });
    return response;
  } catch (error) { cancel(error); throw error; }
}

// git@1 RPC: execution knows only the service contract, never the owner module.
// Functions cannot be structured-cloned; callbacks stay in this worker and are
// invoked explicitly by the page for the duration of this operation only.
const gitCallbacks = new Map();
const git = new Proxy({}, { get(_target, operation) {
  if (operation === "then") return undefined;
  return async (options = {}) => {
    const callId = ++callSeq;
    const callbacks = {};
    const input = { ...options };
    for (const name of ["onAuthor", "onAuth", "onAuthSuccess", "onAuthFailure", "onProgress", "onMessage"]) {
      if (typeof input[name] === "function") { callbacks[name] = input[name]; delete input[name]; }
    }
    gitCallbacks.set(callId, callbacks);
    try {
      return await new Promise((resolve, reject) => {
        calls.set(callId, { resolve, reject });
        try { send({ type: "git", callId, operation, cwd, options: input, callbacks: Object.keys(callbacks) }); }
        catch (error) { calls.delete(callId); reject(error); }
      });
    } finally { gitCallbacks.delete(callId); }
  };
} });

// ------------------------------------------------------------------ inspect
function inspect(value, depth = 2, seen = new WeakSet()) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "undefined") return "undefined";
  if (type === "number" || type === "boolean") return String(value);
  if (type === "bigint") return `${value}n`;
  if (type === "symbol") return value.toString();
  if (type === "function") return `[Function ${value.name || "(anonymous)"}]`;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (seen.has(value)) return "[Circular]";
  if (ArrayBuffer.isView(value)) {
    const items = Array.from(value.slice(0, 50), String);
    return `${value.constructor.name}(${value.length}) [${items.join(", ")}${value.length > 50 ? ", …" : ""}]`;
  }
  if (depth < 0) return Array.isArray(value) ? "[Array]" : "[Object]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, 100).map((item) => inspect(item, depth - 1, seen));
      if (value.length > 100) items.push(`… ${value.length - 100} more`);
      return wrap("[", items, "]");
    }
    if (value instanceof Map) return wrap(`Map(${value.size}) {`, [...value].slice(0, 100).map(([k, v]) => `${inspect(k, depth - 1, seen)} => ${inspect(v, depth - 1, seen)}`), "}");
    if (value instanceof Set) return wrap(`Set(${value.size}) {`, [...value].slice(0, 100).map((v) => inspect(v, depth - 1, seen)), "}");
    if (typeof value.then === "function") return "Promise { … }";
    const name = value.constructor && value.constructor !== Object ? `${value.constructor.name} ` : "";
    const keys = Object.keys(value);
    const items = keys.slice(0, 100).map((key) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${inspect(value[key], depth - 1, seen)}`);
    if (keys.length > 100) items.push(`… ${keys.length - 100} more`);
    return wrap(`${name}{`, items, "}");
  } finally { seen.delete(value); }
}
function wrap(open, items, close) {
  if (!items.length) return `${open}${close}`;
  const flat = `${open} ${items.join(", ")} ${close}`;
  return flat.length <= 76 && !flat.includes("\n") ? flat : `${open}\n${items.map((item) => `  ${item.replaceAll("\n", "\n  ")}`).join(",\n")}\n${close}`;
}
const format = (args) => args.map((arg) => typeof arg === "string" ? arg : inspect(arg)).join(" ") + "\n";

const consoleApi = {
  log: (...args) => out("stdout", format(args)),
  info: (...args) => out("stdout", format(args)),
  debug: (...args) => out("stdout", format(args)),
  warn: (...args) => out("stderr", format(args)),
  error: (...args) => out("stderr", format(args)),
  dir: (value) => out("stdout", `${inspect(value, 4)}\n`),
  table: (rows) => out("stdout", table(rows)),
  assert: (ok, ...args) => { if (!ok) out("stderr", format(["Assertion failed:", ...args])); },
  time() {}, timeEnd() {}, group() {}, groupEnd() {}, trace: (...args) => out("stderr", format(args)),
};
function table(rows) {
  const list = Array.isArray(rows) ? rows : Object.entries(rows ?? {}).map(([key, value]) => ({ "(index)": key, ...(typeof value === "object" ? value : { value }) }));
  const columns = [...new Set(list.flatMap((row) => Object.keys(typeof row === "object" && row ? row : { value: row })))];
  const cells = list.map((row) => columns.map((column) => { const value = (typeof row === "object" && row ? row : { value: row })[column]; return value === undefined ? "" : typeof value === "string" ? value : inspect(value, 0); }));
  const widths = columns.map((column, i) => Math.min(40, Math.max(column.length, ...cells.map((row) => row[i].length))));
  const line = (values) => values.map((value, i) => value.slice(0, 40).padEnd(widths[i])).join(" | ");
  return [line(columns), widths.map((w) => "-".repeat(w)).join("-+-"), ...cells.map(line)].join("\n") + "\n";
}

// ------------------------------------------------------------------ fs / path / process
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const encodingOf = (options) => typeof options === "string" ? options : options?.encoding;
const toBytes = (data) => typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data instanceof ArrayBuffer ? new Uint8Array(data) : encoder.encode(String(data));

const fs = {
  async readFile(path, options) {
    const bytes = await call("readFile", path);
    return encodingOf(options) ? decoder.decode(bytes) : bytes;
  },
  readText: (path) => fs.readFile(path, "utf8"),
  async readJSON(path) { return JSON.parse(await fs.readFile(path, "utf8")); },
  writeFile: (path, data) => call("writeFile", path, toBytes(data)),
  writeJSON: (path, value) => call("writeFile", path, toBytes(JSON.stringify(value, null, 2) + "\n")),
  appendFile: (path, data) => call("appendFile", path, toBytes(data)),
  async readdir(path = ".", options) {
    const entries = await call("readdir", path);
    if (!options?.withFileTypes) return entries.map((entry) => entry.name);
    return entries.map((entry) => ({ ...entry, isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory" }));
  },
  async stat(path) {
    const info = await call("stat", path);
    return { ...info, mtime: new Date(info.mtimeMs), isFile: () => info.kind === "file", isDirectory: () => info.kind === "directory" };
  },
  exists: (path) => call("exists", path),
  mkdir: (path, options) => call("mkdir", path, options?.recursive ?? true),
  rm: (path, options) => call("rm", path, Boolean(options?.recursive), Boolean(options?.force)),
  unlink: (path) => call("rm", path, false, false),
  rmdir: (path, options) => call("rm", path, Boolean(options?.recursive), false),
  rename: (from, to) => call("rename", from, to),
  async copyFile(from, to) { await call("writeFile", to, await call("readFile", from)); },
  /** Recursive listing of files below a folder (paths relative to it). */
  glob: (path = ".") => call("walk", path),
};
fs.promises = fs;

const path = {
  sep: "/",
  normalize(p) {
    const absolute = p.startsWith("/");
    const parts = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (parts.length && parts.at(-1) !== "..") parts.pop(); else if (!absolute) parts.push(".."); }
      else parts.push(part);
    }
    return (absolute ? "/" : "") + parts.join("/") || (absolute ? "/" : ".");
  },
  join: (...parts) => path.normalize(parts.filter(Boolean).join("/")),
  resolve: (...parts) => {
    let result = cwd;
    for (const part of parts) result = part.startsWith("/") ? part : `${result}/${part}`;
    return path.normalize(result);
  },
  dirname: (p) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i); },
  basename: (p, ext) => { const base = p.replace(/\/+$/, "").split("/").pop() ?? ""; return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base; },
  extname: (p) => { const base = path.basename(p); const i = base.lastIndexOf("."); return i > 0 ? base.slice(i) : ""; },
  relative: (from, to) => {
    const a = path.resolve(from).split("/").filter(Boolean), b = path.resolve(to).split("/").filter(Boolean);
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  },
  isAbsolute: (p) => p.startsWith("/"),
};

class Exit { constructor(code) { this.code = code; } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function require(name) {
  const bare = String(name).replace(/^node:/, "");
  if (bare === "fs" || bare === "fs/promises") return fs;
  if (bare === "path") return path;
  throw new Error(`require('${name}') is not available here. Use: const mod = await import('https://esm.sh/${bare}')`);
}

// ------------------------------------------------------------------ run
async function run({ code, argv, cwd: startCwd, home, env }) {
  cwd = startCwd || "/workspace";
  const process = {
    env: { ...env }, platform: "browser", argv: Array.isArray(argv) ? [...argv] : [], version: "browser",
    cwd: () => cwd,
    chdir: (dir) => { cwd = path.resolve(dir); },
    exit: (exitCode = 0) => { throw new Exit(exitCode); },
    stdout: { write: (text) => { out("stdout", String(text)); return true; } },
    stderr: { write: (text) => { out("stderr", String(text)); return true; } },
  };
  Object.assign(globalThis, { console: consoleApi, fs, path, process, require, sleep, inspect, git,
    fetch: proxyFetch, fetchTor: (input, init) => proxyFetch(input, init, true), HOME: home });
  try {
    let result;
    if (/\bawait\b/.test(code)) {
      const AsyncFunction = (async () => {}).constructor;
      let fn;
      try { fn = new AsyncFunction(`return (\n${code}\n);`); }
      catch { fn = new AsyncFunction(code); }
      result = await fn();
    } else {
      result = (0, eval)(code);
      if (result && typeof result.then === "function") result = await result;
    }
    if (result !== undefined) out("stdout", `${typeof result === "string" ? result : inspect(result, 3)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Exit) return Number.isInteger(error.code) ? error.code : 1;
    out("stderr", `${error instanceof Error ? (error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}\n${error.stack ?? ""}`) : `Uncaught ${inspect(error)}`}\n`);
    return 1;
  }
}

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  out("stderr", `Unhandled rejection: ${event.reason instanceof Error ? event.reason.stack || event.reason.message : inspect(event.reason)}\n`);
});

self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type === "git-callback") {
    try {
      const callback = gitCallbacks.get(message.callId)?.[message.name];
      if (!callback) throw new Error("Git callback is no longer available");
      const value = await callback(...message.args);
      send({ type: "git-callback-result", callbackId: message.callbackId, ok: true, value });
    } catch (error) {
      send({ type: "git-callback-result", callbackId: message.callbackId, ok: false,
        error: { name: error.name, message: error.message, code: error.code } });
    }
    return;
  }
  if (message?.type === "fs-result" || message?.type === "net-result" || message?.type === "git-result") {
    const pending = calls.get(message.callId);
    if (!pending) return;
    calls.delete(message.callId);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(new Error(message.error.message), { name: message.error.name ?? "Error", code: message.error.code, path: message.error.path }));
    return;
  }
  if (message?.type === "run") {
    const exitCode = await run(message);
    send({ type: "done", exitCode });
  }
};
