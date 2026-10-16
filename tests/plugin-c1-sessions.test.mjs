import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { createAgentSessions, pageAgentSessions, setPageAgentSessions } = await app.load('agent-sessions.js');
const { createSessionCloser, createAppRevisions } = await app.load('app-revisions.js');
const { AGENT_SESSIONS_V1: S, SESSION_NOT_OPEN_MESSAGE } = await app.load('agent-contracts.js');
const { createBuiltinPlugins } = await app.load('plugin-builtins.js');
const { createPluginRuntime } = await app.load('plugin-runtime.js');

// Step C1 (docs/plugins-providers-agent-core.md §D, §F.3): the page-owned session lifecycle
// and agent.sessions@1 facade (agent-sessions.js), with fake sessions and a fake bridge, the
// real createSessionCloser and the real app-revisions activation chain (fake DOM).
const root = fileURLToPath(new URL('..', import.meta.url));
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function fakeSession(name, log, { busy = false, anyBusy = false, closeError, draftError } = {}) {
  const listeners = new Set();
  const session = {
    name,
    closed: false,
    snapshot: { busy, anyBusy, paused: false, owned: false, conversation: { id: 1, draft: '' } },
    subscribe(listener) { listeners.add(listener); listener(session.snapshot); return () => { listeners.delete(listener); }; },
    emit(patch) { session.snapshot = { ...session.snapshot, ...patch }; for (const listener of [...listeners]) listener(session.snapshot); },
    listeners: () => listeners.size,
    async setDraft(text) { log.push(`${name}.setDraft:${text}`); if (draftError) throw draftError; },
    async close() { log.push(`${name}.close`); session.closed = true; if (closeError) throw closeError; },
    async stop() { log.push(`${name}.stop`); }
  };
  for (const method of S.methods) if (!(method in session)) session[method] = (...args) => { log.push(`${name}.${method}`); return { name, method, args }; };
  return session;
}

function fixture({ hostInfo = { foreground: true, capabilities: { backgroundReplies: true } }, plans = [], options = {}, start = true } = {}) {
  const log = [], errors = [], openErrors = [], stopped = [], reloading = [], seen = [];
  const bridgeListeners = [];
  const bridge = {
    subscribe(listener) { bridgeListeners.push(listener); return () => {}; },
    async call(method, params) { log.push(`bridge:${method}${params ? ':' + JSON.stringify(params) : ''}`); return {}; }
  };
  const emit = (event) => { for (const listener of bridgeListeners) listener(event); };
  const opened = [];
  const state = { draft: 'unsent words', refusal: undefined, blocked: false };
  const closer = createSessionCloser((session) => session.setDraft(state.draft));
  const sessions = createAgentSessions({
    async open({ wanted }) {
      const session = fakeSession(`s${opened.length + 1}`, log, plans[opened.length]);
      opened.push(session);
      log.push(`open:${session.name}`);
      if (!wanted()) { await session.close(); return undefined; }
      return session;
    },
    closer, bridge, hostInfo,
    blocked: () => state.blocked,
    reloadRefusal: () => state.refusal,
    onReloading: (value) => { reloading.push(value); state.blocked = value; },
    onOpenError: (cause) => openErrors.push(cause),
    onStopped: (session) => stopped.push(session.name),
    reportError: (cause) => errors.push(cause),
    reload: () => log.push('reload'),
    ...options
  });
  sessions.onSession((session, details) => seen.push(session ? `open:${session.name}` : `closed:${details.previous.name}:${details.reason}`));
  const started = start ? sessions.start() : Promise.resolve();
  return { sessions, log, errors, openErrors, stopped, reloading, seen, opened, emit, state, started, closer };
}

test('start opens once in the foreground; host.info foreground:false waits for the lifecycle event', async () => {
  const f = fixture();
  await f.started;
  assert.equal(f.sessions.current(), f.opened[0]);
  assert.deepEqual(f.seen, ['open:s1']);
  const background = fixture({ hostInfo: { foreground: false } });
  await background.started;
  assert.equal(background.sessions.current(), null);
  assert.equal(background.opened.length, 0);
  background.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(background.sessions.current(), background.opened[0]);
  // A lifecycle event seen before host.info wins over host.info's foreground flag.
  const early = fixture({ hostInfo: undefined, start: false });
  early.emit({ event: 'host.lifecycle', foreground: false });
  await early.sessions.start({ hostInfo: { foreground: true } });
  assert.equal(early.sessions.foreground, false);
  assert.equal(early.opened.length, 0);
});

