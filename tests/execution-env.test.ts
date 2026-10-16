import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createNativeBridge } from '../packages/native-host/src/bridge.ts';
import { NativeExecutionEnv, openNativeExecutionEnv } from '../packages/native-host/src/execution-env.ts';
import { base64ToBytes, bytesToBase64 } from '../packages/native-host/src/wire.ts';
import { deferred, MockHost } from './bridge-support.ts';

const context = BACKGROUND_CONTEXT;
const description = { id: 'android:test', cwd: '/workspace', home: '/workspace' };
const metadata = (size: number) => ({ name: 'file.bin', path: '/workspace/file.bin', kind: 'file', size, mtimeMs: 42 });

test('service-backed adapters reconnect with one owner but distinct command IDs', async () => {
  const host = new MockHost(({ method }) => method === 'env.info'
    ? { ...description, backgroundExecution: true }
    : method === 'env.exec' ? { exitCode: 0 } : null);
  const bridge = createNativeBridge(host);
  try {
    const first = await openNativeExecutionEnv(bridge, undefined, { owner: 'workspace:test' });
    const second = await openNativeExecutionEnv(bridge, undefined, { owner: 'workspace:test' });
    assert.equal(first.backgroundExecution, true);
    await first.exec('first', undefined, context);
    await second.exec('second', undefined, context);
    const calls = host.requests.filter(request => request.method === 'env.exec');
    assert.equal(calls[0].params.owner, calls[1].params.owner);
    assert.notEqual(calls[0].params.id, calls[1].params.id);
    await second.cleanup(context);
    assert.equal(host.requests.at(-1)?.params.owner, 'workspace:test');
    assert.equal(new NativeExecutionEnv(bridge, description).backgroundExecution, false);
  } finally { bridge.close(); }
});

function binaryHost(data: Uint8Array) {
  return new MockHost(({ method, params }) => {
    if (method === 'env.info') return description;
    if (method === 'env.openBinaryReader') return { id: 'reader' };
    if (method === 'env.reader.info') return metadata(data.length);
    if (method === 'env.reader.read') return { data: bytesToBase64(data.subarray(Number(params.offset), Number(params.offset) + Number(params.length))) };
    if (method === 'env.reader.close') return null;
    throw new Error(`Unexpected method: ${method}`);
  });
}

test('native environment writes large binary data in bounded chunks using one open writer', async () => {
  const payload = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, i) => (i * 71) % 256);
  const chunks: Uint8Array[] = [];
  const host = new MockHost(({ method, params }) => {
    if (method === 'env.openWriter') return { id: 'writer' };
    if (method === 'env.writer.write') { assert.equal(params.id, 'writer'); chunks.push(base64ToBytes(String(params.data))); }
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    getOrThrow(await env.writeFile('large.bin', payload, context));
    assert.equal(host.requests[0].method, 'env.openWriter');
    assert.equal(host.requests[0].params.append, false);
    assert.equal(chunks.length, 5);
    assert.ok(chunks.every(chunk => chunk.length <= 256 * 1024));
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(payload));
    assert.equal(host.requests.at(-1)?.method, 'env.writer.close');
    chunks.length = 0;
    getOrThrow(await env.appendFile('large.bin', 'π 🐱', context));
    assert.equal(host.requests.findLast(request => request.method === 'env.openWriter')?.params.append, true);
    assert.equal(Buffer.concat(chunks).toString(), 'π 🐱');
  } finally { bridge.close(); }
});

test('binary reads cross bridge chunk boundaries and preserve end-of-file and closed-handle semantics', async () => {
  const payload = Uint8Array.from({ length: 600_123 }, (_, i) => i % 251);
  const host = binaryHost(payload);
  const bridge = createNativeBridge(host);
  try {
    const env = await openNativeExecutionEnv(bridge);
    const reader = getOrThrow(await env.openBinaryReader('file.bin', undefined, context));
    assert.deepEqual(getOrThrow(await reader.info(context)), metadata(payload.length));
    assert.deepEqual(getOrThrow(await reader.read(17, payload.length + 400, context)), payload.subarray(17));
    const reads = host.requests.filter(request => request.method === 'env.reader.read');
    assert.ok(reads.length > 2);
    assert.ok(reads.every(request => Number(request.params.length) <= 256 * 1024));
    assert.equal(getOrThrow(await reader.read(payload.length + 500, 1, context)).length, 0);
    const before = host.requests.length;
    assert.equal(getOrThrow(await reader.read(5, 0, context)).length, 0);
    assert.equal(host.requests.length, before);
    assert.equal((await reader.read(-1, 1, context)).ok, false);
    await reader.close(withAbortSignal(AbortSignal.abort(), context));
    await reader.close(context);
    assert.equal(host.requests.filter(request => request.method === 'env.reader.close').length, 1);
    const closed = await reader.info(context);
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.equal(closed.error.code, 'invalid');
  } finally { bridge.close(); }
});

