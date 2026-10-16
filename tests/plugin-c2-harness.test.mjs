import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';
import { nativeWithServers } from './plugin-a4-support.mjs';

// Step C2 (docs/plugins-providers-agent-core.md §B2/§D): the agent.harness@1 handle.
// Real session.js / agent-sessions.js / plugin-builtins.js / plugin-runtime.js /
// servers-service.js with the bundled pi-durable library (offline demo model, memory
// storage, the A2/A4 memory + tmux fakes). No network, device or native host.
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';

let app, pd, session, lifecycle, builtins, runtimeModule, agentModule, serversService, revisionsModule, contracts, H;
const probes = [];
before(async () => {
  if (!available) return;
  app = await assembleApp();
  // Instrument the temporary copy only: record what servers@1 connect() receives.
  const path = join(app.dir, 'builtin/core-servers/web/servers-service.js');
  const find = 'connect({ harness, env, rootConversationId, context: callContext }) {';
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes(find), 'servers-service.js connect() moved');
  await writeFile(path, text.replace(find, `${find} globalThis.__c2Probe?.({ harness, env, rootConversationId, context: callContext });`));
  globalThis.__c2Probe = (args) => probes.push(args);
  pd = await app.load('library/pi-durable.js');
  session = await app.load('session.js');
  lifecycle = await app.load('agent-sessions.js');
  builtins = await app.load('plugin-builtins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  serversService = await app.load('builtin/core-servers/web/servers-service.js');
  revisionsModule = await app.load('app-revisions.js');
  contracts = await app.load('agent-contracts.js');
  H = contracts.AGENT_HARNESS_V1;
});
after(async () => {
  delete globalThis.__c2Probe;
  await app?.remove();
});

const sorted = (list) => [...list].sort();
const GROUPS = () => ({ storage: H.storage, models: Object.keys(H.models), tools: Object.keys(H.tools), prompt: Object.keys(H.prompt) });
const handleMembers = () => sorted([...H.values, ...H.methods, ...H.hooks ?? [], ...Object.keys(GROUPS())]);
const memoryStorage = () => new (class extends pd.MemoryStorage { async close() {} })();

/** An agentExtensions adapter (real one, never connected) that records the agent host it attaches with. */
function spyAdapter({ ready = () => Promise.resolve() } = {}) {
  const real = agentModule.createAgentExtensions({ onError() {} });
  const hosts = [];
  const atAttach = [];
  const adapter = {
    ...real,
    ready,
    attach(registry, options) {
      hosts.push(options.host);
      // Before Harness.open: the handle exists but refuses every call.
      try { options.host.harness.inspect(); atAttach.push('called'); } catch (error) { atAttach.push(error.message); }
      return real.attach(registry, options);
    }
  };
  return { adapter, hosts, atAttach };
}

async function openWith(name, extra = {}) {
  const configuration = name === 'servers' ? nativeWithServers() : CONFIGURATIONS[name]();
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = configuration.hostInfo;
  try {
    return await session.openAppSession({ storage: memoryStorage(), toolchain: false, demoTokensPerSecond: 0, ...configuration.options, ...extra });
  } finally {
    globalThis.__piHostInfo = saved;
  }
}

function assertHandle(handle) {
  assert.deepEqual(sorted(Object.keys(handle)), handleMembers(), 'exactly the agent.harness@1 members');
  assert.ok(Object.isFrozen(handle), 'handle is frozen');
  for (const [group, members] of Object.entries(GROUPS())) {
    assert.deepEqual(sorted(Object.keys(handle[group])), sorted(members), `${group}: exactly the contract members`);
    assert.ok(Object.isFrozen(handle[group]), `${group} is frozen`);
    for (const member of members) assert.equal(typeof handle[group][member], 'function', `${group}.${member}`);
  }
  for (const method of H.methods) assert.equal(typeof handle[method], 'function', method);
  for (const name of H.forbidden) assert.ok(!(name in handle), `${name} is never on the handle`);
  for (const name of ['close', 'commit', 'prepare', 'apply', 'putTask']) assert.ok(!(name in handle.storage), `storage view is read-only (no ${name})`);
  assert.ok(handle.started instanceof Promise, 'started is a promise');
  assert.throws(() => { handle.extra = 1; }, TypeError);
}