test('background closes the session after its draft is saved; foreground reopens a new one', async () => {
  const f = fixture();
  await f.started;
  const first = f.opened[0];
  f.log.length = 0;
  f.emit({ event: 'host.lifecycle', foreground: false });
  assert.equal(f.sessions.current(), null, 'the session is detached at once');
  assert.equal(f.sessions.foreground, false);
  await flush();
  assert.deepEqual(f.log, ['s1.setDraft:unsent words', 's1.close'], 'draft saved, then closed');
  assert.ok(first.closed);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:background']);
  assert.equal(first.listeners(), 0, 'the facade unsubscribed from the closed session');
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(f.sessions.current(), f.opened[1]);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:background', 'open:s2']);
  assert.deepEqual(f.errors, []);
});

test('reopenWhenIdle (E1): idle reopens in place via the save-close path, no page reload; repeated requests collapse', async () => {
  const f = fixture();
  await f.started;
  f.log.length = 0;
  const first = f.opened[0];
  const a = f.sessions.reopenWhenIdle('execution');
  const b = f.sessions.reopenWhenIdle('execution');
  await Promise.all([a, b]);
  await flush();
  assert.deepEqual(f.log.filter((l) => !l.startsWith('bridge:')), ['s1.setDraft:unsent words', 's1.close', 'open:s2'], 'draft saved, closed, opened again once');
  assert.ok(first.closed);
  assert.equal(f.sessions.current(), f.opened[1]);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:execution', 'open:s2']);
  assert.ok(!f.log.includes('reload'), 'the page is not reloaded');
  assert.equal(f.sessions.reopenPending, false);
  assert.deepEqual(f.errors, []);
});

test('reopenWhenIdle (E1): waits while a reply or any conversation works, then reopens once idle', async () => {
  const f = fixture({ plans: [{ busy: true, anyBusy: true }] });
  await f.started;
  const first = f.opened[0];
  f.log.length = 0;
  assert.equal(await f.sessions.reopenWhenIdle('execution'), false, 'deferred while busy');
  assert.equal(f.sessions.reopenPending, true);
  assert.equal(first.closed, false);
  first.emit({ busy: false, anyBusy: true });          // the reply ended, a subagent still works
  await flush();
  assert.equal(first.closed, false, 'still waits for background work');
  first.emit({ busy: false, anyBusy: false });
  await flush();
  assert.ok(first.closed, 'reopened once everything is idle');
  assert.equal(f.sessions.current(), f.opened[1]);
  assert.equal(f.sessions.reopenPending, false);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:execution', 'open:s2']);
});

test('reopenWhenIdle (E1): a background close + foreground open satisfies it (no second reopen); nothing open = nothing to do', async () => {
  const f = fixture({ plans: [{ busy: true }] });
  await f.started;
  void f.sessions.reopenWhenIdle('execution');           // deferred: busy
  f.emit({ event: 'host.lifecycle', foreground: false });
  await flush();
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(f.opened.length, 2, 'the foreground open already uses the current choice');
  assert.equal(f.sessions.current(), f.opened[1]);
  assert.equal(f.sessions.reopenPending, false);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:background', 'open:s2']);
  // While the page reloads (app update / reloadNow) a reopen never runs.
  f.state.blocked = true;
  assert.equal(await f.sessions.reopenWhenIdle('execution'), false);
  assert.equal(f.opened[1].closed, false);
});

test('a session that finished opening after the app went to the background is closed, not installed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = [];
  const sessions = createAgentSessions({
    open: async () => { await gate; return fakeSession('late', log); },
    closer: createSessionCloser((session) => session.setDraft('x')),
    hostInfo: { foreground: true }
  });
  const bridgeListeners = [];
  sessions.connect({ bridge: { subscribe: (listener) => bridgeListeners.push(listener), call: async () => {} } });
  const started = sessions.start();
  await flush(1); // the open is in flight
  for (const listener of bridgeListeners) listener({ event: 'host.lifecycle', foreground: false });
  release();
  await started;
  assert.equal(sessions.current(), null);
  assert.deepEqual(log, ['late.close'], 'closed directly, without saving a draft it never showed');
});

