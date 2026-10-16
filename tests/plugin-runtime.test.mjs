import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { createPluginRuntime } = await app.load('plugin-runtime.js');
const { loadInstalledPlugins, pluginEntryUrl } = await app.load('plugin-client.js');
const { createBuiltinPlugins, EXECUTION_SERVICE } = await app.load('plugin-builtins.js');

const dep = (id, version = 1) => ({ id, version });
const def = (id, options = {}) => ({ id, version: '1.0.0', setup() {}, ...options });
const states = (runtime) => Object.fromEntries(runtime.list().map((r) => [r.id, r.state]));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const hash = 'a'.repeat(64);
const manifest = (options = {}) => ({
  id: 'external', name: 'External', version: '0.1.0', hash, enabled: true, state: 'installed',
  web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [], uses: [], ...options
});

test('required and present optional dependencies activate first, values stay local, exact majors only', async () => {
  const runtime = createPluginRuntime();
  const order = [], value = { increment: (n) => n + 1 };
  runtime.register(def('consumer', { requires: [dep('counter', 2)], uses: [dep('optional'), dep('absent')], setup(ctx) {
    order.push('consumer');
    assert.equal(ctx.get('counter', 2), value);
    assert.equal(ctx.get('counter', 2).increment(2), 3);
    assert.equal(ctx.get('optional'), 9);
    assert.equal(ctx.get('absent'), null);
    assert.throws(() => ctx.get('counter', 1), /Undeclared/);
  } }));
  runtime.register(def('provider', { provides: [dep('counter', 2)], setup(ctx) { order.push('provider'); ctx.provide('counter', 2, value); } }));
  runtime.register(def('optional', { provides: [dep('optional')], setup(ctx) { order.push('optional'); ctx.provide('optional', 1, 9); } }));
  await runtime.start();
  assert.deepEqual(order, ['provider', 'optional', 'consumer']);
  assert.equal(runtime.service('counter'), null);
  assert.equal(runtime.service('counter', 2), value);
  assert.deepEqual(Object.values(states(runtime)), ['active', 'active', 'active']);
  await runtime.close();
});

test('missing hard majors block the affected chain; absent optional and independent plugins run', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('missing', { provides: [dep('middle')], requires: [dep('other', 2)] }));
  runtime.register(def('dependent', { requires: [dep('middle')] }));
  runtime.register(def('optional', { uses: [dep('middle')], setup(ctx) { assert.equal(ctx.get('middle'), null); } }));
  runtime.register(def('independent'));
  await runtime.start();
  assert.deepEqual(states(runtime), { missing: 'blocked', dependent: 'blocked', optional: 'active', independent: 'active' });
  assert.match(runtime.list()[0].reason, /other@2/);
  await runtime.close();
});

test('cycles block cycle members and hard downstream, not optional downstream or unrelated plugins', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('left', { provides: [dep('left')], requires: [dep('right')] }));
  runtime.register(def('right', { provides: [dep('right')], requires: [dep('left')] }));
  runtime.register(def('downstream', { requires: [dep('left')] }));
  runtime.register(def('optional', { uses: [dep('left')], setup(ctx) { assert.equal(ctx.get('left'), null); } }));
  runtime.register(def('independent'));
  await runtime.start();
  assert.deepEqual(states(runtime), { left: 'blocked', right: 'blocked', downstream: 'blocked', optional: 'active', independent: 'active' });
  assert.match(runtime.list()[0].reason, /cycle/);
  await runtime.close();
});

test('self cycles and optional ordering cycles are diagnosed', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('self-cycle', { provides: [dep('self')], requires: [dep('self')] }));
  runtime.register(def('left', { provides: [dep('left')], uses: [dep('right')] }));
  runtime.register(def('right', { provides: [dep('right')], uses: [dep('left')] }));
  await runtime.start();
  assert.deepEqual(Object.values(states(runtime)), ['blocked', 'blocked', 'blocked']);
  await runtime.close();
});

