import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, tick } from './plugin-agent-support.mjs';

// Step X3: the conversation store is opened by core-storage (storage@1). Its native SQLite facade
// (plugins/core-storage/web/native-database.js) is packages/native-host/src/sqlite.ts hand-ported; the
// same scenarios run against it and against openNativeDatabase of the fixed native-host.js with a
// scripted fake bridge: calls, results and errors must be identical, also under pi-durable's
// SqliteStorage.open. Also: storage@1 picks the same store as before (SQLite database "self-forming";
// JSONL "/data/conversations" in the browser edition; memory without a bridge), the fallback chain
// (plugin module → native-host.js) and core-agent opening its sessions' store through storage@1 /
// the bundled copy. No device; dummy values only.
const available = await libraryAvailable() && await import('node:fs').then((fs) => fs.existsSync(new URL('../dist/app/native-host.js', import.meta.url)));
const skip = available ? false : 'dist/app (library and native-host.js) is not present';

let app, ported, original, coreStorage, SqliteStorage, JsonlStorage, MemoryStorage, BACKGROUND_CONTEXT, openSessionsModule;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  ported = await app.load('builtin/core-storage/web/native-database.js');
  original = await app.load('native-host.js');
  coreStorage = await app.load('builtin/core-storage/web/index.js');
  ({ SqliteStorage } = await app.load('library/pi-durable/storage/sqlite.js'));
  ({ JsonlStorage } = await app.load('library/pi-durable/storage/jsonl.js'));
  ({ MemoryStorage } = await app.load('library/pi-durable.js'));
  ({ BACKGROUND_CONTEXT } = await app.load('library/chord/context.js'));
  openSessionsModule = await app.load('builtin/core-agent/web/open-sessions.js');
});
after(async () => { await app?.remove(); });

