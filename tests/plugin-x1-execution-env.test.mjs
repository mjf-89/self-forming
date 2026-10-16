import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, tick } from './plugin-agent-support.mjs';

// Step X1: the pi-durable ExecutionEnv implementation lives in core-execution
// (plugins/core-execution/web/execution-env.js, hand-ported from packages/native-host/src/
// execution-env.ts). The same scenarios run against the ported env and the env of the fixed
// native-host.js with a scripted fake bridge; calls (normalised request IDs) and results must be
// identical. Also: execution@1 opens the ported env, core-agent opens its sessions' env through
// execution@1 / the bundled copy / native-host.js, and app.js no longer imports the old export.
// No device, no network; dummy values only.
const root = new URL('../', import.meta.url);
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';

let app, ported, original, coreExecution, openSessionsModule;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  ported = await app.load('builtin/core-execution/web/execution-env.js');
  original = await app.load('native-host.js');
  coreExecution = await app.load('builtin/core-execution/web/index.js');
  openSessionsModule = await app.load('builtin/core-agent/web/open-sessions.js');
});
after(async () => { await app?.remove(); });

const b64 = (text) => Buffer.from(text).toString('base64');
const b64bytes = (bytes) => Buffer.from(bytes).toString('base64');

/** Scripted bridge: handlers[method](params, bridge) → value | throws | promise. Logs every call. */
function fakeBridge(handlers, BridgeError) {
  const calls = [];
  const listeners = new Set();
  const closeListeners = new Set();
  const bridge = {
    closed: false,
    calls,
    BridgeError,
    async call(method, params = {}) {
      calls.push([method, structuredClone(params)]);
      const handler = handlers[method];
      if (!handler) throw new BridgeError('NOT_SUPPORTED', `No fake handler for ${method}`);
      return handler(params, bridge);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    lose(error) { for (const listener of [...closeListeners]) listener(error); },
    listenerCount: () => listeners.size + closeListeners.size
  };
  return bridge;
}

const describe = (value) => {
  if (value instanceof Uint8Array) return { bytes: [...value] };
  if (value instanceof Error) return { error: value.name, code: value.code, message: value.message, path: value.path, spillPath: value.spillPath, cause: value.cause ? { name: value.cause.name, code: value.cause.code, message: value.cause.message } : undefined };
  if (value && typeof value === 'object' && 'ok' in value) return value.ok ? { ok: true, value: describe(value.value) } : { ok: false, error: describe(value.error) };
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, describe(v)]));
  return value;
};