test('a failed background close blocks reopening (assertCanOpen), as before', async () => {
  const failure = new Error('storage would not close');
  const f = fixture({ plans: [{ closeError: failure }] });
  await f.started;
  f.emit({ event: 'host.lifecycle', foreground: false });
  await flush();
  assert.deepEqual(f.errors, [failure], 'the close failure is reported');
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(f.opened.length, 1, 'no second session opened');
  assert.equal(f.sessions.current(), null);
  assert.deepEqual(f.openErrors, [failure], 'opening reports the earlier close failure');
  // A failed draft save still closes the session, and does not block reopening.
  const draftFailure = new Error('draft not saved');
  const g = fixture({ plans: [{ draftError: draftFailure }] });
  await g.started;
  g.emit({ event: 'host.lifecycle', foreground: false });
  await flush();
  assert.ok(g.opened[0].closed);
  assert.deepEqual(g.errors, [draftFailure]);
  g.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(g.sessions.current(), g.opened[1]);
});

test('facade.subscribe follows the current session across reopen; onSession reports open/close', async () => {
  const f = fixture({ start: false });
  const received = [];
  const unsubscribe = f.sessions.facade.subscribe((snapshot) => received.push(snapshot.tag ?? 'initial'));
  await f.sessions.start();
  const [first] = f.opened;
  first.emit({ tag: 'first-change' });
  f.emit({ event: 'host.lifecycle', foreground: false });
  first.emit({ tag: 'after-close' });
  await flush();
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  f.opened[1].emit({ tag: 'second-change' });
  assert.deepEqual(received, ['initial', 'first-change', 'initial', 'second-change']);
  unsubscribe();
  f.opened[1].emit({ tag: 'ignored' });
  assert.equal(received.length, 4);
  // A late subscriber gets the open session's snapshot at once, like session.subscribe.
  let late;
  f.sessions.facade.subscribe((snapshot) => { late = snapshot; });
  assert.equal(late, f.opened[1].snapshot);
  // A throwing listener is reported and does not break the lifecycle.
  const broken = new Error('listener broke');
  f.sessions.facade.onSession(() => { throw broken; });
  f.emit({ event: 'host.lifecycle', foreground: false });
  await flush();
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(f.sessions.current(), f.opened[2]);
  assert.ok(f.errors.includes(broken));
});

test('the facade is exactly agent.sessions@1; methods forward while open and throw the not-open text otherwise', async () => {
  const f = fixture({ start: false });
  const { facade } = f.sessions;
  assert.ok(Object.isFrozen(facade));
  assert.deepEqual(Object.keys(facade).sort(), [...new Set([...S.facade, ...S.getters, ...S.methods])].sort());
  assert.equal(typeof Object.getOwnPropertyDescriptor(facade, 'snapshot').get, 'function');
  for (const name of ['close', 'workspace', 'toolchain', 'closeForReload', 'reloadNow', 'reconcile', 'start', 'connect']) assert.equal(facade[name], undefined, `${name} is not part of agent.sessions@1`);
  assert.equal(facade.current(), null);
  assert.equal(facade.snapshot, undefined);
  for (const method of S.methods.filter((name) => name !== 'subscribe')) assert.throws(() => facade[method](), { message: SESSION_NOT_OPEN_MESSAGE }, method);
  await f.sessions.start();
  const result = facade.send('hello', { mode: 'offline' }, 1);
  assert.deepEqual(result, { name: 's1', method: 'send', args: ['hello', { mode: 'offline' }, 1] }, 'arguments are passed through unchanged');
  assert.deepEqual(facade.sendTo(7, 'hi').args, [7, 'hi'], 'omitted arguments stay omitted (session defaults apply)');
  assert.equal(facade.snapshot, f.opened[0].snapshot);
  assert.equal(facade.current(), f.opened[0]);
});

test('agent.stopped stops a busy current session; host.keepAlive follows anyBusy (once per change)', async () => {
  const f = fixture({ plans: [{ busy: true, anyBusy: true }] });
  await f.started;
  await flush();
  assert.ok(f.log.includes('bridge:host.keepAlive:{"busy":true}'));
  f.emit({ event: 'agent.stopped' });
  await flush();
  assert.ok(f.log.includes('s1.stop'));
  assert.deepEqual(f.stopped, ['s1']);
  f.opened[0].emit({ busy: false, anyBusy: true });
  f.opened[0].emit({ anyBusy: false });
  f.opened[0].emit({ anyBusy: false });
  assert.deepEqual(f.log.filter((line) => line.startsWith('bridge:host.keepAlive')), ['bridge:host.keepAlive:{"busy":true}', 'bridge:host.keepAlive:{"busy":false}']);
  f.emit({ event: 'agent.stopped' });
  await flush();
  assert.equal(f.log.filter((line) => line === 's1.stop').length, 1, 'an idle session is not stopped');
  // Without backgroundReplies no keepAlive call is made.
  const quiet = fixture({ hostInfo: { foreground: true, capabilities: {} }, plans: [{ anyBusy: true }] });
  await quiet.started;
  assert.ok(!quiet.log.some((line) => line.startsWith('bridge:host.keepAlive')));
});

