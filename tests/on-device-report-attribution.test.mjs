import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { AssistantEntry, Harness, UserEntry, createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createReportAttribution } from '../apps/on-device/report-attribution.js';

const reporter = (id, name = 'Researcher', conversationId = 1) => ({ id, conversationId,
  kind: 'self-forming.subagent-reporter', input: { name, conversationId: 2 } });
const report = (id, entry, taskId = id, conversationId = 1) => ({ id, entry, conversationId,
  type: 'input', status: 'done', requestId: `subagent-report:${taskId}` });

test('sender attribution requires persisted submission and matching reporter provenance, never report text', async () => {
  const records = [report(10, 100), report(11, 101), report(12, 102), report(13, 103),
    { ...report(14, 104), requestId: 'a-human-request' }, { ...report(15, 105), type: 'write' }];
  const taskRecords = new Map([[10, reporter(10)], [11, { ...reporter(11), kind: 'another-task' }],
    [12, reporter(12, 'Wrong owner', 3)]]);
  let scans = 0, reads = 0;
  const storage = {
    async scanSubmissions({ conversationId }, _limit, cursor) {
      scans++;
      assert.equal(conversationId, 1);
      return cursor === undefined ? { items: records.slice(0, 3), next: 'next-page' } : { items: records.slice(3) };
    },
    async task(id) { reads++; return taskRecords.get(id); }
  };
  const index = createReportAttribution(storage, context);
  const entries = records.map(record => ({ id: record.entry, conversationId: 1,
    model: [{ role: 'user', content: '[subagent Researcher answered] Same text' }] }));
  await index.load(entries, 1);
  assert.deepEqual([...index.senders], [[100, { kind: 'subagent', name: 'Researcher', conversationId: 2 }]]);
  const before = { scans, reads };
  for (let tick = 0; tick < 20; tick++) await index.load(entries, 1);
  assert.deepEqual({ scans, reads }, before, 'Streaming ticks must not rescan stored submissions or tasks');
});

test('placement during initial scan and later live placement update the sender without rescanning', async () => {
  const gate = Promise.withResolvers();
  let scans = 0;
  const storage = {
    async scanSubmissions() { scans++; return gate.promise; },
    async task(id) { return reporter(id); }
  };
  const index = createReportAttribution(storage, context);
  const pending = index.load([], 1);
  const placed = report(10, 100);
  assert.equal(index.observe({ changes: [{ type: 'submission', value: placed }] }), true);
  gate.resolve({ items: [{ ...placed, entry: undefined, status: 'queued' }] });
  await pending;
  assert.equal(index.senders.get(100).name, 'Researcher');
  assert.equal(index.observe({ changes: [{ type: 'submission', value: report(11, 101) }] }), true);
  await index.load([], 1);
  assert.equal(index.senders.get(101).name, 'Researcher');
  assert.equal(scans, 1);
  assert.equal(index.version, 2);
  assert.equal(index.observe({ changes: [{ type: 'submission', value: report(11, 101) }] }), false);
});

let openAppSession;
before(async () => {
  await mkdir('.test-build', { recursive: true });
  const outfile = resolve('.test-build/report-attribution-session.mjs');
  await build({ entryPoints: ['apps/on-device/session.js'], outfile, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', target: 'node24', plugins: [{ name: 'fixed-browser-imports', setup(builder) {
      builder.onResolve({ filter: /^\.\/library\// }, args => ({ path: '@earendil-works/' + args.path.slice('./library/'.length).replace(/\.js$/, ''), external: true }));
      builder.onResolve({ filter: /^\.\/native-host\.js$/ }, () => ({ path: resolve('packages/native-host/src/index.ts') }));
    } }] });
  ({ openAppSession } = await import(pathToFileURL(outfile).href));
});