test('overlapping optional cycles block the entire strongly connected component', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('alpha', { provides: [dep('alpha')], uses: [dep('beta')] }));
  runtime.register(def('beta', { provides: [dep('beta')], uses: [dep('alpha'), dep('gamma')] }));
  runtime.register(def('gamma', { provides: [dep('gamma')], uses: [dep('beta')] }));
  runtime.register(def('outside', { uses: [dep('gamma')] }));
  await runtime.start();
  assert.deepEqual(states(runtime), { alpha: 'blocked', beta: 'blocked', gamma: 'blocked', outside: 'active' });
  for (const record of runtime.list().slice(0, 3)) assert.match(record.reason, /cycle/);
  await runtime.close();
});

test('duplicate providers are explicit conflicts, never last-wins; selection resolves a provider', async () => {
  for (const selection of [undefined, 'first', 'second', 'typo']) {
    const runtime = createPluginRuntime({ providers: selection ? { 'shared@1': selection } : {} });
    for (const id of ['first', 'second']) runtime.register(def(id, { provides: [dep('shared')], setup(ctx) { ctx.provide('shared', 1, id); } }));
    runtime.register(def('consumer', { requires: [dep('shared')] }));
    runtime.register(def('unrelated'));
    await runtime.start();
    assert.equal(runtime.service('shared'), ['first', 'second'].includes(selection) ? selection : null);
    assert.equal(states(runtime).consumer, ['first', 'second'].includes(selection) ? 'active' : 'blocked');
    assert.equal(states(runtime).unrelated, 'active');
    if (!selection) assert.match(runtime.list()[0].reason, /Provider conflict/);
    await runtime.close();
  }
});

test('registration validates declarations and freezes page composition; start is idempotent', async () => {
  const runtime = createPluginRuntime();
  assert.throws(() => runtime.register(def('x')), /Invalid plugin id/);
  assert.throws(() => runtime.register(def(undefined)), /Invalid plugin id/);
  assert.throws(() => runtime.register(def(null)), /Invalid plugin id/);
  assert.throws(() => runtime.register(def('valid', { api: 2 })), /API 2/);
  assert.throws(() => runtime.register(def('valid', { requires: [dep('bad', 0)] })), /positive integer/);
  assert.throws(() => runtime.register(def('valid', { requires: [dep('bad', 1.5)] })), /positive integer/);
  assert.throws(() => runtime.register(def('valid', { provides: [dep('same'), dep('same')] })), /Duplicate/);
  assert.throws(() => runtime.register(def('valid', { requires: [dep('same')], uses: [dep('same')] })), /both/);
  let runs = 0;
  runtime.register(def('valid', { setup() { runs++; } }));
  assert.throws(() => runtime.register(def('valid')), /Duplicate plugin/);
  const first = runtime.start();
  assert.equal(runtime.start(), first);
  assert.throws(() => runtime.register(def('late')), /before start/);
  await first;
  assert.equal(runs, 1);
  const snapshot = runtime.list(); snapshot[0].state = 'corrupt';
  assert.equal(runtime.list()[0].state, 'active');
  await runtime.close();
});

test('failed setup reverses owned cleanup, removes partial entries, continues after individual errors', async () => {
  const order = [], errors = [], runtime = createPluginRuntime({ onError(error, info) { errors.push([error.message, info.phase]); } });
  runtime.register(def('broken', { provides: [dep('partial')], setup(ctx) {
    ctx.provide('partial', 1, {});
    ctx.contribute('views', 'partial', {});
    ctx.cleanup(() => order.push('first'));
    ctx.cleanup(async () => { order.push('second'); throw new Error('cleanup failed'); });
    ctx.cleanup(() => order.push('third'));
    throw new Error('setup failed');
  } }));
  runtime.register(def('dependent', { requires: [dep('partial')] }));
  runtime.register(def('optional', { uses: [dep('partial')], setup(ctx) { assert.equal(ctx.get('partial'), null); } }));
  await runtime.start();
  assert.deepEqual(order, ['third', 'second', 'first']);
  assert.deepEqual(errors, [['setup failed', 'setup'], ['cleanup failed', 'cleanup']]);
  assert.equal(runtime.service('partial'), null);
  assert.deepEqual(runtime.contributions('views'), []);
  assert.deepEqual(states(runtime), { broken: 'failed', dependent: 'blocked', optional: 'active' });
  await runtime.stop('broken'); await runtime.stop('broken'); await runtime.close(); await runtime.close();
  assert.deepEqual(order, ['third', 'second', 'first']);
});