// --- App update activation chain (AGENTS.md): applyQueued -> activate -> closeSession awaited -> app.activate -> reload.
function fakeDom(log) {
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { id, hidden: true, disabled: false, open: false, textContent: '', addEventListener() {} });
      return elements.get(id);
    }
  };
  globalThis.window = { location: { reload: () => log.push('location.reload') } };
  return () => { delete globalThis.document; delete globalThis.window; };
}
function withRevisions(f, { unavailable = () => false } = {}) {
  const bridge = { call: async (method, params) => { f.log.push(`bridge:${method}${params ? ':' + JSON.stringify(params) : ''}`); return method === 'app.info' ? { revision: 'bundled', hostVersion: '0', sourcePath: '/src' } : {}; } };
  const applying = [];
  const reported = [];
  const revisions = createAppRevisions({
    bridge,
    getSession: () => f.sessions.current(),
    unavailable: () => unavailable() || f.sessions.reloading,
    setApplying(value) { applying.push(value); f.state.blocked = value; },
    async closeSession(current) { await f.sessions.closeForReload(current); },
    reopen: () => f.sessions.reconcile(),
    reportError: (cause) => reported.push(cause)
  });
  return { revisions, applying, reported };
}

test('app update: closeSession saves the draft and awaits the close before app.activate and reload', async () => {
  const f = fixture();
  const restore = fakeDom(f.log);
  try {
    await f.started;
    f.log.length = 0;
    const { revisions, applying } = withRevisions(f);
    const [first] = f.opened;
    revisions.queue(first, 'rev-1');
    assert.equal(revisions.pending(), true);
    await revisions.applyQueued(first);
    const chain = f.log.filter((line) => /setDraft|close$|app\.activate|location\.reload/.test(line));
    assert.deepEqual(chain, ['s1.setDraft:unsent words', 's1.close', 'bridge:app.activate:{"revision":"rev-1"}', 'location.reload']);
    assert.deepEqual(applying, [true]);
    assert.deepEqual(f.seen, ['open:s1', 'closed:s1:reload']);
    assert.equal(f.sessions.current(), null);
    f.sessions.reconcile();
    await flush();
    assert.equal(f.opened.length, 1, 'nothing reopens while the page reloads');
  } finally { restore(); }
});

test('app update: a failed close never activates; it reopens through reconcile, and assertCanOpen reports it', async () => {
  const failure = new Error('close failed');
  const f = fixture({ plans: [{ closeError: failure }] });
  const restore = fakeDom(f.log);
  try {
    await f.started;
    const { revisions, applying, reported } = withRevisions(f);
    revisions.queue(f.opened[0], 'rev-2');
    await revisions.applyQueued(f.opened[0]);
    await flush();
    assert.ok(!f.log.some((line) => line.includes('app.activate')));
    assert.ok(!f.log.includes('location.reload'));
    assert.deepEqual(applying, [true, false]);
    assert.deepEqual(reported, [failure]);
    assert.deepEqual(f.openErrors, [failure], 'the reopen is refused by assertCanOpen');
    // closeForReload refuses a session that is no longer current.
    await assert.rejects(f.sessions.closeForReload(f.opened[0]), /conversation changed before the app update/);
  } finally { restore(); }
});

// --- reloadNow (§F.3)
test('reloadNow: saves the draft, closes through closeForReload, then reloads', async () => {
  const f = fixture();
  await f.started;
  f.log.length = 0;
  await f.sessions.reloadNow();
  assert.deepEqual(f.log, ['s1.setDraft:unsent words', 's1.close', 'reload']);
  assert.deepEqual(f.reloading, [true]);
  assert.deepEqual(f.seen, ['open:s1', 'closed:s1:reload']);
  assert.equal(f.sessions.reloading, true);
  await assert.rejects(f.sessions.reloadNow(), /already reloading/);
  f.sessions.reconcile();
  await flush();
  assert.equal(f.opened.length, 1, 'nothing reopens while the page reloads');
});