/** Scripted bridge: handler(method, params, bridge) → value | throws | promise (undefined → default). */
function fakeBridge(handler) {
  const calls = [];
  const closeListeners = new Set();
  const bridge = {
    closed: false,
    calls,
    async call(method, params = {}) {
      calls.push([method, structuredClone(params)]);
      if (bridge.closed) throw new Error('Native bridge is closed');
      const value = handler ? await handler(method, params, bridge) : undefined;
      if (value !== undefined) return value;
      if (method === 'sqlite.open') return { handle: 'db1' };
      if (method === 'sqlite.all') return [];
      if (method === 'sqlite.queryOpen' || method === 'sqlite.queryNext') return { rows: [], cursor: null };
      return null;
    },
    subscribe() { return () => {}; },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    lose(error = new Error('Native bridge is closed')) { bridge.closed = true; for (const l of [...closeListeners]) l(error); },
    listenerCount: () => closeListeners.size
  };
  return bridge;
}
const describe = (value) => {
  if (value instanceof Uint8Array) return { bytes: [...value] };
  if (typeof value === 'bigint') return { bigint: String(value) };
  if (value instanceof AggregateError) return { error: value.constructor.name, message: value.message, errors: value.errors.map(describe) };
  if (value instanceof Error) return { error: value.constructor.name, name: value.name, code: value.code, message: value.message };
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, describe(v)]));
  return value;
};
const settle = async (work) => { try { return { ok: describe(await work()) }; } catch (error) { return { threw: describe(error) }; } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function scenarios(openNativeDatabase) {
  const out = [];
  const run = async (label, handler, work) => {
    const bridge = fakeBridge(handler);
    const result = await settle(() => work(bridge));
    await tick(); await tick();
    out.push([label, { result, calls: bridge.calls, listeners: bridge.listenerCount() }]);
  };
  const rows = (list) => (method) => method === 'sqlite.all' ? list : undefined;

  await run('invalid name', undefined, (b) => openNativeDatabase(b, 'self forming'));
  await run('no handle', (m) => m === 'sqlite.open' ? { handle: '' } : undefined, (b) => openNativeDatabase(b, 'self-forming'));
  await run('open failure', (m) => { if (m === 'sqlite.open') throw Object.assign(new Error('disk full'), { code: 'io' }); }, (b) => openNativeDatabase(b, 'self-forming'));
  await run('exec/run/get/all with encoded values', rows([{ b: { $bytes: 'AH+A/w==' }, i: { $bigint: '9223372036854775807' }, t: 'à😀', r: 1.25, n: null }]), async (b) => {
    const db = await openNativeDatabase(b, 'self-forming');
    await db.exec('CREATE TABLE v (b BLOB)');
    await db.run('INSERT INTO v VALUES (?, ?, ?, ?, ?)', new Uint8Array([0, 127, 128, 255]), 9223372036854775807n, 'à😀', 1.25, null);
    const got = await db.get('SELECT * FROM v WHERE t = ?', 'à😀');
    const all = await db.all('SELECT * FROM v');
    await db.close();
    await db.close();
    const afterClose = await settle(() => db.exec('SELECT 1'));
    return { got, all, afterClose };
  });
  await run('empty get', rows([]), async (b) => { const db = await openNativeDatabase(b, 'x'); const r = await db.get('SELECT 1'); await db.close(); return { r: r === undefined }; });
  await run('invalid binding', undefined, async (b) => { const db = await openNativeDatabase(b, 'x'); const r = await settle(() => db.run('INSERT', Number.NaN)); const s = await settle(() => db.run('INSERT', {})); await db.close(); return { r, s }; });
  await run('invalid rows', rows({}), async (b) => { const db = await openNativeDatabase(b, 'x'); return db.all('SELECT 1'); });
  await run('invalid row', rows([1]), async (b) => { const db = await openNativeDatabase(b, 'x'); return db.all('SELECT 1'); });
  await run('invalid value', rows([{ a: { $bigint: '01' } }]), async (b) => { const db = await openNativeDatabase(b, 'x'); return db.all('SELECT 1'); });
  await run('invalid base64', rows([{ a: { $bytes: '***' } }]), async (b) => { const db = await openNativeDatabase(b, 'x'); return db.all('SELECT 1'); });
  {
    let page = 0;
    await run('paged query reassembles pages', (m) => {
      if (m === 'sqlite.open') return { handle: 'db', queryPaging: true };
      if (m === 'sqlite.queryOpen') return { rows: [{ v: 'a' }, { v: 'b' }], cursor: 'c1' };
      if (m === 'sqlite.queryNext') return ++page < 2 ? { rows: [{ v: 'c' }], cursor: 'c1' } : { rows: [{ v: { $bytes: 'AQI=' } }], cursor: null };
    }, async (b) => { const db = await openNativeDatabase(b, 'paged'); const r = await db.all('SELECT v FROM t WHERE x = ?', 3n); await db.close(); return r; });
  }
  await run('paged decode failure closes the cursor first', (m) => {
    if (m === 'sqlite.open') return { handle: 'db', queryPaging: true };
    if (m === 'sqlite.queryOpen') return { rows: [{ invalid: {} }], cursor: 'q' };
  }, async (b) => { const db = await openNativeDatabase(b, 'p'); const r = await settle(() => db.all('SELECT')); await db.exec('SELECT 1'); await db.close(); return r; });
  await run('invalid page', (m) => {
    if (m === 'sqlite.open') return { handle: 'db', queryPaging: true };
    if (m === 'sqlite.queryOpen') return { rows: [], cursor: '' };
  }, async (b) => { const db = await openNativeDatabase(b, 'p'); return db.all('SELECT'); });
  await run('transaction commits in order', rows([{ x: 1 }]), async (b) => {
    const db = await openNativeDatabase(b, 'x');
    const outside = db.run('INSERT outside');
    const result = await db.transaction(async (tx) => { await tx.run('INSERT 1', 1); const r = await tx.all('SELECT x'); await tx.exec('UPDATE'); return r; });
    await outside;
    await db.close();
    return result;
  });
  await run('transaction rollback rethrows the original error', undefined, async (b) => {
    const db = await openNativeDatabase(b, 'x');
    const r = await settle(() => db.transaction(async (tx) => { await tx.run('INSERT', 1); throw new Error('rollback this'); }));
    await db.exec('SELECT after');
    await db.close();
    return r;
  });
  await run('rollback failure quarantines the database', (m, p) => { if (p.sql === 'ROLLBACK') throw new Error('cannot roll back'); }, async (b) => {
    const db = await openNativeDatabase(b, 'x');
    const r = await settle(() => db.transaction(async () => { throw new Error('callback failed'); }));
    const later = await settle(() => db.exec('SELECT 1'));
    await db.close();
    return { r, later };
  });
  await run('stale transaction handle', undefined, async (b) => {
    const db = await openNativeDatabase(b, 'x');
    let saved;
    await db.transaction(async (tx) => { saved = tx; await tx.exec('CREATE'); });
    const r = await settle(() => saved.run('INSERT', 7));
    await db.close();
    return r;
  });
  await run('bridge loss rejects queued work', undefined, async (b) => {
    const db = await openNativeDatabase(b, 'x');
    const started = deferred();
    const tx = settle(() => db.transaction(async () => { started.resolve(); await new Promise(() => {}); }));
    await started.promise;
    const queued = settle(() => db.get('SELECT 1'));
    b.lose(new Error('Native bridge is closed'));
    const results = await Promise.all([tx, queued]);
    const later = await settle(() => db.get('SELECT 2'));
    await db.close();
    return { results, later };
  });
  await run('SqliteStorage.open over the facade (fresh database)', (m, p) => {
    if (m === 'sqlite.all' && /user_version/i.test(p.sql)) return [{ user_version: 0 }];
  }, async (b) => {
    const storage = await SqliteStorage.open(await openNativeDatabase(b, 'self-forming'));
    const page = await storage.scanConversations({}, 16, undefined, BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    return { items: page.items, next: page.next };
  });
  return out;
}

test('the ported native SQLite facade behaves exactly like native-host.js openNativeDatabase', { skip }, async () => {
  const mine = await scenarios(ported.openNativeDatabase);
  const theirs = await scenarios(original.openNativeDatabase);
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < mine.length; i++) assert.deepEqual(mine[i], theirs[i], `scenario: ${theirs[i][0]}`);
  // The scenarios really exercised the paths (not all errors).
  const byLabel = Object.fromEntries(mine);
  assert.deepEqual(byLabel['paged query reassembles pages'].result.ok.map((row) => row.v), ['a', 'b', 'c', { bytes: [1, 2] }]);
  assert.equal(byLabel['exec/run/get/all with encoded values'].result.ok.got.i.bigint, '9223372036854775807');
  assert.ok(byLabel['SqliteStorage.open over the facade (fresh database)'].calls.length > 3);
  // Errors keep their class (NativeBridgeError of native-host.js) for callers that test it.
  const closedError = await (async () => { const db = await ported.openNativeDatabase(fakeBridge(), 'x'); await db.close(); try { await db.exec('x'); } catch (e) { return e; } })();
  assert.ok(closedError instanceof original.NativeBridgeError);
  assert.equal(closedError.code, 'database_closed');
});

test('storage@1 opens the same stores as before', { skip }, async () => {
  // Android: SQLite over the native database "self-forming" (same calls as the old engine path).
  const viaPlugin = fakeBridge((m, p) => m === 'sqlite.all' && /user_version/i.test(p.sql) ? [{ user_version: 0 }] : undefined);
  const viaOld = fakeBridge((m, p) => m === 'sqlite.all' && /user_version/i.test(p.sql) ? [{ user_version: 0 }] : undefined);
  // (The scripted bridge has no real schema, so SqliteStorage stops at the same point on both paths.)
  const storage = await settle(() => coreStorage.createStorage({ bridge: viaPlugin, hostInfo: { platform: 'android' } }).open({ env: { cwd: '/w' } }));
  const old = await settle(async () => SqliteStorage.open(await original.openNativeDatabase(viaOld, 'self-forming')));
  assert.deepEqual(storage, old);
  assert.equal(coreStorage.DATABASE_NAME, 'self-forming');
  assert.deepEqual(viaPlugin.calls, viaOld.calls);
  assert.deepEqual(viaPlugin.calls[0], ['sqlite.open', { name: 'self-forming' }]);
  assert.ok(viaPlugin.calls.length > 2, 'SqliteStorage ran its schema check over the plugin facade');
  // A different database name passes through (engine option databaseName).
  const named = fakeBridge();
  await settle(() => coreStorage.createStorage({ bridge: named }).open({ name: 'other' }));
  assert.deepEqual(named.calls[0], ['sqlite.open', { name: 'other' }]);
  // Without a bridge: memory.
  assert.ok(await coreStorage.createStorage({}).open() instanceof MemoryStorage);
  // Browser edition: the JSONL store browser-main.js used to open (same path, context and options).
  const recordingEnv = () => {
    const calls = [];
    const env = new Proxy({ cwd: '/workspace' }, { get(target, name) {
      if (name in target || typeof name === 'symbol' || name === 'then') return target[name];
      return async (...args) => { calls.push([name, args.filter((a) => typeof a !== 'object' || a === null || Array.isArray(a) || a instanceof Uint8Array)]); return { ok: false, error: Object.assign(new Error('not found'), { code: 'not_found' }) }; };
    } });
    return { env, calls };
  };
  const mine = recordingEnv(), theirs = recordingEnv();
  const opened = await settle(() => coreStorage.createStorage({ bridge: fakeBridge(), hostInfo: { platform: 'browser' } }).open({ env: mine.env }));
  const before = await settle(() => JsonlStorage.open('/data/conversations', theirs.env, BACKGROUND_CONTEXT, { fsync: true }));
  assert.deepEqual(describe(opened.threw ?? opened.ok?.constructor?.name), describe(before.threw ?? before.ok?.constructor?.name));
  assert.deepEqual(mine.calls, theirs.calls);
  assert.ok(mine.calls.length > 0, 'the JSONL store touched the environment');
  // Stopped service refuses.
  await assert.rejects(coreStorage.createStorage({ bridge: fakeBridge(), stopped: () => true }).open(), /stopped/);
});

test('fallback chain: native-database.js, else native-host.js', { skip }, async () => {
  const fallback = async () => ({ openNativeDatabase: original.openNativeDatabase });
  assert.equal(await coreStorage.loadNativeDatabase({ load: async () => ported, fallback }), ported.openNativeDatabase);
  const errors = console.error; console.error = () => {};
  try { assert.equal(await coreStorage.loadNativeDatabase({ load: async () => { throw new Error('missing'); }, fallback }), original.openNativeDatabase); }
  finally { console.error = errors; }
  assert.equal(await coreStorage.loadNativeDatabase(), ported.openNativeDatabase);
});

test('core-agent opens each store through storage@1, else the bundled copy', { skip }, async () => {
  const opened = [];
  const opener = (label) => ({ open: async (args) => { opened.push([label, args]); return { label }; } });
  const options = { bridge: fakeBridge(), storage: opener('bundled') };
  assert.deepEqual(await openSessionsModule.storageOption(options, { storage: () => opener('service') }, 'ENV'), { storage: { label: 'service' } });
  assert.deepEqual(await openSessionsModule.storageOption(options, { storage: () => null }, 'ENV'), { storage: { label: 'bundled' } });
  assert.deepEqual(await openSessionsModule.storageOption(options, {}, undefined), { storage: { label: 'bundled' } });
  assert.deepEqual(await openSessionsModule.storageOption({ storage: opener('bundled') }, { storage: () => opener('service') }, 'ENV'), {}, 'no bridge: the engine keeps its memory store');
  assert.deepEqual(await openSessionsModule.storageOption({ ...options, extra: { storage: {} } }, {}, 'ENV'), {}, 'a store given in extra wins');
  assert.deepEqual(opened, [['service', { env: 'ENV' }], ['bundled', { env: 'ENV' }], ['bundled', { env: undefined }]]);
});

test('the engine and core-agent no longer read globalThis.__piOpenStorage or import openNativeDatabase', { skip }, async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const engine = await readFile(new URL('apps/common/session-engine.js', root), 'utf8');
  const opener = await readFile(new URL('plugins/core-agent/web/open-sessions.js', root), 'utf8');
  assert.doesNotMatch(engine, /import\s*\{[^}]*openNativeDatabase[^}]*\}\s*from\s*"\.\/native-host\.js"/);
  assert.doesNotMatch(opener, /__piOpenStorage\s*\(/);
  assert.doesNotMatch(engine, /__piOpenStorage/);
});