test('unfulfilled or undeclared provides fail, rather than publishing a pretend service', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('unfulfilled', { provides: [dep('missing')] }));
  runtime.register(def('undeclared', { setup(ctx) { ctx.provide('nope', 1, {}); } }));
  runtime.register(def('duplicate', { provides: [dep('twice')], setup(ctx) { ctx.provide('twice', 1, 1); ctx.provide('twice', 1, 2); } }));
  await runtime.start();
  assert.deepEqual(Object.values(states(runtime)), ['failed', 'failed', 'failed']);
  assert.equal(runtime.service('twice'), null);
  await runtime.close();
});

test('contributions have stable ordered keys, dispose ownership, and reject duplicate keys', async () => {
  const runtime = createPluginRuntime(); let dispose;
  runtime.register(def('first', { setup(ctx) {
    ctx.contribute('views', 'z-last', 3, 10);
    ctx.contribute('views', 'b-middle', 2, 0);
    dispose = ctx.contribute('views', 'a-first', 1, 0);
  } }));
  runtime.register(def('conflict', { setup(ctx) { ctx.contribute('views', 'a-first', 99); } }));
  await runtime.start();
  assert.equal(states(runtime).conflict, 'failed');
  assert.match(runtime.list()[1].reason, /Contribution conflict/);
  assert.deepEqual(runtime.contributions('views').map((entry) => [entry.key, entry.value, entry.providerId]), [
    ['a-first', 1, 'first'], ['b-middle', 2, 'first'], ['z-last', 3, 'first']
  ]);
  dispose(); dispose();
  assert.equal(runtime.contributions('views').length, 2);
  await runtime.stop('first');
  assert.deepEqual(runtime.contributions('views'), []);
  await runtime.close();
});

test('stop shuts hard dependents transitively in reverse order, leaving optional consumers alive', async () => {
  const runtime = createPluginRuntime(), order = [];
  runtime.register(def('leaf', { requires: [dep('middle')], setup() { return () => order.push('leaf'); } }));
  runtime.register(def('middle', { requires: [dep('root')], provides: [dep('middle')], setup(ctx) { ctx.provide('middle', 1, {}); return () => order.push('middle'); } }));
  runtime.register(def('root', { provides: [dep('root')], setup(ctx) { ctx.provide('root', 1, {}); return () => order.push('root'); } }));
  let optionalCtx;
  runtime.register(def('optional', { uses: [dep('root')], setup(ctx) { optionalCtx = ctx; } }));
  await runtime.start();
  await runtime.stop('root');
  assert.deepEqual(order, ['leaf', 'middle', 'root']);
  assert.deepEqual(states(runtime), { leaf: 'stopped', middle: 'stopped', root: 'stopped', optional: 'active' });
  assert.equal(optionalCtx.get('root'), null);
  await runtime.stop('root'); await runtime.stop('unknown');
  assert.equal(order.length, 3);
  await runtime.close();
});

test('scope owns timers, abort signal, and setup-returned cleanup', async () => {
  const runtime = createPluginRuntime(), order = []; let context, fired = false;
  runtime.register(def('timers', { setup(ctx) {
    context = ctx;
    ctx.cleanup(() => order.push('registered'));
    ctx.setTimeout(() => { fired = true; }, 20);
    ctx.setInterval(() => { fired = true; }, 20);
    return () => order.push('returned');
  } }));
  await runtime.start(); await runtime.close();
  assert.equal(context.signal.aborted, true);
  assert.deepEqual(order, ['returned', 'registered']);
  assert.throws(() => context.contribute('views', 'late', {}), /closed/);
  assert.throws(() => context.setTimeout(() => {}, 1), /closed/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, false);
});

test('abort listeners and status subscribers can reenter stop without duplicating cleanup', async () => {
  const runtime = createPluginRuntime(); let cleanups = 0, aborts = 0;
  runtime.register(def('feature', { setup(ctx) {
    ctx.signal.addEventListener('abort', () => { aborts++; void runtime.stop('feature'); });
    ctx.cleanup(() => { cleanups++; });
  } }));
  await runtime.start();
  runtime.subscribe((records) => { if (records[0].state === 'stopped') void runtime.stop('feature'); });
  await runtime.stop('feature');
  assert.equal(cleanups, 1); assert.equal(aborts, 1);
  await runtime.close();
});

