import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';

// pi-durable 1.2+ (README "Errors", rule 1; CHANGELOG 1.2.0 "Breaking Changes"): a storage error fails the
// Harness, which closes itself, and harness.closed settles {reason: "failed", error}; upstream recovers by
// reopening. The session shows the failure and the page controller (agent-sessions.js sessionFailed)
// closes it and opens a fresh one. Real session.js + bundled pi-durable over memory storage that breaks
// on demand. No device or network.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, session, lifecycle, revisions;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  session = await app.load('session.js');
  lifecycle = await app.load('agent-sessions.js');
  revisions = await app.load('app-revisions.js');
});
after(async () => { lifecycle?.setPageAgentSessions(undefined); await app?.remove(); });

/** Memory storage whose every call throws while `broken` (close excepted), as a failing native database would. */
function breakableStorage() {
  const inner = new pd.MemoryStorage();
  const state = { broken: false };
  const storage = new Proxy(inner, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'close') return async () => {};
    return (...args) => {
      if (state.broken) throw new Error('database is locked (test)');
      return value.apply(target, args);
    };
  } });
  return { storage, state };
}

test('a storage error fails the session: it reports the failure and asks to be reopened (options.onFailed)', { skip }, async () => {
  const { storage, state } = breakableStorage();
  const failed = [];
  const opened = await session.openAppSession({ storage, demoTokensPerSecond: 100000, onFailed: (which, error) => failed.push({ which, error }) });
  state.broken = true;
  await opened.send('hello').catch(() => {});
  await until(() => failed.length === 1, 'the session did not report its failed Harness');
  assert.equal(failed[0].which, opened, 'the failed session is named');
  assert.match(String(failed[0].error?.message ?? failed[0].error), /database is locked/);
  assert.match(opened.snapshot.error, /conversation storage failed .*database is locked.*reopening/);
  await opened.close();
});

test('the page controller closes the failed session and opens a fresh one over the same store', { skip }, async () => {
  const { storage, state } = breakableStorage();
  const sessions = [];
  const errors = [];
  const controller = lifecycle.createAgentSessions({
    open: async () => {
      const opened = await session.openAppSession({ storage, demoTokensPerSecond: 100000 });
      sessions.push(opened);
      return opened;
    },
    closer: revisions.createSessionCloser(() => Promise.resolve()),
    bridge: { subscribe() {}, call: async () => ({}) },
    hostInfo: { foreground: true, capabilities: {} },
    reportError: (error) => errors.push(error)
  });
  lifecycle.setPageAgentSessions(controller);
  const events = [];
  controller.onSession((value, details) => {
    events.push(value ? 'open' : details?.reason);
    // The fault is transient: the store works again by the time the controller reopens.
    if (details?.reason === 'failed') state.broken = false;
  });
  controller.start();
  await controller.begun;
  await until(() => sessions.length === 1 && controller.current() === sessions[0]);
  await sessions[0].send('first').catch(() => {});
  await until(() => !sessions[0].snapshot.busy && sessions[0].snapshot.messages.length >= 2, 'first reply');
  state.broken = true;
  await sessions[0].send('second').catch(() => {});
  await until(() => events.includes('failed'), 'no failed close');
  await until(() => sessions.length === 2 && controller.current() === sessions[1], 'no fresh session');
  assert.deepEqual(events, ['open', 'failed', 'open']);
  // The store is consistent: the reopened session has the first exchange.
  await until(() => sessions[1].snapshot.messages.some((message) => message.role === 'user' && message.text === 'first'), 'history after reopen');
  assert.ok(errors.some((error) => /database is locked/.test(String(error?.message ?? error))), 'the failure is reported');
  await controller.closeForReload(controller.current());
  lifecycle.setPageAgentSessions(undefined);
});
