import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';

// Step C3d: core-agent's setup opens the page's sessions (plugins/core-agent/web/open-sessions.js);
// app.js uses the bundled core-agent copy when composition is unavailable. Real session.js
// (offline demo model, memory storage), real runtime, real app-revisions chain. No device.
const root = new URL('../', import.meta.url);
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';

let app, pd, lifecycle, revisionsModule, builtins, runtimeModule, registry;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  lifecycle = await app.load('agent-sessions.js');
  revisionsModule = await app.load('app-revisions.js');
  builtins = await app.load('plugin-builtins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  registry = await app.load('builtin-plugins.js');
});
after(async () => { await app?.remove(); lifecycle?.setPageAgentSessions(undefined); });

// What app.js does before composition: controller without an opener, registered, session options given.
function page({ blocked = () => false, draft = () => 'unsent words' } = {}) {
  const storage = new (class extends pd.MemoryStorage { async close() {} })();
  const errors = [];
  const opened = [];
  const sessions = lifecycle.createAgentSessions({
    closer: revisionsModule.createSessionCloser((session) => session.setDraft(draft())),
    hostInfo: { foreground: true, capabilities: {} },
    blocked,
    reportError: (cause) => errors.push(cause),
    onOpenError: (cause) => errors.push(cause)
  });
  lifecycle.setPageAgentSessions(sessions);
  sessions.connect({ hostInfo: { foreground: true, capabilities: {} }, sessionOptions: {
    extra: { storage, toolchain: false, demoTokensPerSecond: 0 },
    onOpened: (session) => opened.push(session)
  } });
  return { sessions, storage, errors, opened };
}
async function compose(options = {}) {
  const runtime = runtimeModule.createPluginRuntime();
  for (const definition of builtins.createBuiltinPlugins({ openExecution() {}, ...options })) runtime.register(definition);
  await runtime.start();
  return runtime;
}

test('normal path: core-agent setup opens the session; app.js only mounts on agent.sessions@1', { skip }, async () => {
  const p = page();
  try {
    assert.equal(p.sessions.startedBy, undefined, 'nothing opens before core-agent');
    assert.equal(p.sessions.current(), null);
    const runtime = await compose();
    assert.equal(p.sessions.startedBy, 'core-agent');
    await p.sessions.begun;
    const service = runtime.service('agent.sessions', 1);
    assert.equal(service, p.sessions.facade);
    assert.equal(service.current(), p.opened[0]);
    await service.send('Hello');
    await until(() => !service.snapshot.busy && service.snapshot.messages.at(-1)?.role === 'assistant', 'offline reply did not finish');
    // The bundled copy (app.js fallback after composition) changes nothing now.
    assert.equal(registry.builtinPlugin('core-agent').entry.openSessions(p.sessions, 'bundled'), false);
    assert.equal(p.sessions.startedBy, 'core-agent');
    // Restarting the plugin never opens a second session; stopping composition never closes it.
    await runtime.close();
    assert.equal(p.sessions.current(), p.opened[0]);
    assert.equal(p.opened.length, 1);
    assert.deepEqual(p.errors, []);
    await p.sessions.closeForReload(p.sessions.current());
  } finally { lifecycle.setPageAgentSessions(undefined); }
});