test('subscriptions report status and contribution changes, unsubscribe, and isolate listener errors', async () => {
  const errors = [], snapshots = [];
  const runtime = createPluginRuntime({ onError(error, info) { errors.push(info.phase); throw error; } });
  const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
  runtime.subscribe(() => { throw new Error('listener'); });
  let dispose;
  runtime.register(def('feature', { setup(ctx) { dispose = ctx.contribute('views', 'view', {}); } }));
  await runtime.start();
  assert(snapshots.some((snapshot) => snapshot[0]?.state === 'starting'));
  assert.equal(snapshots.at(-1)[0].state, 'active');
  const count = snapshots.length;
  dispose(); assert.equal(snapshots.length, count + 1);
  unsubscribe(); await runtime.close();
  assert.equal(snapshots.length, count + 1);
  assert(errors.every((phase) => phase === 'subscribe'));
});

test('async readiness deadline is 5000ms: abort, partial cleanup, independent start, and late returned cleanup', async (t) => {
  const original = globalThis.setTimeout;
  let deadlines = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 5000) { deadlines++; return original(fn, 15, ...args); }
    return original(fn, delay, ...args);
  });
  const gate = deferred(), runtime = createPluginRuntime(), order = []; let ctx;
  runtime.register(def('slow', { provides: [dep('slow')], async setup(context) {
    ctx = context;
    ctx.provide('slow', 1, {});
    ctx.contribute('views', 'slow', {});
    ctx.cleanup(() => order.push('partial'));
    await gate.promise;
    ctx.cleanup(() => order.push('late-registered'));
    return () => order.push('late-returned');
  } }));
  runtime.register(def('dependent', { requires: [dep('slow')] }));
  runtime.register(def('independent'));
  await runtime.start();
  assert.equal(deadlines, 2);
  assert.equal(ctx.signal.aborted, true);
  assert.deepEqual(states(runtime), { slow: 'failed', dependent: 'blocked', independent: 'active' });
  assert.match(runtime.list()[0].reason, /5000ms/);
  assert.equal(runtime.service('slow'), null);
  assert.deepEqual(runtime.contributions('views'), []);
  assert.deepEqual(order, ['partial']);
  gate.resolve(); await tick();
  assert.deepEqual(order, ['partial', 'late-registered', 'late-returned']);
  await runtime.close();
  assert.equal(order.length, 3);
});

test('stop during pending activation aborts promptly and disposes late completion without resurrection', async () => {
  const runtime = createPluginRuntime(), entered = deferred(), gate = deferred(); let ctx, cleanups = 0;
  runtime.register(def('pending', { async setup(context) { ctx = context; entered.resolve(); await gate.promise; return () => cleanups++; } }));
  runtime.register(def('independent'));
  const start = runtime.start(); await entered.promise;
  await runtime.stop('pending'); await start;
  assert.equal(ctx.signal.aborted, true);
  assert.deepEqual(states(runtime), { pending: 'stopped', independent: 'active' });
  gate.resolve(); await tick();
  assert.equal(cleanups, 1);
  assert.equal(states(runtime).pending, 'stopped');
  await runtime.close();
});

test('close during pending activation does not run remaining features', async () => {
  const runtime = createPluginRuntime(), entered = deferred(), gate = deferred(); let runs = 0;
  runtime.register(def('pending', { async setup() { entered.resolve(); await gate.promise; return () => runs++; } }));
  runtime.register(def('remaining', { setup() { runs += 100; } }));
  const start = runtime.start(); await entered.promise;
  await runtime.close(); await start;
  gate.resolve(); await tick();
  assert.equal(runs, 1);
  assert.deepEqual(Object.values(states(runtime)), ['stopped', 'stopped']);
});