test('reloadNow refusals: app update queued or activating, sign-in, background; a refusal changes nothing', async () => {
  const f = fixture();
  await f.started;
  f.log.length = 0;
  f.state.refusal = 'An app update is waiting to be applied.';
  await assert.rejects(f.sessions.reloadNow(), /app update is waiting/);
  f.state.refusal = 'Finish signing in first.';
  await assert.rejects(f.sessions.reloadNow(), /Finish signing in first/);
  f.state.refusal = undefined;
  f.state.blocked = true; // app.js appReloading: an app update is activating
  await assert.rejects(f.sessions.reloadNow(), /already reloading/);
  f.state.blocked = false;
  f.emit({ event: 'host.lifecycle', foreground: false });
  await flush();
  f.log.length = 0;
  await assert.rejects(f.sessions.reloadNow(), /Return to the app/);
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.reloading, []);
  f.emit({ event: 'host.lifecycle', foreground: true });
  await flush();
  assert.equal(f.sessions.current(), f.opened[1]);
  const notStarted = fixture({ start: false });
  await assert.rejects(notStarted.sessions.reloadNow(), /Return to the app/);
});

test('reloadNow: an app update queued while an open settles refuses late and reopens; a failed close reports and blocks reopen', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ start: false });
  const log = f.log;
  const slow = createAgentSessions({
    open: async () => { await gate; const session = fakeSession('slow', log); f.opened.push(session); return session; },
    closer: createSessionCloser((session) => session.setDraft('d')),
    hostInfo: { foreground: true },
    blocked: () => f.state.blocked,
    reloadRefusal: () => f.state.refusal,
    onReloading: (value) => { f.reloading.push(value); f.state.blocked = value; },
    reload: () => log.push('reload')
  });
  void slow.start(); // the open is still in flight
  const reloading = slow.reloadNow();
  f.state.refusal = 'An app update is waiting to be applied.'; // queued while the open was in flight
  release();
  await assert.rejects(reloading, /app update is waiting/);
  assert.deepEqual(f.reloading, [true, false]);
  assert.equal(slow.reloading, false);
  assert.equal(slow.current(), f.opened[0], 'the session stays open');
  assert.ok(!log.includes('reload'));
  // Close failure: reloadNow rejects, the page stays, reopen is refused like after an app update.
  const failure = new Error('close failed');
  const g = fixture({ plans: [{ closeError: failure }] });
  await g.started;
  await assert.rejects(g.sessions.reloadNow(), (cause) => cause === failure);
  await flush();
  assert.ok(!g.log.includes('reload'));
  assert.deepEqual(g.reloading, [true, false]);
  assert.deepEqual(g.openErrors, [failure]);
});

test('while reloadNow runs an app update cannot activate (revisions unavailable)', async () => {
  const f = fixture();
  const restore = fakeDom(f.log);
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await f.started;
    const { revisions } = withRevisions(f);
    // Hold the draft save so reloadNow is mid-close.
    f.opened[0].setDraft = async (text) => { f.log.push(`s1.setDraft:${text}`); await gate; };
    const reloading = f.sessions.reloadNow();
    assert.equal(f.sessions.reloading, true);
    revisions.queue(f.opened[0], 'rev-3');
    await revisions.applyQueued(f.opened[0]);
    assert.ok(!f.log.some((line) => line.includes('app.activate')), 'no activation during reloadNow');
    release();
    await reloading;
    assert.ok(f.log.includes('reload'));
  } finally { restore(); }
});