test('line scanning and text readers retain upstream UTF-8 replacement, BOM and newline behavior', async () => {
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xef, 0xbb, 0xbf, 0x62, 0x0a, 0xc3, 0xa9]);
  const host = binaryHost(bytes);
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const text = new TextDecoder().decode(bytes);
    assert.equal(getOrThrow(await env.readTextFile('file.bin', context)), text);
    assert.deepEqual(getOrThrow(await env.readTextLines('file.bin', undefined, context)), text.split('\n'));
    const reader = getOrThrow(await env.openBinaryReader('file.bin', undefined, context));
    for (const [startLine, endLine] of [[0, undefined], [0, 1], [1, 3], [3, undefined], [4, 9]] as const) {
      const selected = text.split('\n').slice(startLine, endLine).join('\n');
      const scan = getOrThrow(await reader.scanLines({ startLine, endLine }, context));
      assert.equal(scan.newlines, 4);
      assert.equal(new TextDecoder('utf-8', { ignoreBOM: scan.start > 0 }).decode(bytes.subarray(scan.start, scan.end)), selected);
      assert.equal(scan.selectedBytes, new TextEncoder().encode(selected).length);
    }
    await reader.close(context);
    const lines = getOrThrow(await env.openTextLineReader('file.bin', context));
    for (const expected of [{ text: 'a', terminated: true }, { text: '�', terminated: true }, { text: '', terminated: true },
      { text: '\ufeffb', terminated: true }, { text: 'é', terminated: false }, undefined]) {
      assert.deepEqual(getOrThrow(await lines.readLine(context)), expected);
    }
    await lines.close(context);
  } finally { bridge.close(); }
});

test('pre-abort admits no work and abort during a chunked write still closes its native handle', async () => {
  const controller = new AbortController();
  let chunks = 0;
  const host = new MockHost(({ method }) => {
    if (method === 'env.openWriter') return { id: 'writer' };
    if (method === 'env.writer.write' && ++chunks === 1) controller.abort();
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const early = await env.writeFile('never.bin', 'x', withAbortSignal(AbortSignal.abort(), context));
    assert.equal(early.ok, false);
    assert.equal(host.requests.length, 0);
    const result = await env.writeFile('partial.bin', new Uint8Array(600_000), withAbortSignal(controller.signal, context));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(chunks, 1);
    assert.equal(host.requests.at(-1)?.method, 'env.writer.close');
    const cancel = host.requests.find(request => request.method === 'env.cancel');
    assert.equal(cancel?.params.requestId, host.requests.find(request => request.method === 'env.writer.write')?.params.requestId);
  } finally { bridge.close(); }
});

test('filesystem cancellation follows admission and native error paths survive the bridge', async () => {
  const started = deferred();
  const pending = deferred();
  const host = new MockHost(request => {
    if (request.method === 'env.fileInfo') {
      started.resolve();
      return pending.promise;
    }
    if (request.method === 'env.cancel') {
      const admitted = host.requests.find(entry => entry.method === 'env.fileInfo')!;
      host.send({ id: admitted.id, ok: false, error: { code: 'aborted', message: 'Cancelled', path: '/workspace/file.bin' } });
      pending.resolve();
    }
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const controller = new AbortController();
    const result = env.fileInfo('file.bin', withAbortSignal(controller.signal, context));
    await started.promise;
    controller.abort();
    const failure = await result;
    assert.equal(failure.ok, false);
    if (!failure.ok) { assert.equal(failure.error.code, 'aborted'); assert.equal(failure.error.path, '/workspace/file.bin'); }
    assert.deepEqual(host.requests.map(request => request.method), ['env.fileInfo', 'env.cancel']);
    assert.equal(host.requests[1].params.requestId, host.requests[0].params.requestId);
  } finally { bridge.close(); }
});

test('shell streaming decodes each stream independently including initial and later BOMs', async () => {
  const host = new MockHost(request => {
    if (request.method !== 'env.exec') return null;
    const id = String(request.params.id);
    const emit = (stream: 'stdout' | 'stderr', data: number[]) => host.send({ event: 'env.output', id, stream, data: bytesToBase64(Uint8Array.from(data)) });
    emit('stdout', [0xef]); emit('stderr', [0xe2]); emit('stdout', [0xbb, 0xbf, 0xc3]);
    emit('stderr', [0x82, 0xac]); emit('stdout', [0xa9, 0xef, 0xbb]); emit('stdout', [0xbf, 0x78]);
    return { exitCode: 0 };
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const output = { stdout: '', stderr: '' };
    getOrThrow(await env.exec(['printf', 'ignored'], { onOutput(text, _, info) { output[info.stream] += text; } }, context));
    assert.deepEqual(output, { stdout: 'é\ufeffx', stderr: '€' });
  } finally { bridge.close(); }
});

test('output callback failure cancels the owned command and preserves the native spill path', async () => {
  const execution = deferred<unknown>();
  const host = new MockHost(request => {
    if (request.method === 'env.exec') {
      host.send({ event: 'env.output', id: request.params.id, stream: 'stdout', data: bytesToBase64(new TextEncoder().encode('hello')) });
      return execution.promise;
    }
    if (request.method === 'env.exec.cancel') {
      const admitted = host.requests.find(entry => entry.method === 'env.exec')!;
      host.send({ id: admitted.id, ok: false, error: { code: 'aborted', message: 'Stopped', spillPath: '/temporary/output.log' } });
      execution.resolve(null);
    }
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const result = await env.exec('printf hello', { onOutput() { throw new Error('Renderer failed'); } }, context);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'callback_error');
      assert.equal(result.error.message, 'Renderer failed');
      assert.equal(result.error.spillPath, '/temporary/output.log');
    }
    const cancelled = host.requests.filter(request => request.method === 'env.exec.cancel');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].params.id, host.requests[0].params.id);
  } finally { bridge.close(); }
});