test('external loading uses immutable entry URL, named/default setup, pinned native calls and supplied adapters', async () => {
  for (const defaultExport of [false, true]) {
    const runtime = createPluginRuntime(), imports = [], calls = [], adapters = { durable: {} };
    const item = manifest({ provides: [dep('external.value')] });
    const bridge = { async call(method, params) { calls.push([method, params]); return method === 'plugins.list' ? { api: 1, plugins: [item] } : 7; } };
    let captured;
    const result = await loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities: { plugins: true } }, adapters,
      importModule: async (url) => {
        imports.push(url);
        const setup = async (ctx) => { captured = ctx; assert.equal(ctx.adapters, adapters); ctx.provide('external.value', 1, await ctx.native.call('increment', { delta: 1 })); };
        return defaultExport ? { default: { setup } } : { setup };
      }
    });
    assert.equal(result.plugins[0].registered, true);
    assert.deepEqual(imports, [], 'Import is guarded by the runtime readiness deadline');
    item.hash = 'b'.repeat(64);
    await runtime.start();
    assert.deepEqual(imports, [`/assets/web/plugins/external/${hash}/web/index.js`]);
    assert.deepEqual(calls, [['plugins.list', {}], ['plugins.call', { id: 'external', hash, method: 'increment', input: { delta: 1 } }]]);
    assert.equal(runtime.service('external.value'), 7);
    await assert.rejects(captured.native.call('', []), /method string/);
    await runtime.close();
    await assert.rejects(captured.native.call('late'), /closed/);
    assert.equal(calls.length, 2);
  }
});

test('old hosts without capability or method yield an empty list; other transport failures remain errors', async () => {
  const runtime = createPluginRuntime(); let calls = 0;
  const bridge = { async call() { calls++; throw Object.assign(new Error('old'), { code: 'METHOD_NOT_FOUND' }); } };
  assert.deepEqual(await loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities: {} } }), { available: false, plugins: [] });
  assert.equal(calls, 0);
  assert.deepEqual(await loadInstalledPlugins({ runtime, bridge }), { available: false, plugins: [] });
  assert.equal(calls, 1);
  await assert.rejects(loadInstalledPlugins({ runtime, bridge: { call() { throw new Error('detached'); } } }), /detached/);
  await runtime.close();
});

test('native-only packages are legal; disabled, failed, blocked and restart-required snapshots are not imported', async () => {
  const runtime = createPluginRuntime(), imports = [];
  const plugins = [manifest({ id: 'native-only', web: undefined, native: { jar: 'native/module.jar', class: 'Example' }, reload: 'restart', provides: [dep('not-a-js-service')] }),
    ...['disabled', 'failed', 'blocked', 'restart-required'].map((state) => manifest({ id: state, state })),
    manifest({ id: 'not-enabled', enabled: false })];
  const result = await loadInstalledPlugins({ runtime, bridge: { async call() { return { api: 1, plugins }; } }, importModule: async (url) => imports.push(url) });
  await runtime.start();
  assert.equal(result.plugins.length, 6);
  assert(result.plugins.every((p) => !p.registered));
  assert.deepEqual(imports, []);
  assert.deepEqual(runtime.list(), []);
  assert.equal(runtime.service('not-a-js-service'), null);
  await runtime.close();
});

test('external path and revision checks reject traversal and noncanonical executable URLs', () => {
  for (const entry of ['../web/a.js', '/web/a.js', 'web/../a.js', 'web//a.js', 'web/./a.js', 'web/a.js?x', 'web/a.js#x', 'web/%2e%2e/a.js', 'web/a\\b.js', 'web/']) {
    assert.throws(() => pluginEntryUrl(manifest({ web: { entry } })), /path|web.entry/);
  }
  assert.throws(() => pluginEntryUrl(manifest({ hash: '../bad' })), /hash/);
  assert.throws(() => pluginEntryUrl(manifest({ id: '../bad' })), /id/);
  assert.throws(() => pluginEntryUrl(manifest({ id: undefined })), /id/);
  assert.throws(() => pluginEntryUrl(null), /id/);
});

test('external malformed metadata, API, duplicate IDs and core collisions are diagnostic, not implicit replacement', async () => {
  const runtime = createPluginRuntime(); runtime.register(def('core-execution'));
  const load = (plugins, api = 1) => loadInstalledPlugins({ runtime, bridge: { async call() { return { api, plugins }; } } });
  await assert.rejects(load([], 2), /API 2/);
  await assert.rejects(load([manifest(), manifest()]), /Duplicate installed/);
  const result = await load([manifest({ id: 'core-execution' }), manifest({ id: 'bad-api', api: 4 }), manifest({ id: 'bad-path', web: { entry: '../bad' } })]);
  assert(result.plugins.every((p) => p.state === 'failed' && !p.registered));
  await runtime.start(); assert.deepEqual(states(runtime), { 'core-execution': 'active' });
  await runtime.close();
});