// --- core-agent built-in
test('core-agent: essential page built-in that provides the page facade as agent.sessions@1', async () => {
  const f = fixture({ start: false });
  assert.equal(pageAgentSessions(), undefined);
  const plain = createBuiltinPlugins({ openExecution() {} }).map((definition) => definition.id);
  assert.ok(!plain.includes('core-agent'), 'without a page facade (tests, forks) core-agent is left out');
  const definition = createBuiltinPlugins({ openExecution() {}, sessions: f.sessions.facade }).find((item) => item.id === 'core-agent');
  assert.equal(definition.essential, true);
  assert.equal(definition.reload, 'page');
  assert.deepEqual(definition.provides, [{ id: 'agent.sessions', version: 1 }]);
  // Default: the facade the page registered (app.js setPageAgentSessions).
  setPageAgentSessions(f.sessions);
  assert.equal(pageAgentSessions(), f.sessions.facade);
  const definitions = createBuiltinPlugins({ openExecution() {}, agentTools: { hostInfo: { capabilities: { executionEnv: true } } } });
  const ids = definitions.map((item) => item.id);
  assert.ok(ids.indexOf('core-agent') < ids.indexOf('core-prompt'), 'before the agent tool rows (their order tests stay unchanged)');
  const runtime = createPluginRuntime();
  for (const item of createBuiltinPlugins({ openExecution() {} })) runtime.register(item);
  await runtime.start();
  assert.equal(runtime.service('agent.sessions', 1), f.sessions.facade);
  assert.equal(runtime.list().find((record) => record.id === 'core-agent').essential, true);
  await f.sessions.start();
  assert.equal(runtime.service('agent.sessions', 1).current(), f.opened[0], 'the service follows the page session');
  await runtime.close();
  assert.equal(f.sessions.current(), f.opened[0], 'stopping composition never closes the session');
  setPageAgentSessions(undefined);
  assert.throws(() => createBuiltinPlugins({ openExecution() {}, sessions: {} }), /agent.sessions@1 facade/);
});

// --- app.js wiring (static: app.js needs a DOM and a host)
const code = async (name) => (await readFile(`${root}apps/common/${name}`, 'utf8')).replace(/(^|[^:])\/\/.*$/gm, '$1');
test('app.js: lifecycle lives in agent-sessions.js; reloadNow is wired to Settings → Plugins; activation chain kept', async () => {
  const app = await code('app.js');
  const lifecycle = await code('agent-sessions.js');
  assert.doesNotMatch(app, /\bvar session\b|\blet session\b|[^.\w]session\s*=[^=]/, 'no page `session` variable');
  assert.doesNotMatch(app.replace(/from "\.\/session\.js"/, ''), /(^|[^.\w"])session\b(?!s)/m, 'every use goes through sessions.current()');
  for (const event of ['host.lifecycle', 'agent.stopped', 'host.keepAlive']) {
    assert.ok(!app.includes(`"${event}"`), `app.js no longer handles ${event}`);
    assert.ok(lifecycle.includes(`"${event}"`), `agent-sessions.js handles ${event}`);
  }
  assert.match(app, /createAgentSessions\(\{[\s\S]*?closer: sessionCloser/);
  assert.match(app, /setPageAgentSessions\(sessions\)/);
  // reloadNow reaches plugin-settings both at init and at connect.
  assert.match(app, /initPluginSettings\(\{[\s\S]*?reloadNow: \(\) => sessions\.reloadNow\(\)/);
  assert.match(app, /pluginSettings\.connect\(\{[^}]*reloadNow: \(\) => sessions\.reloadNow\(\)/);
  const settings = await code('../../plugins/core-plugin-management/web/plugin-settings.js');
  assert.match(settings, /export function initPluginSettings\(\{[^\n]*reloadNow/);
  assert.match(settings, /function connect\(\{[^\n]*reloadNow/);
  // Activation chain: closeSession awaits closeForReload; the finishing re-render and the 1.5 s retry stay.
  assert.match(app, /async closeSession\(current\) \{\s*await sessions\.closeForReload\(current\);\s*\}/);
  assert.match(app, /reopen: \(\) => sessions\.reconcile\(\)/);
  assert.match(app, /if \(!queuedBefore && revisions\?\.pending\(\) && sessions\.current\(\)\) render\(sessions\.current\(\)\.snapshot\);/);
  assert.match(app, /setInterval\(\(\) => \{\s*if \(revisions\.pending\(\) && sessions\.current\(\) && !applyingQueued\) render\(sessions\.current\(\)\.snapshot\);\s*\}, 1500\)/);
  assert.match(app, /Promise\.resolve\(revisions\.applyQueued\(sessions\.current\(\)\)\)/);
  // The facade is created before composition starts (it is registered for core-agent).
  assert.ok(app.indexOf('setPageAgentSessions(sessions)') < app.indexOf('startPluginComposition'));
  // agent-sessions.js stays light: only the contract module is imported.
  assert.deepEqual([...lifecycle.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]), ['./agent-contracts.js']);
});
