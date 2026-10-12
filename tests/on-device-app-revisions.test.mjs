import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppRevisions, createSessionCloser } from '../apps/on-device/app-revisions.js';

function fixture(t, { busy = false, close, stageError } = {}) {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const controls = new Map();
  const events = [];
  let current = { snapshot: { busy, anyBusy: busy, paused: busy, owned: busy } };
  let unavailable = false;
  for (const id of ['app-editing', 'app-revision-status', 'app-source-path', 'app-apply', 'app-previous', 'app-original']) {
    const listeners = new Map();
    controls.set(id, { addEventListener(name, callback) { listeners.set(name, callback); },
      click() { listeners.get('click')?.(); } });
  }
  globalThis.document = { getElementById: id => controls.get(id) };
  globalThis.window = { location: { reload() { events.push('reload'); } } };
  t.after(() => {
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
  });
  const revisions = createAppRevisions({
    bridge: { async call(method, params) {
      events.push({ method, params });
      if (method === 'app.info') return { sourcePath: '/workspace/source', revision: 'edited', previousRevision: 'previous', hostVersion: 'test' };
      if (method === 'app.stage') {
        if (stageError) throw stageError;
        return { revision: 'manual' };
      }
    } },
    getSession: () => current,
    unavailable: () => unavailable,
    setApplying: value => events.push({ applying: value }),
    async closeSession(session) {
      assert.equal(session, current);
      events.push('close-start');
      current = undefined;
      await close?.();
      events.push('close-end');
    },
    reportError: error => events.push({ error }),
    reopen: () => events.push('reopen'),
  });
  return { revisions, events, controls,
    get current() { return current; }, set current(value) { current = value; },
    set unavailable(value) { unavailable = value; },
    calls: method => events.filter(event => event?.method === method),
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('committed queued revision activates while viewing a busy child, only after storage closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishClose;
  const closing = new Promise(resolve => { finishClose = resolve; });
  const app = fixture(t, { busy: true, close: () => closing });
  const current = app.current;
  app.revisions.queue(current, 'committed');
  const activation = app.revisions.applyQueued(current);
  assert.ok(app.events.includes('close-start'));
  t.mock.timers.tick(6000);
  await settle();
  assert.equal(app.calls('app.activate').length, 0);
  assert.equal(app.events.includes('reload'), false);
  finishClose();
  await activation;
  assert.equal(app.calls('app.stage').length, 0, 'Use the already committed native snapshot');
  assert.deepEqual(app.calls('app.activate')[0].params, { revision: 'committed' });
  assert.ok(app.events.indexOf('close-end') < app.events.indexOf(app.calls('app.activate')[0]));
  assert.ok(app.events.indexOf(app.calls('app.activate')[0]) < app.events.indexOf('reload'));
  assert.equal(app.revisions.pending(), false);
});

test('queued revision survives UI unavailability, background close, and stale-session attempts', async t => {
  const app = fixture(t, { busy: true });
  const previous = app.current;
  app.revisions.queue(previous, 'committed');
  app.unavailable = true;
  await app.revisions.applyQueued(previous);
  assert.equal(app.revisions.pending(), true);
  assert.equal(app.events.length, 0);
  app.current = undefined;
  app.revisions.sessionClosed();
  app.unavailable = false;
  await app.revisions.applyQueued(previous);
  assert.equal(app.revisions.pending(), true);
  app.current = { snapshot: { busy: true, anyBusy: true } };
  app.revisions.queue(previous, 'stale');
  await app.revisions.applyQueued(previous);
  assert.equal(app.revisions.pending(), true);
  await app.revisions.applyQueued(app.current);
  assert.deepEqual(app.calls('app.activate')[0].params, { revision: 'committed' });
});

test('manual Apply and Restore keep their selected-conversation busy guard', async t => {
  const app = fixture(t, { busy: true });
  await app.revisions.sessionOpened(app.current);
  app.events.length = 0;
  for (const id of ['app-apply', 'app-previous', 'app-original']) {
    assert.equal(app.controls.get(id).disabled, true);
    app.controls.get(id).click();
  }
  await settle();
  assert.deepEqual(app.events, []);
  app.current.snapshot.busy = false;
  app.revisions.controls();
  assert.equal(app.controls.get('app-apply').disabled, false);
  app.controls.get('app-apply').click();
  await settle();
  assert.deepEqual(app.calls('app.activate')[0].params, { revision: 'manual' });
  assert.ok(app.events.indexOf(app.calls('app.stage')[0]) < app.events.indexOf('close-start'));
});

test('failed session close does not activate or reload and invokes recovery', async t => {
  const failure = new Error('storage close failed');
  const app = fixture(t, { busy: true, close: () => { throw failure; } });
  app.revisions.queue(app.current, 'committed');
  await app.revisions.applyQueued(app.current);
  assert.equal(app.calls('app.activate').length, 0);
  assert.equal(app.events.includes('reload'), false);
  assert.ok(app.events.some(event => event?.error === failure));
  assert.ok(app.events.some(event => event?.applying === false));
  assert.ok(app.events.includes('reopen'));
});

test('manual stage failure leaves the current session open', async t => {
  const failure = new Error('stage rejected');
  const app = fixture(t, { stageError: failure });
  const current = app.current;
  app.controls.get('app-apply').click();
  await settle();
  assert.equal(app.current, current);
  assert.equal(app.events.includes('close-start'), false);
  assert.equal(app.calls('app.activate').length, 0);
  assert.ok(app.events.some(event => event?.error === failure));
});

test('draft-save failure remains visible but permits immediate reopening after successful close', async () => {
  const failure = new Error('draft save failed');
  let closed = false;
  let opened = false;
  const closer = createSessionCloser(async () => { throw failure; });
  const closing = closer.close({ async close() { closed = true; } });
  await assert.rejects(closing.result, error => error === failure);
  await closing.settled.then(() => {
    closer.assertCanOpen();
    assert.equal(closed, true);
    opened = true;
  });
  assert.equal(opened, true, 'The first reconciliation must reopen instead of consuming a rejected transition');
});

test('failed close never authorizes another storage owner', async () => {
  const failure = new Error('SQLite close failed');
  const closer = createSessionCloser(async () => {});
  const closing = closer.close({ async close() { throw failure; } });
  await assert.rejects(closing.result, error => error === failure);
  await closing.settled;
  assert.throws(() => closer.assertCanOpen(), error => error === failure);
  assert.throws(() => closer.assertCanOpen(), error => error === failure, 'Later reconciliation cannot ignore an unconfirmed close');
});

test('an earlier transition failure cannot release an ongoing close or permit early reopen', async () => {
  const failure = new Error('earlier transition failed');
  let finishClose;
  const pending = new Promise(resolve => { finishClose = resolve; });
  const closer = createSessionCloser(async () => {});
  const closing = closer.close({ close: () => pending }, Promise.reject(failure));
  const rejected = assert.rejects(closing.result, error => error === failure);
  let settled = false;
  void closing.settled.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false);
  finishClose();
  await rejected;
  await closing.settled;
  closer.assertCanOpen();
});
