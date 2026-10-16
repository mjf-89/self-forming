// core-execution: the pi-durable ExecutionEnv implementation (step X1, docs/plugins-ui-editions.md).
// Hand-ported from packages/native-host/src/execution-env.ts (compiled into native-host.js, which
// keeps its own copy as the last-resort fallback). Behaviour is identical: the same bridge
// methods, parameters, request IDs format, events, cancellation and error codes. All OS
// operations run in the host (Android: NativeExecutionEnv.kt in this plugin's native half;
// browser: browser-host.js). Secrets (PI_SECRET_SCOPE) and env/inheritEnv are passed through
// unchanged in exec options; the host resolves them.
// Shared bridge helper: NativeBridgeError comes from the fixed native-host.js (the bridge throws
// it). The small wire helpers (base64, isRecord) are not exported there and are copied below.
import { FileError, ExecutionError, LineScanner, StreamDecoder, ok, err } from "../../../library/pi-durable/env.js";
import { NativeBridgeError } from "../../../native-host.js";

// Wire helpers (packages/native-host/src/wire.ts, verbatim).
function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}
function base64ToBytes(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid base64 payload from native host");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CHUNK = 256 * 1024;
const MAX_FULL_READ = 256 * 1024 * 1024;
let sequence = 0;
// A native service can outlive this document and still own older request IDs.
const documentId = globalThis.crypto.randomUUID();
const nextId = () => `env:${documentId}:${++sequence}`;
const fileCodes = new Set(["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]);

function fileError(error, path) {
  if (error instanceof FileError) return error;
  if (error instanceof NativeBridgeError) {
    const code = error.code.toLowerCase();
    return new FileError(fileCodes.has(code) ? code : "unknown", error.message, error.path ?? path, error);
  }
  return new FileError("unknown", error instanceof Error ? error.message : String(error), path);
}
function aborted(context, path) {
  return context.abortSignal?.aborted ? err(new FileError("aborted", "Operation aborted", path)) : undefined;
}
function info(value) {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.path !== "string"
    || !["file", "directory", "symlink"].includes(String(value.kind))
    || typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0
    || typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs)) throw new TypeError("Invalid native file metadata");
  return value;
}
function handleId(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) throw new TypeError("Invalid native file handle");
  return value.id;
}

/** Real upstream ExecutionEnv adapter. All OS operations run in the host. */
export class NativeExecutionEnv {
  id;
  cwd;
  home;
  backgroundExecution;
  /** Browser edition only: the shell of this environment ({id, language, name}); absent on Android. */
  shell;
  #bridge;
  #owner;
  #watchStops = new Set();

  constructor(bridge, description) {
    this.#bridge = bridge;
    this.id = description.id;
    this.cwd = description.cwd;
    this.home = description.home ?? description.cwd;
    this.#owner = description.owner ?? nextId();
    this.backgroundExecution = description.backgroundExecution === true;
    if (description.shell) this.shell = description.shell;
    else delete this.shell;
  }

  async #call(method, params, context) {
    const path = typeof params.path === "string" ? params.path : undefined;
    const early = aborted(context, path);
    if (early) return early;
    const requestId = nextId();
    const cancel = () => { void this.#bridge.call("env.cancel", { requestId }).catch(() => {}); };
    try {
      // postMessage is synchronous: register native work before a cancellation can overtake it.
      const pending = this.#bridge.call(`env.${method}`, { cwd: this.cwd, owner: this.#owner, ...params, requestId });
      context.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (context.abortSignal?.aborted) cancel();
      const value = await pending;
      return ok(value === null ? undefined : value);
    } catch (error) { return err(fileError(error, path)); }
    finally { context.abortSignal?.removeEventListener("abort", cancel); }
  }