test('late module import cannot run external setup after scope closure', async () => {
  const runtime = createPluginRuntime(), gate = deferred(), imported = deferred(); let setups = 0;
  await loadInstalledPlugins({ runtime, bridge: { async call() { return { api: 1, plugins: [manifest()] }; } }, importModule: () => { imported.resolve(); return gate.promise; } });
  const start = runtime.start(); await imported.promise; await runtime.stop('external'); await start;
  gate.resolve({ setup() { setups++; } }); await tick();
  assert.equal(setups, 0);
  await runtime.close();
});

test('built-in execution adapter opens lazily through the selected service and stops cleanly', async () => {
  const runtime = createPluginRuntime(), environment = { cwd: '/workspace', exec() {} }; let opens = 0;
  const definitions = createBuiltinPlugins({ openExecution: async () => { opens++; return environment; } });
  for (const definition of [...definitions].reverse()) runtime.register(definition);
  await runtime.start();
  assert.equal(opens, 0);
  const execution = runtime.service(EXECUTION_SERVICE);
  assert.equal(await execution.open(), environment);
  assert.equal(opens, 1);
  await runtime.stop('core-execution');
  assert.equal(runtime.service(EXECUTION_SERVICE), null);
  assert.throws(() => execution.open(), /stopped/);
  await runtime.close();
});

test('built-in service replacement must be selected explicitly', async () => {
  const replacement = { open: async () => 'replacement' };
  const runtime = createPluginRuntime({ providers: { 'execution@1': 'alternative' } });
  for (const definition of createBuiltinPlugins({ openExecution() { throw new Error('must not be called'); } })) runtime.register(definition);
  runtime.register(def('alternative', { provides: [dep('execution')], setup(ctx) { ctx.provide('execution', 1, replacement); } }));
  await runtime.start();
  assert.equal(runtime.service(EXECUTION_SERVICE), replacement);
  assert.equal(await runtime.service(EXECUTION_SERVICE).open(), 'replacement');
  await runtime.close();
});

test('C6 requestStop() refuses an active essential reload:"page" plugin, without partial teardown', async () => {
  const runtime = createPluginRuntime();
  const log = [];
  runtime.register(def('core', { essential: true, reload: 'page', provides: [dep('core.service')], setup(ctx) {
    ctx.provide('core.service', 1, { ok: true }); ctx.signal.addEventListener('abort', () => log.push('core-abort'));
  } }));
  runtime.register(def('user', { requires: [dep('core.service')], setup(ctx) { ctx.signal.addEventListener('abort', () => log.push('user-abort')); } }));
  runtime.register(def('plain', { reload: 'scope', setup(ctx) { ctx.signal.addEventListener('abort', () => log.push('plain-abort')); } }));
  await runtime.start();
  assert.equal(runtime.reloadPending(), false);
  await assert.rejects(runtime.requestStop('core'), /core is essential.*after the app reloads/);
  assert.deepEqual(states(runtime), { core: 'active', user: 'active', plain: 'active' });
  assert.deepEqual(log, []);
  assert.equal(runtime.reloadPending(), true);
  assert.equal(runtime.list().find((r) => r.id === 'core').reloadPending, true);
  assert.equal(runtime.service('core.service', 1).ok, true);
  // Internal stop() is unrestricted; user requests for non-essential plugins also work.
  await runtime.requestStop('plain'); assert.equal(states(runtime).plain, 'stopped');
  // Non-essential plugins still stop; close() still tears everything down.
  await runtime.stop('plain');
  assert.equal(states(runtime).plain, 'stopped');
  await runtime.close();
  assert.deepEqual(states(runtime), { core: 'stopped', user: 'stopped', plain: 'stopped' });
});

test('C6 requestStop() of a plugin whose dependents include an active essential page plugin is refused whole', async () => {
  const runtime = createPluginRuntime();
  runtime.register(def('base', { provides: [dep('base.service')], setup(ctx) { ctx.provide('base.service', 1, {}); } }));
  runtime.register(def('core', { essential: true, reload: 'page', requires: [dep('base.service')] }));
  await runtime.start();
  await assert.rejects(runtime.requestStop('base'), /would also stop core/);
  assert.deepEqual(states(runtime), { base: 'active', core: 'active' });
  await runtime.close();
});