test('session.js: frozen handle with exactly the contract members, given to onHarness after open and null before close', { skip }, async () => {
  const events = [];
  const { adapter, hosts, atAttach } = spyAdapter();
  const opened = await openWith('native', { onHarness: (value, details) => events.push([value, details]), agentExtensions: adapter });
  let handle;
  try {
    assert.equal(events.length, 1, 'reported once after Harness.open');
    [[handle]] = events;
    assertHandle(handle);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].harness, handle, 'agentHost.harness is the handle');
    assert.equal(Object.getOwnPropertyDescriptor(hosts[0], 'harness').enumerable, true, 'copied into session-bound create(host) (agent-extensions.js spreads the host)');
    assert.deepEqual(atAttach, [contracts.SESSION_NOT_OPEN_MESSAGE], 'before Harness.open every call throws');
    // Values.
    assert.equal(handle.rootConversationId, pd.ROOT_CONVERSATION_ID);
    assert.equal(handle.rootConversationId, opened.snapshot.conversation.id, 'root = main conversation');
    assert.ok(handle.context !== undefined);
    assert.equal(typeof handle.env?.exec, 'function', 'the native execution environment');
    assert.equal(typeof handle.workspace?.read, 'function', 'the session workspace');
    await handle.started;
    // Methods forward to the Harness / the read-only storage.
    const inspected = await handle.inspect(handle.context);
    assert.ok(Array.isArray(inspected.tasks) && Array.isArray(inspected.submissions));
    const page = await handle.storage.scanConversations({}, 10, undefined, handle.context);
    assert.ok(page.items.some((item) => item.id === handle.rootConversationId));
    assert.equal((await handle.storage.conversation(handle.rootConversationId, handle.context))?.id, handle.rootConversationId);
    assert.ok((await handle.snapshot(pd.AgentDoc, handle.rootConversationId, handle.context))?.model, 'snapshot(Doc, id)');
    assert.equal(typeof (await handle.conversation(handle.rootConversationId, handle.context)).agent, 'function');
    const unsubscribe = handle.subscribeCommits(() => {});
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
    // Grouped helpers (A5 prerequisites: models / tools / prompt).
    const names = handle.tools.names();
    assert.ok(names.includes('bash') && names.includes('subagent'), 'tools.names() lists the session tools');
    assert.equal(typeof handle.tools.get(names[0])?.execute, 'function', 'tools.get(name)');
    assert.equal(handle.models.clampThinking({ provider: 'faux', modelId: 'faux-1' }, 'off'), 'off');
    assert.match(await handle.models.list({ provider: 'faux', modelId: 'faux-1' }), /^same: your model \(faux\/faux-1\)/, 'models.list() (the subagent models text)');
    await handle.commit(async (tx) => { await handle.prompt.configure(tx, handle.rootConversationId, {}); }, handle.context);
  } finally {
    await opened.close();
  }
  assert.equal(events.length, 2, 'null reported when the session closes');
  assert.equal(events[1][0], null);
  assert.equal(events[1][1].previous, handle, 'the null names the handle that ends');
  assert.throws(() => handle.inspect(), /closed/, 'after close the handle refuses calls');
  assert.throws(() => handle.storage.conversation(0), /closed/);
  assert.throws(() => handle.tools.names(), /closed/);
});

test('session.js: null is reported before the Harness closes (the handle still works inside the listener)', { skip }, async () => {
  const order = [];
  let handle;
  const opened = await openWith('offline', {
    onHarness: (value) => {
      if (value) { handle = value; order.push('handle'); return; }
      // Still before Harness.close: the Harness answers.
      order.push('null');
      void handle.inspect(handle.context).then(() => order.push('inspect ok'), (error) => order.push(`inspect failed: ${error.message}`));
    }
  });
  assert.deepEqual(order, ['handle']);
  await opened.close();
  await until(() => order.length === 3, 'inspect did not settle');
  assert.deepEqual(order, ['handle', 'null', 'inspect ok']);
});