test('composition failure: the bundled core-agent copy opens the conversation', { skip }, async () => {
  // (a) no runtime at all (plugin-bootstrap failed to load or start).
  const p = page();
  try {
    assert.equal(registry.builtinPlugin('core-agent').entry.openSessions(p.sessions, 'bundled'), true);
    await p.sessions.begun;
    assert.equal(p.sessions.startedBy, 'bundled');
    assert.ok(p.sessions.current(), 'a conversation is open');
    assert.equal(p.sessions.current().snapshot.conversation.isMain, true);
    await p.sessions.closeForReload(p.sessions.current());
  } finally { lifecycle.setPageAgentSessions(undefined); }
  // (b) core-agent's setup fails: composition completes without starting the lifecycle.
  const q = page();
  try {
    const broken = { get sessionOptions() { return q.sessions.sessionOptions; }, begin() { throw new Error('core-agent broke'); } };
    const runtime = await compose({ sessions: q.sessions.facade, harness: q.sessions.harness, lifecycle: broken });
    assert.notEqual(runtime.list().find((record) => record.id === 'core-agent').state, 'active');
    assert.equal(q.sessions.startedBy, undefined);
    assert.equal(registry.builtinPlugin('core-agent').entry.openSessions(q.sessions, 'bundled'), true);
    await q.sessions.begun;
    assert.ok(q.sessions.current(), 'the bundled copy opened the conversation');
    await runtime.close();
    await q.sessions.closeForReload(q.sessions.current());
  } finally { lifecycle.setPageAgentSessions(undefined); }
  // Without session options the bundled copy refuses (app.js shows "Could not open your conversation").
  const bare = lifecycle.createAgentSessions({ closer: revisionsModule.createSessionCloser(() => {}) });
  assert.throws(() => registry.builtinPlugin('core-agent').entry.openSessions(bare, 'bundled'), /session options/);
});

test('app update: apply awaits real closure of the core-agent session before activate and reload', { skip }, async () => {
  const log = [];
  globalThis.document = { getElementById: () => ({ hidden: true, disabled: false, textContent: '', addEventListener() {} }) };
  globalThis.window = { location: { reload: () => log.push('location.reload') } };
  let applying = false;
  const p = page({ blocked: () => applying, draft: () => 'kept for after the update' });
  try {
    await compose();
    await p.sessions.begun;
    const current = p.sessions.current();
    const close = current.close.bind(current);
    current.close = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); await close(); log.push('session.close'); };
    const revisions = revisionsModule.createAppRevisions({
      bridge: { call: async (method, params) => { log.push(`${method}:${params?.revision ?? ''}`); return {}; } },
      getSession: () => p.sessions.current(),
      unavailable: () => false,
      setApplying: (value) => { applying = value; },
      closeSession: async (expected) => { await p.sessions.closeForReload(expected); },
      reopen: () => p.sessions.reconcile(),
      reportError: (cause) => p.errors.push(cause)
    });
    revisions.queue(current, 'rev-c3d');
    await revisions.applyQueued(current);
    assert.deepEqual(log, ['session.close', 'app.activate:rev-c3d', 'location.reload']);
    assert.equal(p.sessions.current(), null, 'nothing reopens while the page reloads');
    const next = await (await app.load('session.js')).openAppSession({ storage: p.storage, toolchain: false, demoTokensPerSecond: 0 });
    assert.equal(next.snapshot.conversation.draft, 'kept for after the update');
    await next.close();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    lifecycle.setPageAgentSessions(undefined);
  }
});

// app.js wiring (static: app.js needs a DOM and a host).
test('app.js: no openAppSession; session options given before composition; bundled fallback on failure and deadline', async () => {
  const code = (await readFile(new URL('apps/common/app.js', root), 'utf8')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /openAppSession/);
  assert.doesNotMatch(code, /sessions\.start\(/);
  assert.ok(code.indexOf('sessions.connect({ sessionOptions') < code.indexOf('startPluginComposition'));
  assert.match(code, /builtinPlugin\("core-agent"\)\.entry\.openSessions\(sessions, "bundled"\)/);
  assert.match(code, /setTimeout\(bundledAgent, READY_TIMEOUT_MS\)/);
  assert.match(code, /\.finally\(\(\) => \{\s*clearTimeout\(agentDeadline\);(?:\s*globalThis\.__sfSplash\?\.mark\([^)]*\);[^\n]*)?\s*bundledAgent\(\);\s*\}\)/);
  assert.match(code, /await sessions\.begun;/);
  const entry = await readFile(new URL('plugins/core-agent/web/open-sessions.js', root), 'utf8');
  assert.match(entry, /onStaged: \(revision\) => revisions\?\.queue\(opened, revision\)/);
  assert.doesNotMatch(entry, /^import /m, 'no library import at evaluation');
});
