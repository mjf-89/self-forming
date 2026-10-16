import type { Context } from '@earendil-works/chord';
import {
  FileError, ExecutionError, LineScanner, StreamDecoder, ok, err,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileErrorCode, type FileInfo,
  type FileWatcher, type LineScan, type Result, type ShellExecOptions, type ShellExecResult,
  type TextLine, type TextLineReader, type WatchChange, type WatchTarget,
} from '@earendil-works/pi-durable/env';
import { NativeBridgeError, type NativeBridge } from './bridge.ts';
import { base64ToBytes, bytesToBase64, isRecord } from './wire.ts';

const CHUNK = 256 * 1024;
const MAX_FULL_READ = 256 * 1024 * 1024;
let sequence = 0;
// A native service can outlive this document and still own older request IDs.
const documentId = globalThis.crypto.randomUUID();
const nextId = () => `env:${documentId}:${++sequence}`;
const fileCodes = new Set<FileErrorCode>(['aborted', 'not_found', 'permission_denied', 'not_directory', 'is_directory', 'invalid', 'not_supported', 'unknown']);

function fileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof NativeBridgeError) {
    const code = error.code.toLowerCase() as FileErrorCode;
    return new FileError(fileCodes.has(code) ? code : 'unknown', error.message, error.path ?? path, error);
  }
  return new FileError('unknown', error instanceof Error ? error.message : String(error), path);
}
function aborted<T>(context: Context, path?: string): Result<T, FileError> | undefined {
  return context.abortSignal?.aborted ? err(new FileError('aborted', 'Operation aborted', path)) : undefined;
}
function info(value: unknown): FileInfo {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.path !== 'string'
    || !['file', 'directory', 'symlink'].includes(String(value.kind))
    || typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0
    || typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs)) throw new TypeError('Invalid native file metadata');
  return value as unknown as FileInfo;
}
function handleId(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) throw new TypeError('Invalid native file handle');
  return value.id;
}