test('session.js: started resolves in startTasks; a never-started session rejects started on close', { skip }, async () => {
  let handle;
  const ok = await openWith('offline', { onHarness: (value) => { if (value) handle = value; } });
  await handle.started; // no adapter: startTasks right after startup
  await ok.close();
  let stuck;
  const { adapter } = spyAdapter({ ready: () => new Promise(() => {}) });
  const pending = await openWith('offline', { agentExtensions: adapter, onHarness: (value) => { if (value) stuck = value; } });
  let state = 'pending';
  stuck.started.then(() => { state = 'resolved'; }, (error) => { state = error.message; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state, 'pending', 'tasks wait for plugin composition');
  await pending.close();
  await until(() => state !== 'pending', 'started did not settle on close');
  assert.match(state, /closed before its tasks started/);
});

test('session.js: a session without options.onHarness reports to the registered page controller', { skip }, async () => {
  const sessions = lifecycle.createAgentSessions({ open: async () => undefined, closer: revisionsModule.createSessionCloser(() => {}) });
  lifecycle.setPageAgentSessions(sessions);
  try {
    assert.equal(lifecycle.pageAgentHarness(), sessions.harness);
    assert.equal(lifecycle.pageHarnessListener(), sessions.onHarness);
    assert.equal(sessions.harness.current(), null, 'null before open');
    const opened = await openWith('offline');
    const handle = sessions.harness.current();
    assert.ok(handle, 'the page facade got the handle');
    assertHandle(handle);
    await opened.close();
    assert.equal(sessions.harness.current(), null, 'null after close');
  } finally {
    lifecycle.setPageAgentSessions(undefined);
  }
  assert.equal(lifecycle.pageAgentHarness(), undefined);
  assert.equal(lifecycle.pageHarnessListener(), undefined);
});

function page() {
  const storage = memoryStorage();
  const listeners = [];
  const opened = [];
  const errors = [];
  const bridge = { subscribe: (listener) => listeners.push(listener), call: async () => ({}) };
  const sessions = lifecycle.createAgentSessions({
    async open({ wanted, onHarness }) {
      const value = await session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, onHarness });
      if (!wanted()) { await value.close(); return undefined; }
      opened.push(value);
      return value;
    },
    closer: revisionsModule.createSessionCloser((value) => value.setDraft('draft')),
    bridge, hostInfo: { foreground: true, capabilities: {} },
    reportError: (cause) => errors.push(cause), onOpenError: (cause) => errors.push(cause)
  });
  const lifecycleEvent = (foreground) => { for (const listener of listeners) listener({ event: 'host.lifecycle', foreground }); };
  return { sessions, opened, errors, lifecycleEvent };
}