// X3b: the session engine takes its conversation and server parts from the owning plugins' services
// (core-agent hands it engineParts) and falls back to its bundled static imports.
test('the engine uses conversations.engine@1 when given, else its bundled copy', { skip }, async () => {
  const session = await app.load('session.js');
  const conversations = await app.load('builtin/core-conversations/web/index.js');
  const servers = await app.load('builtin/core-servers/web/index.js');
  assert.equal(conversations.CONVERSATIONS_ENGINE_SERVICE, 'conversations.engine');
  assert.equal(servers.SERVERS_ENGINE_SERVICE, 'servers.engine');
  const real = await conversations.loadEngineParts();
  const used = [];
  const spied = Object.freeze({ ...real,
    createThreads: (...args) => { used.push('createThreads'); return real.createThreads(...args); },
    createTail: (...args) => { used.push('createTail'); return real.createTail(...args); },
    createTree: (...args) => { used.push('createTree'); return real.createTree(...args); } });
  const asked = [];
  const engineParts = (id, version) => { asked.push([id, version]); return id === 'conversations.engine' ? { load: async () => spied } : null; };
  let opened = await session.openAppSession({ storage: new MemoryStorage(), toolchain: false, demoTokensPerSecond: 0, engineParts });
  assert.equal(opened.snapshot.title, 'Main');
  await opened.close();
  assert.deepEqual(used.sort(), ['createTail', 'createThreads', 'createTree']);
  assert.deepEqual(asked, [['conversations.engine', 1]], 'no servers part without a native environment');
  // A broken part (missing member) is reported and the bundled copy is used.
  used.length = 0;
  const errors = []; const error = console.error; console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    opened = await session.openAppSession({ storage: new MemoryStorage(), toolchain: false, demoTokensPerSecond: 0,
      engineParts: () => ({ load: async () => ({ createThreads: spied.createThreads }) }) });
    assert.equal(opened.snapshot.title, 'Main');
    await opened.close();
  } finally { console.error = error; }
  assert.deepEqual(used, []);
  assert.ok(errors.some((line) => /conversations\.engine unavailable: using the bundled copy/.test(line)));
  // servers.engine@1 gives the same createServerSession as the bundled copy.
  const serversDefinition = (await app.load('core-agent-plugins.js')).CORE_AGENT_PLUGINS.find((row) => row.id === 'core-servers');
  assert.ok(serversDefinition.provides.some((p) => p.id === 'servers.engine' && p.version === 1));
});

test('createBuiltinPlugins registers core-storage before core-agent; engine part ids are fixed', { skip }, async () => {
  const builtins = await app.load('plugin-builtins.js');
  const lookups = [];
  const definitions = builtins.createBuiltinPlugins({ execution: {}, net: { bridge: fakeBridge() }, storage: { bridge: fakeBridge() }, parts: (id) => { lookups.push(id); return { id }; },
    sessions: { current() {}, onSession() {}, subscribe() {} }, harness: undefined, lifecycle: undefined, chat: null });
  const ids = definitions.map((d) => d.id);
  assert.ok(ids.indexOf('core-storage') > ids.indexOf('core-net-native') && ids.indexOf('core-storage') < ids.indexOf('core-agent'), ids.join(','));
  assert.deepEqual(builtins.ENGINE_PART_SERVICES, ['conversations.engine', 'servers.engine']);
  const agentManifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../plugins/core-agent/plugin.json', import.meta.url), 'utf8'));
  assert.ok(agentManifest.uses.some((u) => u.id === 'storage' && u.version === 1));
});
