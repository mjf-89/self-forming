import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';

// Step C1: the page session controller (agent-sessions.js) with the real session.js
// (offline demo model, memory storage that survives close like the native database),
// the real createSessionCloser and the real app-revisions chain. No network or device.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';

let app, pd, sessionModule, lifecycle, revisionsModule, contracts;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  sessionModule = await app.load('session.js');
  lifecycle = await app.load('agent-sessions.js');
  revisionsModule = await app.load('app-revisions.js');
  contracts = await app.load('agent-contracts.js');
});
after(async () => { await app?.remove(); });

function page({ draft = () => 'unsent words', ...options } = {}) {
  const storage = new (class extends pd.MemoryStorage { async close() {} })();
  const listeners = [];
  const log = [];
  const opened = [];
  const errors = [];
  const bridge = { subscribe: (listener) => listeners.push(listener), call: async (method) => { log.push(method); return {}; } };
  const closer = revisionsModule.createSessionCloser((session) => session.setDraft(draft()));
  const sessions = lifecycle.createAgentSessions({
    async open({ wanted }) {
      const session = await sessionModule.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0 });
      if (!wanted()) { await session.close(); return undefined; }
      opened.push(session);
      return session;
    },
    closer, bridge, hostInfo: { foreground: true, capabilities: { backgroundReplies: true } },
    reportError: (cause) => errors.push(cause),
    onOpenError: (cause) => errors.push(cause),
    reload: () => log.push('reload'),
    ...options
  });
  const lifecycleEvent = (foreground) => { for (const listener of listeners) listener({ event: 'host.lifecycle', foreground }); };
  return { sessions, storage, log, opened, errors, lifecycleEvent };
}

test('background saves the draft and closes the real session; foreground reopens it with the draft and history', { skip }, async () => {
  const p = page();
  await p.sessions.start();
  const { facade } = p.sessions;
  const seen = [];
  facade.subscribe((snapshot) => seen.push(snapshot));
  await facade.send('Hello');
  await until(() => !facade.snapshot.busy && facade.snapshot.messages.at(-1)?.role === 'assistant', 'offline reply did not finish');
  const messages = facade.snapshot.messages.length;
  const [first] = p.opened;
  const order = [];
  const setDraft = first.setDraft.bind(first), close = first.close.bind(first);
  first.setDraft = async (text) => { order.push(`draft:${text}`); await setDraft(text); order.push('draft saved'); };
  first.close = async () => { order.push('close'); await close(); order.push('closed'); };
  p.lifecycleEvent(false);
  assert.equal(facade.current(), null);
  assert.throws(() => facade.tree(), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  await until(() => order.includes('closed'), 'the first session did not close');
  assert.deepEqual(order, ['draft:unsent words', 'draft saved', 'close', 'closed']);
  const seenWhileClosed = seen.length;
  p.lifecycleEvent(true);
  await until(() => facade.current() && facade.current() !== first, 'did not reopen');
  const second = facade.current();
  assert.equal(second.snapshot.conversation.draft, 'unsent words', 'the draft was saved before the close');
  await until(() => second.snapshot.messages.length === messages, 'history did not load');
  assert.ok(seen.length > seenWhileClosed, 'subscribe followed the reopened session');
  assert.equal(seen.at(-1), second.snapshot, 'the latest snapshot comes from the reopened session');
  assert.deepEqual(p.errors, []);
  await second.close();
});

test('app update chain with the real session: closeSession awaited (draft saved, storage closed) before app.activate', { skip }, async () => {
  const log = [];
  const elements = new Map();
  globalThis.document = { getElementById: (id) => elements.get(id) ?? elements.set(id, { hidden: true, disabled: false, textContent: '', addEventListener() {} }).get(id) };
  globalThis.window = { location: { reload: () => log.push('location.reload') } };
  try {
    let applying = false;
    const p = page({ blocked: () => applying, draft: () => 'kept for after the update' });
    await p.sessions.start();
    const current = p.sessions.current();
    const closed = [];
    const close = current.close.bind(current);
    current.close = async () => { await close(); closed.push('closed'); log.push('session.close'); };
    const revisions = revisionsModule.createAppRevisions({
      bridge: { call: async (method, params) => { log.push(`${method}:${params?.revision ?? ''}`); return {}; } },
      getSession: () => p.sessions.current(),
      unavailable: () => false,
      setApplying: (value) => { applying = value; },
      closeSession: (expected) => p.sessions.closeForReload(expected),
      reopen: () => p.sessions.reconcile(),
      reportError: (cause) => p.errors.push(cause)
    });
    revisions.queue(current, 'rev-x');
    await revisions.applyQueued(current);
    assert.deepEqual(log, ['session.close', 'app.activate:rev-x', 'location.reload']);
    // Reopen on a fresh page (same storage): the draft is there.
    const next = await sessionModule.openAppSession({ storage: p.storage, toolchain: false, demoTokensPerSecond: 0 });
    assert.equal(next.snapshot.conversation.draft, 'kept for after the update');
    await next.close();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('reloadNow with the real session: draft saved, session closed, then reload; refused while an update waits', { skip }, async () => {
  let refusal = 'An app update is waiting to be applied.';
  const p = page({ reloadRefusal: () => refusal, draft: () => 'before reload' });
  await p.sessions.start();
  const current = p.sessions.current();
  await assert.rejects(p.sessions.reloadNow(), /app update is waiting/);
  assert.equal(p.sessions.current(), current, 'a refusal leaves the session open');
  refusal = undefined;
  await p.sessions.reloadNow();
  assert.ok(p.log.includes('reload'));
  await assert.rejects(current.send('after close'), /./, 'the session is closed');
  const next = await sessionModule.openAppSession({ storage: p.storage, toolchain: false, demoTokensPerSecond: 0 });
  assert.equal(next.snapshot.conversation.draft, 'before reload');
  await next.close();
});