/** Real upstream ExecutionEnv adapter. All OS operations run in the Android host. */
export class NativeExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly home: string;
  readonly backgroundExecution: boolean;
  readonly #bridge: NativeBridge;
  readonly #owner: string;
  readonly #watchStops = new Set<() => void>();

  constructor(bridge: NativeBridge, description: { id: string; cwd: string; home?: string; owner?: string; backgroundExecution?: boolean }) {
    this.#bridge = bridge;
    this.id = description.id;
    this.cwd = description.cwd;
    this.home = description.home ?? description.cwd;
    this.#owner = description.owner ?? nextId();
    this.backgroundExecution = description.backgroundExecution === true;
  }

  async #call<T>(method: string, params: Record<string, unknown>, context: Context): Promise<Result<T, FileError>> {
    const path = typeof params.path === 'string' ? params.path : undefined;
    const early = aborted<T>(context, path);
    if (early) return early;
    const requestId = nextId();
    const cancel = () => { void this.#bridge.call('env.cancel', { requestId }).catch(() => {}); };
    try {
      // postMessage is synchronous: register native work before a cancellation can overtake it.
      const pending = this.#bridge.call<T>(`env.${method}`, { cwd: this.cwd, owner: this.#owner, ...params, requestId });
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
      if (context.abortSignal?.aborted) cancel();
      const value = await pending;
      return ok((value === null ? undefined : value) as T);
    } catch (error) { return err(fileError(error, path)); }
    finally { context.abortSignal?.removeEventListener('abort', cancel); }
  }

  absolutePath(path: string, context: Context) { return this.#call<string>('absolutePath', { path }, context); }
  joinPath(parts: string[], context: Context) { return this.#call<string>('joinPath', { parts }, context); }
  canonicalPath(path: string, context: Context) { return this.#call<string>('canonicalPath', { path }, context); }
  exists(path: string, context: Context) { return this.#call<boolean>('exists', { path }, context); }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.#call<void>('createDir', { path, recursive: options?.recursive ?? true }, context);
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.#call<void>('remove', { path, recursive: options?.recursive ?? false, force: options?.force ?? false }, context);
  }
  renameFile(sourcePath: string, destinationPath: string, context: Context) {
    return this.#call<void>('renameFile', { sourcePath, destinationPath }, context);
  }
  truncateFile(path: string, size: number, context: Context) {
    if (!Number.isSafeInteger(size) || size < 0) return Promise.resolve(err<void, FileError>(new FileError('invalid', 'Invalid file size', path)));
    return this.#call<void>('truncateFile', { path, size }, context);
  }
  flushFile(path: string, context: Context) { return this.#call<void>('flushFile', { path }, context); }
  createTempDir(prefix: string | undefined, context: Context) { return this.#call<string>('createTempDir', { prefix }, context); }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.#call<string>('createTempFile', { ...options }, context);
  }
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const result = await this.#call<unknown>('fileInfo', { path }, context);
    if (!result.ok) return result;
    try { return ok(info(result.value)); } catch (error) { return err(fileError(error, path)); }
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const reader = await this.openDirReader(path, context);
    if (!reader.ok) return reader;
    const entries: FileInfo[] = [];
    try {
      for (;;) {
        const page = await reader.value.next(256, context);
        if (!page.ok) return page;
        entries.push(...page.value.entries);
        if (page.value.done) return ok(entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
    } finally { await reader.value.close(context); }
  }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const opened = await this.#call<unknown>('openDirReader', { path }, context);
    if (!opened.ok) return opened;
    let id: string;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    const cancelled = aborted<DirReader>(context, path);
    if (cancelled) {
      await this.#bridge.call('env.reader.close', { id }).catch(() => {});
      return cancelled;
    }
    let closed = false;
    return ok({
      next: async (maxEntries, ctx) => {
        const early = aborted<{ entries: FileInfo[]; done: boolean }>(ctx, path);
        if (early) return early;
        if (closed || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError('invalid', 'Invalid or closed directory reader', path));
        const result = await this.#call<unknown>('reader.next', { id, maxEntries: Math.min(maxEntries, 256) }, ctx);
        if (!result.ok) return result;
        try {
          if (!isRecord(result.value) || !Array.isArray(result.value.entries) || typeof result.value.done !== 'boolean') throw new TypeError('Invalid directory page');
          return ok({ entries: result.value.entries.map(info), done: result.value.done });
        } catch (error) { return err(fileError(error, path)); }
      },
      close: async () => { if (!closed) { closed = true; await this.#bridge.call('env.reader.close', { id }).catch(() => {}); } },
    });
  }
  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.#call<unknown>('openBinaryReader', { path, noFollow: options?.noFollow ?? false }, context);
    if (!opened.ok) return opened;
    let id: string;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    const cancelled = aborted<BinaryReader>(context, path);
    if (cancelled) {
      await this.#bridge.call('env.reader.close', { id }).catch(() => {});
      return cancelled;
    }
    let closed = false;
    const early = <T>(ctx: Context) => aborted<T>(ctx, path) ?? (closed ? err<T, FileError>(new FileError('invalid', 'Binary reader is closed', path)) : undefined);
    const reader: BinaryReader = {
      info: async ctx => {
        const invalid = early<FileInfo>(ctx);
        if (invalid) return invalid;
        const result = await this.#call<unknown>('reader.info', { id }, ctx);
        if (!result.ok) return result;
        try { return ok(info(result.value)); } catch (error) { return err(fileError(error, path)); }
      },
      read: async (offset, length, ctx) => {
        const invalid = early<Uint8Array>(ctx);
        if (invalid) return invalid;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > Number.MAX_SAFE_INTEGER)
          return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', path));
        if (length > MAX_FULL_READ) return err(new FileError('invalid', 'Use reads of at most 256 MiB', path));
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < length) {
          const result = await this.#call<unknown>('reader.read', { id, offset: offset + total, length: Math.min(CHUNK, length - total) }, ctx);
          if (!result.ok) return result;
          try {
            if (!isRecord(result.value) || typeof result.value.data !== 'string') throw new TypeError('Invalid binary read');
            const bytes = base64ToBytes(result.value.data);
            if (bytes.length > Math.min(CHUNK, length - total)) throw new TypeError('Native read exceeded requested size');
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
        const invalid = early<LineScan>(ctx);
        if (invalid) return invalid;
        let scanner: LineScanner;
        try { scanner = new LineScanner(options.startLine, options.endLine); }
        catch { return err(new FileError('invalid', 'Invalid line range', path)); }
        let offset = 0;
        for (;;) {
          const result = await reader.read(offset, CHUNK, ctx);
          if (!result.ok) return result;
          if (!result.value.length) return ok(scanner.finish());
          scanner.push(result.value); offset += result.value.length;
        }
      },
      close: async () => { if (!closed) { closed = true; await this.#bridge.call('env.reader.close', { id }).catch(() => {}); } },
    };
    return ok(reader);
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    const decoder = new StreamDecoder();
    let buffer = '', offset = 0, ended = false, closed = false;
    return ok({
      readLine: async ctx => {
        const early = aborted<TextLine | undefined>(ctx, path);
        if (early) return early;
        if (closed) return err(new FileError('invalid', 'Text reader is closed', path));
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline !== -1) {
            const text = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            return ok({ text, terminated: true });
          }
          if (ended) {
            if (!buffer) return ok(undefined);
            const text = buffer; buffer = '';
            return ok({ text, terminated: false });
          }
          const bytes = await opened.value.read(offset, 64 * 1024, ctx);
          if (!bytes.ok) return bytes;
          offset += bytes.value.length;
          if (!bytes.value.length) { ended = true; buffer += decoder.decode(); }
          else buffer += decoder.decode(bytes.value);
        }
      },
      close: async ctx => { closed = true; buffer = ''; await opened.value.close(ctx); },
    });
  }
  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const early = aborted<string[]>(context, path);
    if (early) return early;
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
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
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const chunk = await opened.value.read(total, CHUNK, context);
        if (!chunk.ok) return chunk;
        if (!chunk.value.length) break;
        total += chunk.value.length;
        if (total > MAX_FULL_READ) return err(new FileError('invalid', 'Use a binary reader for files larger than 256 MiB', path));
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return ok(bytes);
    } finally { await opened.value.close(context); }
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  }
  async #write(path: string, content: string | Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
    const early = aborted<void>(context, path);
    if (early) return early;
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const opened = await this.#call<unknown>('openWriter', { path, append }, context);
    if (!opened.ok) return opened;
    let id: string;
    try { id = handleId(opened.value); } catch (error) { return err(fileError(error, path)); }
    let result: Result<void, FileError> = ok(undefined);
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const written = await this.#call<void>('writer.write', { id, data: bytesToBase64(bytes.subarray(offset, offset + CHUNK)) }, context);
        if (!written.ok) { result = written; break; }
      }
    } catch (error) { result = err(fileError(error, path)); }
    finally {
      // A successful write includes closing the descriptor. Closing can report delayed I/O
      // failures; only an already failed operation may treat its cleanup as best-effort.
      try { await this.#bridge.call('env.writer.close', { id }); }
      catch (error) { if (result.ok) result = err(fileError(error, path)); }
    }
    return result.ok ? aborted<void>(context, path) ?? result : result;
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) { return this.#write(path, content, false, context); }
  appendFile(path: string, content: string | Uint8Array, context: Context) { return this.#write(path, content, true, context); }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const early = aborted<FileWatcher>(context);
    if (early) return early;
    const id = nextId();
    let closed = false;
    let opening = true;
    let initialFailure: FileError | undefined;
    let unsubscribe = () => {};
    let unsubscribeClose = () => {};
    const stop = () => {
      if (closed) return;
      closed = true; unsubscribe(); unsubscribeClose(); this.#watchStops.delete(stop);
    };
    const stopped = (error: FileError) => {
      if (closed) return;
      stop();
      if (opening) initialFailure = error;
      else onChange({ error });
    };
    const nativeClose = () => this.#bridge.call('env.watch.close', { id }).catch(() => {});
    try {
      this.#watchStops.add(stop);
      unsubscribe = this.#bridge.subscribe(event => {
        if (closed || event.event !== 'env.watch' || event.id !== id) return;
        const change = event.change;
        if ('error' in change) {
          const code = fileCodes.has(change.error.code as FileErrorCode) ? change.error.code as FileErrorCode : 'unknown';
          stopped(new FileError(code, change.error.message, change.error.path));
        } else onChange(change);
      });
      unsubscribeClose = this.#bridge.onClose(error => stopped(fileError(error)));
      const opened = await this.#call<unknown>('watch', { id, targets }, context);
      if (!opened.ok) { stop(); return opened; }
      if (initialFailure) { await nativeClose(); return err(initialFailure); }
      if (!isRecord(opened.value) || opened.value.id !== id || !['native', 'polling'].includes(String(opened.value.mode))) {
        stop(); await nativeClose();
        return err(new FileError('unknown', 'Invalid native watcher'));
      }
      const cancelled = aborted<FileWatcher>(context);
      if (cancelled) { stop(); await nativeClose(); return cancelled; }
      opening = false;
      return ok({ mode: opened.value.mode as 'native' | 'polling', close: async () => {
        if (closed) return;
        stop(); await nativeClose();
      } });
    } catch (error) {
      stop();
      return err(fileError(error));
    }
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'Command aborted'));
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2147483647))
      return err(new ExecutionError('timeout', 'Timeout must be a positive finite number of seconds up to 2147483.647'));
    const id = nextId();
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
    let callbackError: ExecutionError | undefined;
    const cancel = () => { void this.#bridge.call('env.exec.cancel', { id }).catch(() => {}); };
    const output = (text: string, stream: 'stdout' | 'stderr') => {
      if (!text || callbackError) return;
      try { options?.onOutput?.(text, context, { stream }); }
      catch (error) { callbackError = new ExecutionError('callback_error', error instanceof Error ? error.message : String(error)); cancel(); }
    };
    let unsubscribe = () => {};
    try {
      unsubscribe = this.#bridge.subscribe(event => {
        if (event.event === 'env.output' && event.id === id && !callbackError) {
          try { output(decoders[event.stream].decode(base64ToBytes(event.data)), event.stream); }
          catch (error) { callbackError = new ExecutionError('unknown', error instanceof Error ? error.message : String(error)); cancel(); }
        }
      });
      // Sending every chunk satisfies the optional output-window contract without lossy omission.
      const pending = this.#bridge.call<ShellExecResult>('env.exec', { id, owner: this.#owner, command,
        cwd: options?.cwd ?? this.cwd, baseCwd: this.cwd, env: options?.env ?? {}, inheritEnv: options?.inheritEnv ?? true,
        timeout: options?.timeout, spill: options?.spill });
      context.abortSignal?.addEventListener('abort', cancel, { once: true });
      if (context.abortSignal?.aborted) cancel();
      const result = await pending;
      output(decoders.stdout.decode(), 'stdout'); output(decoders.stderr.decode(), 'stderr');
      if (callbackError) { callbackError.spillPath = result.spillPath; return err(callbackError); }
      if (!Number.isInteger(result.exitCode) || result.spillPath !== undefined && typeof result.spillPath !== 'string') throw new TypeError('Invalid command result');
      return ok(result);
    } catch (error) {
      output(decoders.stdout.decode(), 'stdout'); output(decoders.stderr.decode(), 'stderr');
      const allowed = ['aborted', 'timeout', 'shell_unavailable', 'spawn_error', 'callback_error'] as const;
      const code = error instanceof NativeBridgeError ? error.code.toLowerCase() : '';
      const failure = callbackError ?? new ExecutionError(allowed.includes(code as typeof allowed[number]) ? code as typeof allowed[number] : 'unknown',
        error instanceof Error ? error.message : String(error));
      if (error instanceof NativeBridgeError) failure.spillPath = error.spillPath;
      return err(failure);
    } finally { context.abortSignal?.removeEventListener('abort', cancel); unsubscribe(); }
  }
  async cleanup(_context: Context): Promise<void> {
    for (const stop of this.#watchStops) stop();
    await this.#bridge.call('env.cleanup', { owner: this.#owner });
  }
}

export async function openNativeExecutionEnv(bridge: NativeBridge, cwd?: string, options: { owner?: string } = {}): Promise<NativeExecutionEnv> {
  const description = await bridge.call<unknown>('env.info');
  if (!isRecord(description) || typeof description.id !== 'string' || typeof description.cwd !== 'string') throw new TypeError('Invalid native execution environment');
  return new NativeExecutionEnv(bridge, { id: description.id, cwd: cwd ?? description.cwd,
    home: typeof description.home === 'string' ? description.home : description.cwd,
    owner: options.owner, backgroundExecution: description.backgroundExecution === true });
}