/** Request/stream IDs are env:<document uuid>:<n>: replace them by their order of appearance. */
function normalise(log) {
  const ids = new Map();
  const walk = (value) => {
    if (typeof value === 'string') return value.replace(/env:[0-9a-f-]{36}:\d+/g, (id) => { if (!ids.has(id)) ids.set(id, `env:#${ids.size + 1}`); return ids.get(id); });
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(log);
}

const ctx = (signal) => (signal ? { abortSignal: signal } : {});
const file = (name, extra = {}) => ({ name, path: `/w/${name}`, kind: 'file', size: 3, mtimeMs: 1, ...extra });

/** Every scenario against one implementation; returns {calls, results, extra}. */
async function scenarios(mod, BridgeError) {
  const results = [];
  const note = (label, value) => results.push([label, describe(value)]);
  let execPlan = null;
  const files = new Map([['/w/a.txt', new TextEncoder().encode('one\ntwo\nthree')], ['/w/big.bin', new Uint8Array(300 * 1024).map((_, i) => i % 251)]]);
  const readers = new Map();
  const written = [];
  let writerCloseFails = false;
  let watchMode = 'native';
  const handlers = {
    'env.info': () => ({ id: 'dev', cwd: '/w', home: '/home/me', backgroundExecution: true }),
    'env.exec': (params, bridge) => execPlan(params, bridge),
    'env.exec.cancel': () => null,
    'env.cancel': () => null,
    'env.cleanup': () => null,
    'env.exists': (params) => params.path === '/w/a.txt',
    'env.absolutePath': (params) => `/w/${params.path}`,
    'env.joinPath': (params) => params.parts.join('/'),
    'env.createDir': () => null,
    'env.remove': (params) => { if (params.path === '/w/missing') throw new BridgeError('NOT_FOUND', 'No such file', { path: params.path }); return null; },
    'env.renameFile': () => null,
    'env.createTempFile': (params) => `/tmp/${params.prefix ?? 'x'}${params.suffix ?? ''}`,
    'env.fileInfo': (params) => params.path === '/w/bad' ? { name: 'bad' } : file('a.txt'),
    'env.openDirReader': () => ({ id: 'd1' }),
    'env.reader.next': (params) => readers.get('dir') === 1 ? { entries: [file('c'), file('a')], done: true } : (readers.set('dir', 1), { entries: [file('b')], done: false }),
    'env.reader.close': () => null,
    'env.openBinaryReader': (params) => { if (!files.has(params.path)) throw new BridgeError('NOT_FOUND', 'Missing', { path: params.path }); readers.set('r1', params.path); return { id: 'r1' }; },
    'env.reader.info': () => file('a.txt', { size: 13 }),
    'env.reader.read': (params) => {
      const data = files.get(readers.get(params.id));
      return { data: b64bytes(data.subarray(params.offset, params.offset + params.length)) };
    },
    'env.openWriter': (params) => { written.push({ path: params.path, append: params.append, chunks: [] }); return { id: 'w1' }; },
    'env.writer.write': (params) => { written.at(-1).chunks.push(Buffer.from(params.data, 'base64').length); return null; },
    'env.writer.close': () => { if (writerCloseFails) throw new BridgeError('IO_ERROR', 'Disk full', { path: '/w/out' }); return null; },
    'env.watch': (params) => ({ id: params.id, mode: watchMode }),
    'env.watch.close': () => null
  };
  const bridge = fakeBridge(handlers, BridgeError);

  const env = await mod.openNativeExecutionEnv(bridge, undefined, { owner: 'workspace:dummy-owner' });
  note('env', { id: env.id, cwd: env.cwd, home: env.home, backgroundExecution: env.backgroundExecution });
  note('env-own-keys', Object.keys(env).sort());
  const other = await mod.openNativeExecutionEnv(bridge, '/elsewhere');
  note('env-cwd', { cwd: other.cwd });

  // exec with streamed stdout/stderr (a UTF-8 character split across events), env + secret scope.
  execPlan = async (params, b) => {
    const euro = Buffer.from('€');
    b.emit({ event: 'env.output', id: params.id, stream: 'stdout', data: b64bytes(Buffer.concat([Buffer.from('hi '), euro.subarray(0, 1)])) });
    b.emit({ event: 'env.output', id: 'env:other', stream: 'stdout', data: b64('ignored') });
    await tick();
    b.emit({ event: 'env.output', id: params.id, stream: 'stdout', data: b64bytes(euro.subarray(1)) });
    b.emit({ event: 'env.output', id: params.id, stream: 'stderr', data: b64('warn\n') });
    return { exitCode: 0 };
  };
  const chunks = [];
  note('exec', await env.exec(['sh', '-c', 'echo hi'], {
    cwd: '/w/sub', env: { PI_SECRET_SCOPE: 'agent', DUMMY: 'not-a-secret' }, inheritEnv: false, timeout: 5, spill: { path: '/w/.spill' },
    onOutput: (text, _c, { stream }) => chunks.push([stream, text])
  }, {}));
  note('exec-chunks', chunks);
  note('exec-defaults', await env.exec('true', undefined, {}));

  // cancellation while running, then the host reports ABORTED
  execPlan = (params) => new Promise((_, reject) => { pendingReject = reject; });
  let pendingReject;
  const controller = new AbortController();
  const running = env.exec('sleep 100', undefined, ctx(controller.signal));
  await tick();
  controller.abort();
  await tick();
  pendingReject(new BridgeError('ABORTED', 'Command was cancelled'));
  note('exec-cancelled', await running);
  note('exec-pre-aborted', await env.exec('true', undefined, ctx(AbortSignal.abort())));
  note('exec-bad-timeout', await env.exec('true', { timeout: 0 }, {}));
  note('exec-huge-timeout', await env.exec('true', { timeout: 3e6 }, {}));
  execPlan = () => { throw new BridgeError('SPAWN_ERROR', 'No shell', { spillPath: '/w/.spill/1' }); };
  note('exec-spawn', await env.exec('x', undefined, {}));
  for (const code of ['TIMEOUT', 'SHELL_UNAVAILABLE', 'callback_error', 'aborted']) {
    execPlan = () => { throw new BridgeError(code, `Host said ${code}`); };
    note(`exec-host-${code}`, await env.exec('x', undefined, {}));
  }
  execPlan = () => { throw new Error('plain failure'); };
  note('exec-plain', await env.exec('x', undefined, {}));
  execPlan = () => { throw new BridgeError('weird', 'Odd'); };
  note('exec-unknown', await env.exec('x', undefined, {}));
  execPlan = () => ({ exitCode: 1.5 });
  note('exec-invalid', await env.exec('x', undefined, {}));
  execPlan = (params, b) => { b.emit({ event: 'env.output', id: params.id, stream: 'stdout', data: b64('boom') }); return { exitCode: 0, spillPath: '/w/.spill/2' }; };
  note('exec-callback', await env.exec('x', { onOutput: () => { throw new Error('observer failed'); } }, {}));
  execPlan = (params, b) => { b.emit({ event: 'env.output', id: params.id, stream: 'stdout', data: '***' }); return { exitCode: 0 }; };
  note('exec-bad-base64', await env.exec('x', { onOutput: () => {} }, {}));

  // file calls and error mapping
  note('exists', await env.exists('/w/a.txt', {}));
  note('absolutePath', await env.absolutePath('rel', {}));
  note('joinPath', await env.joinPath(['a', 'b'], {}));
  note('createDir', await env.createDir('/w/d', undefined, {}));
  note('remove-missing', await env.remove('/w/missing', { force: false }, {}));
  note('rename', await env.renameFile('/w/a', '/w/b', {}));
  note('truncate-invalid', await env.truncateFile('/w/a', -1, {}));
  note('tempFile', await env.createTempFile({ prefix: 'p', suffix: '.s' }, {}));
  note('fileInfo', await env.fileInfo('/w/a.txt', {}));
  note('fileInfo-invalid', await env.fileInfo('/w/bad', {}));
  note('listDir', await env.listDir('/w', {}));
  note('readText', await env.readTextFile('/w/a.txt', {}));
  note('readLines', await env.readTextLines('/w/a.txt', { maxLines: 2 }, {}));
  note('readBinary', (await env.readBinaryFile('/w/big.bin', {})).value.length);
  note('read-missing', await env.readTextFile('/w/none', {}));
  const reader = await env.openBinaryReader('/w/a.txt', { noFollow: true }, {});
  note('reader-info', await reader.value.info({}));
  note('reader-scan', await reader.value.scanLines({ startLine: 1, endLine: 2 }, {}));
  note('reader-bad-range', await reader.value.read(-1, 2, {}));
  await reader.value.close({});
  note('reader-closed', await reader.value.read(0, 2, {}));
  // a pending call cancelled through env.cancel {requestId}
  handlers['env.canonicalPath'] = () => new Promise((resolve) => setTimeout(() => resolve('/w/real'), 20));
  const callAbort = new AbortController();
  const canonical = env.canonicalPath('/w/link', ctx(callAbort.signal));
  await tick(); callAbort.abort();
  note('call-cancelled', await canonical);
  note('call-pre-aborted', await env.exists('/w/a.txt', ctx(AbortSignal.abort())));

  // writes: chunked, append, close failure
  note('write', await env.writeFile('/w/out', 'x'.repeat(256 * 1024 + 10), {}));
  note('append', await env.appendFile('/w/out', new Uint8Array([1, 2, 3]), {}));
  writerCloseFails = true;
  note('write-close-fails', await env.writeFile('/w/out', 'y', {}));
  writerCloseFails = false;
  note('written', written);

  // watch: change, host error after open, close; a bridge loss
  const changes = [];
  const watcher = await env.watch([{ path: '/w', recursive: true }], (change) => changes.push(change), {});
  note('watch', { ok: watcher.ok, mode: watcher.value.mode });
  const watchId = bridge.calls.findLast(([m]) => m === 'env.watch')[1].id;
  bridge.emit({ event: 'env.watch', id: watchId, change: { paths: ['/w/a.txt'] } });
  bridge.emit({ event: 'env.watch', id: watchId, change: { error: { code: 'permission_denied', message: 'Denied', path: '/w' } } });
  bridge.emit({ event: 'env.watch', id: watchId, change: { paths: ['/w/after'] } });
  note('watch-changes', changes);
  await watcher.value.close();
  watchMode = 'bogus';
  note('watch-invalid', await env.watch([{ path: '/w' }], () => {}, {}));
  watchMode = 'polling';
  const lostChanges = [];
  const lost = await env.watch([{ path: '/w' }], (change) => lostChanges.push(change), {});
  bridge.lose(new BridgeError('bridge_lost', 'Native transport failed'));
  note('watch-lost', { mode: lost.value.mode, changes: lostChanges });
  const open = await env.watch([{ path: '/w' }], () => {}, {});
  note('watch-open', open.ok);

  // cleanup: stops watchers, env.cleanup with the owner; a default owner is env:<doc>:<n>
  await env.cleanup({});
  await other.cleanup({});
  note('listeners-after-cleanup', bridge.listenerCount());
  return normalise({ calls: bridge.calls, results });
}

test('ported ExecutionEnv behaves exactly like the native-host.js one (same calls, same results)', { skip }, async () => {
  const BridgeError = original.NativeBridgeError;
  const a = await scenarios(ported, BridgeError);
  const b = await scenarios(original, BridgeError);
  assert.deepEqual(a.results, b.results);
  assert.deepEqual(a.calls, b.calls);
  // Sanity on the shared expectations (so equality is not equality of two broken copies).
  const result = Object.fromEntries(a.results);
  assert.deepEqual(result.env, { id: 'dev', cwd: '/w', home: '/home/me', backgroundExecution: true });
  assert.deepEqual(result['env-own-keys'], ['backgroundExecution', 'cwd', 'home', 'id']);
  assert.deepEqual(result.exec, { ok: true, value: { exitCode: 0 } });
  assert.deepEqual(result['exec-chunks'], [['stdout', 'hi '], ['stdout', '€'], ['stderr', 'warn\n']]);
  assert.equal(result['exec-cancelled'].error.code, 'aborted');
  assert.equal(result['exec-pre-aborted'].error.code, 'aborted');
  assert.equal(result['exec-bad-timeout'].error.code, 'timeout');
  assert.deepEqual([result['exec-spawn'].error.code, result['exec-spawn'].error.spillPath], ['spawn_error', '/w/.spill/1']);
  assert.equal(result['exec-unknown'].error.code, 'unknown');
  assert.deepEqual(['TIMEOUT', 'SHELL_UNAVAILABLE', 'callback_error', 'aborted', 'plain'].map((code) => result[code === 'plain' ? 'exec-plain' : `exec-host-${code}`].error.code), ['timeout', 'shell_unavailable', 'callback_error', 'aborted', 'unknown']);
  assert.equal(result['exec-invalid'].error.code, 'unknown');
  assert.deepEqual([result['exec-callback'].error.code, result['exec-callback'].error.spillPath], ['callback_error', '/w/.spill/2']);
  assert.equal(result['remove-missing'].error.code, 'not_found');
  assert.equal(result['remove-missing'].error.path, '/w/missing');
  assert.equal(result['fileInfo-invalid'].error.code, 'unknown');
  assert.deepEqual(result.listDir.value.map((entry) => entry.name), ['a', 'b', 'c']);
  assert.deepEqual(result.readText, { ok: true, value: 'one\ntwo\nthree' });
  assert.deepEqual(result.readLines, { ok: true, value: ['one', 'two'] });
  assert.equal(result.readBinary, 300 * 1024);
  assert.deepEqual(result['call-cancelled'], { ok: true, value: '/w/real' }, 'a late host answer still settles; env.cancel was sent');
  assert.ok(a.calls.some(([method, params]) => method === 'env.cancel' && /^env:#\d+$/.test(params.requestId)));
  assert.equal(result['call-pre-aborted'].error.code, 'aborted');
  assert.equal(result['write-close-fails'].error.code, 'unknown');
  assert.deepEqual(result.written.map((w) => w.chunks), [[256 * 1024, 10], [3], [1]]);
  assert.deepEqual(result['watch-changes'], [{ paths: ['/w/a.txt'] }, { error: { error: 'FileError', code: 'permission_denied', message: 'Denied', path: '/w', spillPath: undefined, cause: undefined } }]);
  assert.equal(result['listeners-after-cleanup'], 0);
  const methods = a.calls.map(([method]) => method);
  for (const method of ['env.exec.cancel', 'env.cancel', 'env.cleanup', 'env.watch.close', 'env.reader.close', 'env.writer.close']) assert.ok(methods.includes(method), method);
  const exec = a.calls.find(([method]) => method === 'env.exec')[1];
  assert.deepEqual(exec, { id: exec.id, owner: 'workspace:dummy-owner', command: ['sh', '-c', 'echo hi'], cwd: '/w/sub', baseCwd: '/w', env: { PI_SECRET_SCOPE: 'agent', DUMMY: 'not-a-secret' }, inheritEnv: false, timeout: 5, spill: { path: '/w/.spill' } });
  const cleanups = a.calls.filter(([method]) => method === 'env.cleanup').map(([, params]) => params.owner);
  assert.equal(cleanups[0], 'workspace:dummy-owner');
  assert.match(cleanups[1], /^env:#\d+$/, 'default owner is a document request ID');
});

test('execution@1 opens the ported env; NO_EXECUTION without the capability; native-host.js only if the port fails to load', { skip }, async () => {
  const bridge = fakeBridge({ 'env.info': () => ({ id: 'dev', cwd: '/w' }), 'env.cleanup': () => null }, original.NativeBridgeError);
  const hostInfo = { capabilities: { executionEnv: true } };
  const provided = new Map();
  const controller = new AbortController();
  const definition = coreExecution.create({ bridge, hostInfo, owner: 'workspace:page' });
  definition.setup({ signal: controller.signal, contribute() {}, provide: (id, version, value) => provided.set(`${id}@${version}`, value) });
  const service = provided.get('execution@1');
  const env = await service.open();
  assert.ok(env instanceof ported.NativeExecutionEnv, 'the plugin\'s own implementation');
  assert.equal(env.constructor.name, 'NativeExecutionEnv');
  assert.ok(!(env instanceof original.NativeExecutionEnv));
  await env.cleanup({});
  assert.deepEqual(bridge.calls.at(-1), ['env.cleanup', { owner: 'workspace:page' }]);
  const own = await service.open('/w/x', { owner: 'workspace:other' });
  assert.equal(own.cwd, '/w/x');
  await own.cleanup({});
  assert.deepEqual(bridge.calls.at(-1), ['env.cleanup', { owner: 'workspace:other' }]);
  await assert.rejects(coreExecution.createExecution({ bridge, hostInfo: { capabilities: {} } }).open(), { message: coreExecution.NO_EXECUTION });
  controller.abort();
  assert.throws(() => service.open(), /stopped/);
  // openExecution (tests, forks) still replaces the opener and gets the arguments as before.
  const replaced = new Map();
  coreExecution.create({ openExecution: (...args) => ({ args }) }).setup({ signal: new AbortController().signal, contribute() {}, provide: (id, version, value) => replaced.set(id, value) });
  assert.deepEqual(replaced.get('execution').open(1, 2), { args: [1, 2] });
  // Last resort: the fixed native-host.js export when execution-env.js cannot be loaded.
  const errors = console.error; console.error = () => {};
  try {
    const open = await coreExecution.loadExecutionEnv({ load: () => Promise.reject(new Error('module failed')), fallback: () => app.load('native-host.js') });
    assert.equal(open, original.openNativeExecutionEnv);
  } finally { console.error = errors; }
});

test('core-agent opens the session env through execution@1, else the bundled copy, else native-host.js', { skip }, async () => {
  const opened = [];
  const service = { open: async (...args) => { opened.push(['service', ...args]); throw new Error('stop here'); } };
  const bundled = { open: async (...args) => { opened.push(['bundled', ...args]); throw new Error('stop here'); } };
  const options = { bridge: {}, hostInfo: { capabilities: { executionEnv: true } }, owner: 'workspace:page', execution: bundled };
  await assert.rejects(openSessionsModule.createSessionOpener(options, () => service)({ wanted: () => true }), /stop here/);
  await assert.rejects(openSessionsModule.createSessionOpener(options, () => null)({ wanted: () => true }), /stop here/);
  await assert.rejects(openSessionsModule.createSessionOpener(options)({ wanted: () => true }), /stop here/);
  assert.deepEqual(opened, [['service', undefined, { owner: 'workspace:page' }], ['bundled', undefined, { owner: 'workspace:page' }], ['bundled', undefined, { owner: 'workspace:page' }]]);
  const bridge = fakeBridge({ 'env.info': () => { throw new Error('native-host path'); } }, original.NativeBridgeError);
  await assert.rejects(openSessionsModule.createSessionOpener({ ...options, bridge, execution: undefined })({ wanted: () => true }), /native-host path/);
});

test('sources: app.js passes no openExecution and imports no openNativeExecutionEnv; core-agent uses execution@1', async () => {
  const appSource = await readFile(new URL('apps/common/app.js', root), 'utf8');
  assert.doesNotMatch(appSource, /openNativeExecutionEnv|openExecution\s*:/);
  assert.match(appSource, /executionOwner: owner/);
  // E1: the browser adds the saved/default execution@1 shell (same page backend); Android passes none.
  assert.match(appSource, /execution: coreExecution\.createExecution\(\{ bridge, hostInfo, owner, \.\.\.inBrowser \? \{ shell: bundledBrowserShell\(hostInfo\) \} : \{\} \}\)/);
  for (const path of ['plugins/core-agent/web/index.js', 'plugins/core-agent/web/open-sessions.js', 'plugins/core-servers/web/index.js', 'plugins/core-servers/web/servers-service.js']) {
    const source = await readFile(new URL(path, root), 'utf8');
    const direct = source.split('\n').filter((line) => /openNativeExecutionEnv/.test(line) && !/^\s*\/\//.test(line));
    assert.ok(direct.every((line) => /return \(await import\("\.\.\/\.\.\/\.\.\/native-host\.js"\)\)\.openNativeExecutionEnv/.test(line)), `${path}: only the last-resort fallback may use native-host.js`);
  }
  const manifest = JSON.parse(await readFile(new URL('plugins/core-agent/plugin.json', root), 'utf8'));
  assert.deepEqual(manifest.uses, [{ id: 'execution', version: 1 }, { id: 'net.fetch', version: 1 }, { id: 'workspace', version: 1 }, { id: 'storage', version: 1 }]); // X4 added net.fetch@1 and workspace@1, X3 storage@1
  const port = await readFile(new URL('plugins/core-execution/web/execution-env.js', root), 'utf8');
  assert.match(port, /from "\.\.\/\.\.\/\.\.\/native-host\.js"/);
  assert.doesNotMatch(port, /^import type|\bimplements\b|\breadonly\b|<T>|\bas const\b/m, 'plain JavaScript, no TypeScript');
});