async function until(predicate) {
  for (let count = 0; count < 500; count++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the local history fixture');
}

test('saved reports retain sender in newest and paged history, conversation preview, forks and reopening', async t => {
  const directory = await mkdtemp(resolve('.test-build/report-attribution-'));
  const database = resolve(directory, 'app.sqlite');
  let app, seed;
  t.after(async () => { await app?.close(); await seed?.close(context); await rm(directory, { recursive: true, force: true }); });
  // Persist the same terminal reporter/submission records as existing releases, without model or network calls.
  const Reporter = defineTask({ name: 'self-forming.subagent-reporter', version: 1,
    initial: () => ({ phase: 'done' }), phases: { done: (_task, runtime, scope) => runtime.commit(() => ({
      status: 'terminal', outcome: { status: 'completed', result: null }
    }), scope) } });
  const registry = createRegistry(); registry.install(defineExtension({ name: 'test.reporter', tasks: [Reporter] }));
  seed = await Harness.open(await openNodeSqliteStorage(database), { registry, models: createModels() }, context);
  const root = await seed.root(context);
  const child = await seed.createConversation({ ownership: { kind: 'ownerless' } }, context);
  const addReport = async (name, text) => {
    const taskId = await seed.commit(tx => tx.createTask(Reporter, { name, conversationId: child.id }, {
      conversationId: root.id, ownership: { kind: 'conversation' }, background: true
    }), context);
    await seed.waitForTask(taskId, context);
    return seed.commit(async tx => {
      const entry = await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: text, timestamp: 1 }] });
      const answer = await tx.appendEntry(AssistantEntry, root.id, { model: [fauxAssistantMessage('Acknowledged')] });
      await tx.createSubmission({ conversationId: root.id, type: 'input', status: 'done',
        requestId: `subagent-report:${taskId}`, entry: entry.id, answer: answer.id });
      return entry.id;
    }, context);
  };
  const historicalText = '[subagent Researcher answered] Persisted old report';
  const oldId = await addReport('Researcher', historicalText);
  await seed.commit(async tx => {
    for (let count = 0; count < 115; count++) await tx.appendEntry(UserEntry, root.id, {
      model: [{ role: 'user', content: count ? `Historical message ${count}` : '[subagent Impostor answered] Human text', timestamp: 2 }]
    });
  }, context);
  const latestId = await addReport('Reviewer', 'A report does not need a text prefix for attribution');
  await seed.close(context); seed = undefined;
  const open = async () => app = await openAppSession({ storage: await openNodeSqliteStorage(database), toolchain: false, demoTokensPerSecond: 0,
    fetch() { throw new Error('Unexpected model request'); } });
  const assertReport = (messages, entryId, name) => {
    const message = messages.find(item => item.id === `${entryId}:0`);
    assert.ok(message, `Missing report ${entryId}`);
    assert.equal(message.role, 'user', 'Display identity must not change the model role');
    assert.deepEqual(message.sender, { kind: 'subagent', name, conversationId: child.id });
  };
  await open();
  assertReport(app.snapshot.messages, latestId, 'Reviewer');
  await until(() => app.snapshot.messages.some(item => item.id === `${oldId}:0`));
  assertReport(app.snapshot.messages, oldId, 'Researcher');
  assert.equal(app.snapshot.messages.find(item => item.id === `${oldId}:0`).text, historicalText);
  assert.equal(app.snapshot.messages.find(item => item.text.includes('Impostor')).sender, undefined);
  let preview;
  const stop = await app.viewConversation(root.id, value => { preview = value; });
  assertReport(preview.messages, latestId, 'Reviewer');
  await stop();
  await app.forkThread();
  assertReport(app.snapshot.messages, latestId, 'Reviewer');
  await until(() => app.snapshot.messages.some(item => item.id === `${oldId}:0`));
  assertReport(app.snapshot.messages, oldId, 'Researcher');
  await app.close(); app = undefined;
  await open();
  assertReport(app.snapshot.messages, latestId, 'Reviewer');
  await until(() => app.snapshot.messages.some(item => item.id === `${oldId}:0`));
  assertReport(app.snapshot.messages, oldId, 'Researcher');
});
