import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';

// Drawer index timing (docs/plugins-ui-editions.md "Drawer index"): a tree of 30 conversations
// (main, 27 threads, 2 forks) in phone-like storage (one FIFO, 10 ms per call), reopened so nothing
// is cached. Reference at a7d28e7 with the same storage: the first tree() took 119 storage calls
// (about 1.3 s) and every 2 s refresh 59 calls (about 0.65 s). The index shows its first list from
// a handful of calls and refreshes from commit events without reading storage.
// Mocked storage timing in Node: NOT on-device measurement.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, session;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  session = await app.load('session.js');
});
after(async () => { await app?.remove(); });

function phoneStorage() {
  const inner = new pd.MemoryStorage();
  const state = { cost: 0, calls: 0 };
  let tail = Promise.resolve();
  const storage = new Proxy(inner, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'close') return async () => {};
    return (...args) => {
      state.calls++;
      const result = tail.then(async () => {
        if (state.cost) await new Promise((resolve) => setTimeout(resolve, state.cost));
        return value.apply(target, args);
      });
      tail = result.catch(() => {});
      return result;
    };
  } });
  return { storage, state };
}

test('30 conversations: first list and refresh well under the rescan cost', { skip, timeout: 120000 }, async () => {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const phone = phoneStorage();
  let opened = await session.openAppSession({ storage: phone.storage, toolchain: false, demoTokensPerSecond: 0, ...options });
  try {
    await opened.send('Hello.', { mode: 'offline' });
    await until(() => !opened.snapshot.busy && opened.snapshot.messages.length >= 2, 'no reply', 20000);
    await opened.forkThread();
    await opened.switchConversation(pd.ROOT_CONVERSATION_ID);
    await opened.forkThread();
    for (let i = 0; i < 27; i++) await opened.newThread();
    await opened.close();
    opened = await session.openAppSession({ storage: phone.storage, toolchain: false, demoTokensPerSecond: 0, ...options });
    phone.state.cost = 10;

    // First render: the cheap list (ids, parents, kinds, titles), before any per-row detail.
    const lists = [];
    let calls = phone.state.calls;
    let started = Date.now();
    const unwatch = opened.watchTree((nodes) => { if (nodes) lists.push({ nodes, at: Date.now(), calls: phone.state.calls }); });
    await until(() => lists.length > 0, 'no first list', 10000);
    const first = { ms: lists[0].at - started, calls: lists[0].calls - calls };
    assert.equal(lists[0].nodes.length, 30);
    assert.deepEqual(lists[0].nodes.filter((node) => node.kind === 'fork').length, 2);
    assert.ok(first.calls <= 12, `first list from ${first.calls} storage calls (was 119)`);
    assert.ok(first.ms < 400, `first list after ${first.ms} ms (was about 1300)`);

    // Details fill once, lazily; afterwards tree() answers from memory.
    await opened.tree();
    calls = phone.state.calls;
    started = Date.now();
    const again = await opened.tree();
    assert.equal(again.length, 30);
    assert.equal(phone.state.calls - calls, 0, 'tree() after the details reads no storage');
    assert.ok(Date.now() - started < 50);

    // Refresh: a rename is one commit; the new title arrives from it, with no rescan.
    const target = again.find((node) => node.kind === 'thread');
    const seen = lists.length;
    await opened.renameConversation(target.id, 'Renamed');
    calls = phone.state.calls;
    started = Date.now();
    await until(() => lists.slice(seen).some((list) => list.nodes.find((node) => node.id === target.id)?.title === 'Renamed'), 'rename not published', 5000);
    const refresh = { ms: Date.now() - started, calls: phone.state.calls - calls };
    assert.equal(refresh.calls, 0, 'refresh read no storage');
    assert.ok(refresh.ms < 200, `refresh after ${refresh.ms} ms (was about 650 every 2 s)`);
    // A new conversation is listed from its creation commit, in order (oldest first).
    const before = lists.length;
    await opened.newThread();
    await until(() => lists.slice(before).some((list) => list.nodes.length === 31), 'new conversation not published', 5000);
    const last = lists.at(-1).nodes;
    assert.equal(last.at(-1).id, Math.max(...last.map((node) => node.id)), 'newest last');

    // Nothing happens: no storage traffic at all (after the engine's own activity check that
    // follows a conversation switch, 200 ms later).
    await new Promise((resolve) => setTimeout(resolve, 800));
    calls = phone.state.calls;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(phone.state.calls - calls, 0, 'no storage calls while idle');
    unwatch();
    console.log(`# first list ${first.ms} ms / ${first.calls} calls; refresh ${refresh.ms} ms / ${refresh.calls} calls`);
  } finally {
    phone.state.cost = 0;
    await opened.close();
    globalThis.__piHostInfo = saved;
  }
});