test('watch listeners are ready before native acknowledgement and closed watchers ignore later events', async () => {
  let id = '';
  const host = new MockHost(request => {
    if (request.method !== 'env.watch') return null;
    id = String(request.params.id);
    host.send({ event: 'env.watch', id, change: { paths: ['/workspace/new'] } });
    return { id, mode: 'polling' };
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const changes: unknown[] = [];
    const watcher = getOrThrow(await env.watch([{ path: 'new' }], change => changes.push(change), context));
    assert.equal(watcher.mode, 'polling');
    assert.deepEqual(changes, [{ paths: ['/workspace/new'] }]);
    await watcher.close(withAbortSignal(AbortSignal.abort(), context));
    host.send({ event: 'env.watch', id, change: { overflow: true } });
    await watcher.close(context);
    assert.equal(changes.length, 1);
    assert.equal(host.requests.filter(request => request.method === 'env.watch.close').length, 1);
  } finally { bridge.close(); }
});

test('two environments share their file namespace but cleanup carries distinct command owners', async () => {
  const host = new MockHost(() => null);
  const bridge = createNativeBridge(host);
  try {
    const first = new NativeExecutionEnv(bridge, description);
    const second = new NativeExecutionEnv(bridge, { ...description, cwd: '/workspace/other' });
    assert.equal(first.id, second.id);
    await first.cleanup(context);
    await second.cleanup(context);
    assert.equal(host.requests.length, 2);
    assert.ok(host.requests.every(request => request.method === 'env.cleanup' && typeof request.params.owner === 'string'));
    assert.notEqual(host.requests[0].params.owner, host.requests[1].params.owner);
  } finally { bridge.close(); }
});

test('a writer close failure fails an otherwise successful write without hiding an earlier write error', async () => {
  let failWrite = false;
  const host = new MockHost(({ method }) => {
    if (method === 'env.openWriter') return { id: 'writer' };
    if (method === 'env.writer.write' && failWrite) throw Object.assign(new Error('Write denied'), { code: 'permission_denied' });
    if (method === 'env.writer.close') throw Object.assign(new Error('Delayed device I/O failure'), { code: 'unknown' });
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const closeFailure = await env.writeFile('file.bin', 'value', context);
    assert.equal(closeFailure.ok, false);
    if (!closeFailure.ok) {
      assert.equal(closeFailure.error.code, 'unknown');
      assert.equal(closeFailure.error.message, 'Delayed device I/O failure');
      assert.equal(closeFailure.error.path, 'file.bin');
    }
    failWrite = true;
    const writeFailure = await env.appendFile('file.bin', 'value', context);
    assert.equal(writeFailure.ok, false);
    if (!writeFailure.ok) {
      assert.equal(writeFailure.error.code, 'permission_denied');
      assert.equal(writeFailure.error.message, 'Write denied');
    }
    assert.equal(host.requests.filter(request => request.method === 'env.writer.close').length, 2);
  } finally { bridge.close(); }
});

test('abort immediately after opening an empty writer returns an error and closes its descriptor', async () => {
  const controller = new AbortController();
  const host = new MockHost(({ method }) => {
    if (method === 'env.openWriter') { controller.abort(); return { id: 'empty-writer' }; }
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const result = await new NativeExecutionEnv(bridge, description).writeFile('empty.bin', '', withAbortSignal(controller.signal, context));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(host.requests.at(-1)?.method, 'env.writer.close');
    assert.equal(host.requests.at(-1)?.params.id, 'empty-writer');
  } finally { bridge.close(); }
});

test('watch opening returns FileError results for a closed bridge and malformed native acknowledgement', async () => {
  const closedHost = new MockHost();
  const closedBridge = createNativeBridge(closedHost);
  const closedEnv = new NativeExecutionEnv(closedBridge, description);
  closedBridge.close();
  const closed = await closedEnv.watch([{ path: 'file.bin' }], () => {}, context);
  assert.equal(closed.ok, false);
  assert.equal(closedHost.requests.length, 0);
  if (!closed.ok) assert.equal(closed.error.name, 'FileError');

  const malformedHost = new MockHost(() => null);
  const bridge = createNativeBridge(malformedHost);
  try {
    const result = await new NativeExecutionEnv(bridge, description).watch([], () => {}, context);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.message, 'Invalid native watcher');
    assert.deepEqual(malformedHost.requests.map(request => request.method), ['env.watch', 'env.watch.close']);
    assert.equal(malformedHost.requests[0].params.id, malformedHost.requests[1].params.id);
  } finally { bridge.close(); }
});

test('watch errors are terminal and bridge loss is reported instead of silently leaving a healthy watcher', async () => {
  const host = new MockHost(({ method, params }) => method === 'env.watch' ? { id: params.id, mode: 'polling' } : null);
  const bridge = createNativeBridge(host);
  const env = new NativeExecutionEnv(bridge, description);
  const first: unknown[] = [];
  const second: unknown[] = [];
  const watcher = getOrThrow(await env.watch([{ path: 'first' }], change => first.push(change), context));
  getOrThrow(await env.watch([{ path: 'second' }], change => second.push(change), context));
  const id = host.requests[0].params.id;
  host.send({ event: 'env.watch', id, change: { error: { code: 'permission_denied', message: 'Directory became unreadable', path: '/workspace/first' } } });
  host.send({ event: 'env.watch', id, change: { paths: ['/workspace/first'] } });
  assert.equal(first.length, 1);
  assert.equal((first[0] as { error: { code: string } }).error.code, 'permission_denied');
  await watcher.close(context);
  bridge.close(new Error('Android page was destroyed'));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal((second[0] as { error: Error }).error.message, 'Android page was destroyed');
});

test('watch cancellation after native admission releases the watcher and owner cleanup unsubscribes callbacks', async () => {
  const controller = new AbortController();
  let abortOpen = true;
  const host = new MockHost(({ method, params }) => {
    if (method === 'env.watch') {
      if (abortOpen) controller.abort();
      return { id: params.id, mode: 'polling' };
    }
    return null;
  });
  const bridge = createNativeBridge(host);
  try {
    const env = new NativeExecutionEnv(bridge, description);
    const result = await env.watch([], () => {}, withAbortSignal(controller.signal, context));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'aborted');
    assert.equal(host.requests.at(-1)?.method, 'env.watch.close');
    abortOpen = false;
    const changes: unknown[] = [];
    getOrThrow(await env.watch([], change => changes.push(change), context));
    const id = host.requests.findLast(request => request.method === 'env.watch')!.params.id;
    await env.cleanup(context);
    host.send({ event: 'env.watch', id, change: { paths: ['/workspace/late'] } });
    bridge.close();
    assert.deepEqual(changes, []);
  } finally { bridge.close(); }
});

test('readers opened concurrently with cancellation are closed before returning an aborted result', async () => {
  for (const kind of ['binary', 'directory'] as const) {
    const controller = new AbortController();
    const host = new MockHost(({ method }) => {
      if (method === 'env.openBinaryReader' || method === 'env.openDirReader') {
        controller.abort();
        return { id: 'cancelled-reader' };
      }
      return null;
    });
    const bridge = createNativeBridge(host);
    try {
      const env = new NativeExecutionEnv(bridge, description);
      const ctx = withAbortSignal(controller.signal, context);
      const result = kind === 'binary' ? await env.openBinaryReader('file.bin', undefined, ctx) : await env.openDirReader('.', ctx);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'aborted');
      assert.equal(host.requests.at(-1)?.method, 'env.reader.close');
      assert.equal(host.requests.at(-1)?.params.id, 'cancelled-reader');
    } finally { bridge.close(); }
  }
});