test('agent.harness@1 facade: exact members, frozen, null before open/after close, follows reopen, not-open text', { skip }, async () => {
  const p = page();
  const facade = p.sessions.harness;
  assert.ok(Object.isFrozen(facade));
  assert.deepEqual(sorted(Object.keys(facade)), sorted([...H.facade, ...handleMembers()]), 'facade + handle members');
  for (const name of H.forbidden) assert.ok(!(name in facade), `${name} is never on the facade`);
  for (const group of Object.keys(GROUPS())) assert.ok(Object.isFrozen(facade[group]));
  // Before open.
  assert.equal(facade.current(), null);
  assert.throws(() => facade.inspect(), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  assert.throws(() => facade.rootConversationId, { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  assert.throws(() => facade.storage.task(1), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  assert.throws(() => facade.models.clampThinking({}, 'off'), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  const seen = [];
  const unsubscribe = facade.onSession((value, details) => seen.push([value, details?.reason]));
  await p.sessions.start();
  const first = facade.current();
  assert.ok(first);
  assertHandle(first);
  assert.deepEqual(seen, [[first, 'open']]);
  assert.equal(facade.rootConversationId, first.rootConversationId);
  assert.equal(facade.started, first.started);
  assert.ok(Array.isArray((await facade.inspect(facade.context)).tasks), 'forwarded to the current handle');
  assert.equal(facade.models.clampThinking({ provider: 'faux', modelId: 'faux-1' }, 'off'), 'off');
  assert.ok(Array.isArray(facade.tools.names()));
  // Background: closed after the draft is saved; null before the Harness closes.
  p.lifecycleEvent(false);
  await until(() => facade.current() === null && seen.length === 2, 'no null after background close');
  assert.deepEqual(seen[1], [null, 'close']);
  assert.throws(() => facade.inspect(), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  // Foreground: the facade follows the reopened session.
  p.lifecycleEvent(true);
  await until(() => facade.current() && facade.current() !== first, 'did not reopen');
  const second = facade.current();
  assertHandle(second);
  assert.deepEqual(seen[2], [second, 'open']);
  assert.equal(p.sessions.current(), p.opened[1]);
  const page2 = await facade.storage.scanConversations({}, 10, undefined, facade.context);
  assert.ok(page2.items.length > 0, 'forwarded to the reopened session');
  assert.throws(() => first.inspect(), /closed/, 'the old handle stays closed');
  unsubscribe();
  await p.sessions.closeForReload(p.sessions.current());
  assert.equal(facade.current(), null, 'null after close');
  assert.equal(seen.length, 3, 'unsubscribed listener not called');
  assert.deepEqual(p.errors, []);
});

test('agent.harness@1 facade: a late null for an older handle never clears a newer one', { skip }, async () => {
  const sessions = lifecycle.createAgentSessions({ open: async () => undefined, closer: revisionsModule.createSessionCloser(() => {}) });
  const a = Object.freeze({ name: 'a' });
  const b = Object.freeze({ name: 'b' });
  const seen = [];
  sessions.harness.onSession((value) => seen.push(value?.name ?? null));
  sessions.onHarness(a);
  sessions.onHarness(a);
  sessions.onHarness(b);
  sessions.onHarness(null, { previous: a });
  assert.equal(sessions.harness.current(), b);
  sessions.onHarness(null, { previous: b });
  assert.equal(sessions.harness.current(), null);
  sessions.onHarness(null);
  assert.deepEqual(seen, ['a', 'b', null]);
});

test('core-agent provides agent.harness@1 (the registered page facade) besides agent.sessions@1', { skip }, async () => {
  const sessions = lifecycle.createAgentSessions({ open: async () => undefined, closer: revisionsModule.createSessionCloser(() => {}) });
  // Explicit sessions facade only: unchanged C1 behaviour.
  const plainDefinition = builtins.createBuiltinPlugins({ openExecution() {}, sessions: sessions.facade }).find((item) => item.id === 'core-agent');
  assert.deepEqual(plainDefinition.provides, [{ id: 'agent.sessions', version: 1 }]);
  const explicit = builtins.createBuiltinPlugins({ openExecution() {}, sessions: sessions.facade, harness: sessions.harness }).find((item) => item.id === 'core-agent');
  assert.deepEqual(explicit.provides, [{ id: 'agent.sessions', version: 1 }, { id: 'agent.harness', version: 1 }]);
  assert.throws(() => builtins.createBuiltinPlugins({ openExecution() {}, sessions: sessions.facade, harness: {} }), /agent.harness@1 facade/);
  lifecycle.setPageAgentSessions(sessions);
  try {
    const runtime = runtimeModule.createPluginRuntime();
    for (const item of builtins.createBuiltinPlugins({ openExecution() {} })) runtime.register(item);
    await runtime.start();
    assert.equal(runtime.service('agent.sessions', 1), sessions.facade);
    assert.equal(runtime.service('agent.harness', 1), sessions.harness);
    assert.equal(builtins.AGENT_HARNESS_SERVICE, 'agent.harness');
    await runtime.close();
  } finally {
    lifecycle.setPageAgentSessions(undefined);
  }
});

test('servers@1 connects through host.harness (the handle): no raw Harness, same results', { skip, timeout: 60000 }, async () => {
  probes.length = 0;
  let handle;
  const opened = await openWith('servers', { onHarness: (value) => { if (value) handle = value; } });
  try {
    await until(() => probes.length > 0, 'servers@1 connect() was not called');
    const [args] = probes;
    assert.equal(args.harness, handle, 'connect() gets the agent.harness@1 handle');
    for (const name of H.forbidden) assert.ok(!(name in args.harness), `no ${name} reaches servers`);
    assert.equal(args.env, handle.env);
    assert.equal(args.rootConversationId, handle.rootConversationId);
    assert.equal(args.context, handle.context);
    const service = serversService.createServersService({ persistent: true });
    const status = await service.status();
    assert.equal(status.persistent, true);
    assert.equal(typeof status.content[0].text, 'string');
    const started = await service.start({ name: 'web', command: 'serve-web', startGraceSeconds: 0 });
    assert.match(started.content[0].text, /^Scheduled web \(tmux session srv-/);
    assert.equal((await handle.getTask(started.details.taskId, handle.context))?.id, started.details.taskId, 'the task is visible through the handle');
    await service.stop('web');
  } finally {
    await opened.close();
  }
  const unused = serversService.createServerSession({ build: () => ({}) });
  try {
    assert.throws(() => unused.connectHost({}), /agent.harness@1 handle/);
  } finally {
    unused.close();
  }
});
