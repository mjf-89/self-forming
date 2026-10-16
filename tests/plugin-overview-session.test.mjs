import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';

// Real session.js (offline demo model, memory storage, bundled pi-durable): the
// pending-work scan Settings → Plugins runs before disabling a plugin.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, session;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  session = await app.load('session.js');
});
after(async () => { await app?.remove(); });

test('pendingWorkFor counts unfinished tool calls and task kinds of the given extensions only', { skip }, async () => {
  // The offline demo's first step calls workspace_write; this workspace holds it open.
  let release;
  const files = new Map();
  const workspace = {
    async read(path) { if (!files.has(path)) throw new Error('File not found.'); return files.get(path); },
    async write(path, text) { await new Promise((resolve) => { release = resolve; }); files.set(path, text); },
    async list() { return [...files.keys()].map((name) => ({ name, type: 'file' })); }
  };
  const opened = await session.openAppSession({ workspace, demoTokensPerSecond: 0 });
  assert.deepEqual(await opened.pendingWorkFor(['self-forming-workspace']), { tasks: 0, conversations: [], partial: false });
  await opened.send('hello');
  const main = opened.snapshot.conversation.id;
  await until(async () => (await opened.pendingWorkFor(['self-forming-workspace'])).tasks === 1, 'the running workspace_write call was not found');
  assert.deepEqual(await opened.pendingWorkFor(['self-forming-workspace']), { tasks: 1, conversations: [main], partial: false });
  assert.deepEqual(await opened.pendingWorkFor(['plugin-that-is-not-installed']), { tasks: 0, conversations: [], partial: false }, 'unknown extensions: nothing waits');
  assert.deepEqual(await opened.pendingWorkFor(['self-forming-native']), { tasks: 0, conversations: [], partial: false }, 'other extensions\' tools do not count');
  const byKind = await opened.pendingWorkFor([], { tasks: ['pi.generation'] });
  assert.ok(byKind.tasks >= 1 && byKind.conversations.includes(main), `task kinds count: ${JSON.stringify(byKind)}`);
  release();
  await until(() => !opened.snapshot.busy && opened.snapshot.messages.at(-1)?.role === 'assistant', 'reply did not finish');
  await until(async () => (await opened.pendingWorkFor(['self-forming-workspace'])).tasks === 0, 'finished calls still counted');
  await opened.close();
  await assert.rejects(() => opened.pendingWorkFor(['self-forming-workspace']), /closed/);
});