  absolutePath(path, context) { return this.#call("absolutePath", { path }, context); }
  joinPath(parts, context) { return this.#call("joinPath", { parts }, context); }
  canonicalPath(path, context) { return this.#call("canonicalPath", { path }, context); }
  exists(path, context) { return this.#call("exists", { path }, context); }
  createDir(path, options, context) {
    return this.#call("createDir", { path, recursive: options?.recursive ?? true }, context);
  }
  remove(path, options, context) {
    return this.#call("remove", { path, recursive: options?.recursive ?? false, force: options?.force ?? false }, context);
  }
  renameFile(sourcePath, destinationPath, context) {
    return this.#call("renameFile", { sourcePath, destinationPath }, context);
  }
  truncateFile(path, size, context) {
    if (!Number.isSafeInteger(size) || size < 0) return Promise.resolve(err(new FileError("invalid", "Invalid file size", path)));
    return this.#call("truncateFile", { path, size }, context);
  }
  flushFile(path, context) { return this.#call("flushFile", { path }, context); }
  createTempDir(prefix, context) { return this.#call("createTempDir", { prefix }, context); }
  createTempFile(options, context) {
    return this.#call("createTempFile", { ...options }, context);
  }
  async fileInfo(path, context) {
    const result = await this.#call("fileInfo", { path }, context);
    if (!result.ok) return result;
    try { return ok(info(result.value)); } catch (error) { return err(fileError(error, path)); }
  }
  async listDir(path, context) {
    const reader = await this.openDirReader(path, context);
    if (!reader.ok) return reader;
    const entries = [];
    try {
      for (;;) {
        const page = await reader.value.next(256, context);
        if (!page.ok) return page;
        entries.push(...page.value.entries);
        if (page.value.done) return ok(entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
    } finally { await reader.value.close(context); }
  }
  async openDirReader(path, context) {
    const opened = await this.#call("openDirReader", { path }, context);
    if (!opened.ok) return opened;
    let id;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    const cancelled = aborted(context, path);
    if (cancelled) {
      await this.#bridge.call("env.reader.close", { id }).catch(() => {});
      return cancelled;
    }
    let closed = false;
    return ok({
      next: async (maxEntries, ctx) => {
        const early = aborted(ctx, path);
        if (early) return early;
        if (closed || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "Invalid or closed directory reader", path));
        const result = await this.#call("reader.next", { id, maxEntries: Math.min(maxEntries, 256) }, ctx);
        if (!result.ok) return result;
        try {
          if (!isRecord(result.value) || !Array.isArray(result.value.entries) || typeof result.value.done !== "boolean") throw new TypeError("Invalid directory page");
          return ok({ entries: result.value.entries.map(info), done: result.value.done });
        } catch (error) { return err(fileError(error, path)); }
      },
      close: async () => { if (!closed) { closed = true; await this.#bridge.call("env.reader.close", { id }).catch(() => {}); } }
    });
  }
  async openBinaryReader(path, options, context) {
    const opened = await this.#call("openBinaryReader", { path, noFollow: options?.noFollow ?? false }, context);
    if (!opened.ok) return opened;
    let id;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    const cancelled = aborted(context, path);
    if (cancelled) {
      await this.#bridge.call("env.reader.close", { id }).catch(() => {});
      return cancelled;
    }
    let closed = false;
    const early = (ctx) => aborted(ctx, path) ?? (closed ? err(new FileError("invalid", "Binary reader is closed", path)) : undefined);
    const reader = {
      info: async (ctx) => {
        const invalid = early(ctx);
        if (invalid) return invalid;
        const result = await this.#call("reader.info", { id }, ctx);
        if (!result.ok) return result;
        try { return ok(info(result.value)); } catch (error) { return err(fileError(error, path)); }
      },
      read: async (offset, length, ctx) => {
        const invalid = early(ctx);
        if (invalid) return invalid;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > Number.MAX_SAFE_INTEGER)
          return err(new FileError("invalid", "Offset and length must be non-negative safe integers", path));
        if (length > MAX_FULL_READ) return err(new FileError("invalid", "Use reads of at most 256 MiB", path));
        const chunks = [];
        let total = 0;
        while (total < length) {
          const result = await this.#call("reader.read", { id, offset: offset + total, length: Math.min(CHUNK, length - total) }, ctx);
          if (!result.ok) return result;
          try {
            if (!isRecord(result.value) || typeof result.value.data !== "string") throw new TypeError("Invalid binary read");
            const bytes = base64ToBytes(result.value.data);
            if (bytes.length > Math.min(CHUNK, length - total)) throw new TypeError("Native read exceeded requested size");
            if (!bytes.length) break;
            chunks.push(bytes); total += bytes.length;
          } catch (error) { return err(fileError(error, path)); }
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        return ok(bytes);
      },
      scanLines: async (options, ctx) => {
        const invalid = early(ctx);
        if (invalid) return invalid;
        let scanner;
        try { scanner = new LineScanner(options.startLine, options.endLine); }
        catch { return err(new FileError("invalid", "Invalid line range", path)); }
        let offset = 0;
        for (;;) {
          const result = await reader.read(offset, CHUNK, ctx);
          if (!result.ok) return result;
          if (!result.value.length) return ok(scanner.finish());
          scanner.push(result.value); offset += result.value.length;
        }
      },
      close: async () => { if (!closed) { closed = true; await this.#bridge.call("env.reader.close", { id }).catch(() => {}); } }
    };
    return ok(reader);
  }

  async openTextLineReader(path, context) {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    const decoder = new StreamDecoder();
    let buffer = "", offset = 0, ended = false, closed = false;
    return ok({
      readLine: async (ctx) => {
        const early = aborted(ctx, path);
        if (early) return early;
        if (closed) return err(new FileError("invalid", "Text reader is closed", path));
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline !== -1) {
            const text = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            return ok({ text, terminated: true });
          }
          if (ended) {
            if (!buffer) return ok(undefined);
            const text = buffer; buffer = "";
            return ok({ text, terminated: false });
          }
          const bytes = await opened.value.read(offset, 64 * 1024, ctx);
          if (!bytes.ok) return bytes;
          offset += bytes.value.length;
          if (!bytes.value.length) { ended = true; buffer += decoder.decode(); }
          else buffer += decoder.decode(bytes.value);
        }
      },
      close: async (ctx) => { closed = true; buffer = ""; await opened.value.close(ctx); }
    });
  }
  async readTextLines(path, options, context) {
    const early = aborted(context, path);
    if (early) return early;
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally { await opened.value.close(context); }
  }
  async readBinaryFile(path, context) {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = await opened.value.read(total, CHUNK, context);
        if (!chunk.ok) return chunk;
        if (!chunk.value.length) break;
        total += chunk.value.length;
        if (total > MAX_FULL_READ) return err(new FileError("invalid", "Use a binary reader for files larger than 256 MiB", path));
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return ok(bytes);
    } finally { await opened.value.close(context); }
  }
  async readTextFile(path, context) {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  }
  async #write(path, content, append, context) {
    const early = aborted(context, path);
    if (early) return early;
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const opened = await this.#call("openWriter", { path, append }, context);
    if (!opened.ok) return opened;
    let id;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    let result = ok(undefined);
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const written = await this.#call("writer.write", { id, data: bytesToBase64(bytes.subarray(offset, offset + CHUNK)) }, context);
        if (!written.ok) { result = written; break; }
      }
    } catch (error) { result = err(fileError(error, path)); }
    finally {
      // A successful write includes closing the descriptor. Closing can report delayed I/O
      // failures; only an already failed operation may treat its cleanup as best-effort.
      try { await this.#bridge.call("env.writer.close", { id }); }
      catch (error) { if (result.ok) result = err(fileError(error, path)); }
    }
    return result.ok ? aborted(context, path) ?? result : result;
  }
  writeFile(path, content, context) { return this.#write(path, content, false, context); }
  appendFile(path, content, context) { return this.#write(path, content, true, context); }

  async watch(targets, onChange, context) {
    const early = aborted(context);
    if (early) return early;
    const id = nextId();
    let closed = false;
    let opening = true;
    let initialFailure;
    let unsubscribe = () => {};
    let unsubscribeClose = () => {};
    const stop = () => {
      if (closed) return;
      closed = true; unsubscribe(); unsubscribeClose(); this.#watchStops.delete(stop);
    };
    const stopped = (error) => {
      if (closed) return;
      stop();
      if (opening) initialFailure = error;
      else onChange({ error });
    };
    const nativeClose = () => this.#bridge.call("env.watch.close", { id }).catch(() => {});
    try {
      this.#watchStops.add(stop);
      unsubscribe = this.#bridge.subscribe((event) => {
        if (closed || event.event !== "env.watch" || event.id !== id) return;
        const change = event.change;
        if ("error" in change) {
          const code = fileCodes.has(change.error.code) ? change.error.code : "unknown";
          stopped(new FileError(code, change.error.message, change.error.path));
        } else onChange(change);
      });
      unsubscribeClose = this.#bridge.onClose((error) => stopped(fileError(error)));
      const opened = await this.#call("watch", { id, targets }, context);
      if (!opened.ok) { stop(); return opened; }
      if (initialFailure) { await nativeClose(); return err(initialFailure); }
      if (!isRecord(opened.value) || opened.value.id !== id || !["native", "polling"].includes(String(opened.value.mode))) {
        stop(); await nativeClose();
        return err(new FileError("unknown", "Invalid native watcher"));
      }
      const cancelled = aborted(context);
      if (cancelled) { stop(); await nativeClose(); return cancelled; }
      opening = false;
      return ok({ mode: opened.value.mode, close: async () => {
        if (closed) return;
        stop(); await nativeClose();
      } });
    } catch (error) {
      stop();
      return err(fileError(error));
    }
  }

  async exec(command, options, context) {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647))
      return err(new ExecutionError("timeout", "Timeout must be a positive finite number of seconds up to 2147483.647"));
    const id = nextId();
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    let callbackError;
    const cancel = () => { void this.#bridge.call("env.exec.cancel", { id }).catch(() => {}); };
    const output = (text, stream) => {
      if (!text || callbackError) return;
      try { options?.onOutput?.(text, context, { stream }); }
      catch (error) { callbackError = new ExecutionError("callback_error", error instanceof Error ? error.message : String(error)); cancel(); }
    };
    let unsubscribe = () => {};
    try {
      unsubscribe = this.#bridge.subscribe((event) => {
        if (event.event === "env.output" && event.id === id && !callbackError) {
          try { output(decoders[event.stream].decode(base64ToBytes(event.data)), event.stream); }
          catch (error) { callbackError = new ExecutionError("unknown", error instanceof Error ? error.message : String(error)); cancel(); }
        }
      });
      // Sending every chunk satisfies the optional output-window contract without lossy omission.
      const pending = this.#bridge.call("env.exec", { id, owner: this.#owner, ...this.shell ? { shell: this.shell.id } : {}, command,
        cwd: options?.cwd ?? this.cwd, baseCwd: this.cwd, env: options?.env ?? {}, inheritEnv: options?.inheritEnv ?? true,
        timeout: options?.timeout, spill: options?.spill });
      context.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (context.abortSignal?.aborted) cancel();
      const result = await pending;
      output(decoders.stdout.decode(), "stdout"); output(decoders.stderr.decode(), "stderr");
      if (callbackError) { callbackError.spillPath = result.spillPath; return err(callbackError); }
      if (!Number.isInteger(result.exitCode) || result.spillPath !== undefined && typeof result.spillPath !== "string") throw new TypeError("Invalid command result");
      return ok(result);
    } catch (error) {
      output(decoders.stdout.decode(), "stdout"); output(decoders.stderr.decode(), "stderr");
      const allowed = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error"];
      const code = error instanceof NativeBridgeError ? error.code.toLowerCase() : "";
      const failure = callbackError ?? new ExecutionError(allowed.includes(code) ? code : "unknown",
        error instanceof Error ? error.message : String(error));
      if (error instanceof NativeBridgeError) failure.spillPath = error.spillPath;
      return err(failure);
    } finally { context.abortSignal?.removeEventListener("abort", cancel); unsubscribe(); }
  }
  async cleanup(_context) {
    for (const stop of this.#watchStops) stop();
    await this.#bridge.call("env.cleanup", { owner: this.#owner });
  }
}

/**
 * options.shell (browser edition, execution@1 providers exec-js/exec-linux): the page shell id
 * ("javascript" | "bash"); the environment then describes it as env.shell and names it in every
 * env.exec. Without it (Android) the calls are exactly as before.
 */
export async function openNativeExecutionEnv(bridge, cwd, options = {}) {
  const description = options.shell === undefined ? await bridge.call("env.info") : await bridge.call("env.info", { shell: options.shell });
  if (!isRecord(description) || typeof description.id !== "string" || typeof description.cwd !== "string") throw new TypeError("Invalid native execution environment");
  const shell = options.shell === undefined ? undefined : shellDescription(description.shell, options.shell);
  return new NativeExecutionEnv(bridge, { id: description.id, cwd: cwd ?? description.cwd,
    home: typeof description.home === "string" ? description.home : description.cwd,
    owner: options.owner, backgroundExecution: description.backgroundExecution === true, ...shell ? { shell } : {} });
}
function shellDescription(value, id) {
  if (!isRecord(value) || value.id !== id || typeof value.language !== "string" || typeof value.name !== "string") throw new TypeError(`Invalid shell description for ${id}`);
  return Object.freeze({ id: value.id, language: value.language, name: value.name });
}
