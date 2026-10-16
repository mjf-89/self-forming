import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';

// Step C0 (docs/plugins-providers-agent-core.md §B2/§D): the real session.js, opened with
// fake transports (memory storage, the offline demo model, mocked native env/bridge; no
// network, accounts or device), offers exactly agent.sessions@1 (+ the excluded lifecycle
// members) and its snapshot has exactly the contract keys through the offline flows. The
// agent.harness@1 pieces are checked where they are reachable today: the session's real
// pi-durable Harness and Storage, the createSubagentExtensions options and servers@1 connect().
// Normalized flow results: tests/plugin-c0-sessions.snapshot.json (C0_CAPTURE=1 rewrites it).
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const SNAPSHOT_FILE = new URL('./plugin-c0-sessions.snapshot.json', import.meta.url);
const { AGENT_SESSIONS_V1: S, AGENT_HARNESS_V1: H } = await import(new URL('../apps/common/agent-contracts.js', import.meta.url));
const File = globalThis.File ?? (await import('node:buffer')).File;

let app, pd, ai, chord, session;
const probes = {};
before(async () => {
  if (!available) return;
  app = await assembleApp();
  // Instrument the temporary copies only (never the app source): record what the session
  // hands to createSubagentExtensions and to servers@1 connect().
  const patch = async (name, find, replace) => {
    const path = join(app.dir, name);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes(find), `${name}: instrumentation point moved (${find})`);
    await writeFile(path, text.replace(find, replace));
  };
  await patch('builtin/core-subagents/web/subagents.js', 'function createSubagentExtensions({', 'function createSubagentExtensions(__c0Options, __c0Pi) { globalThis.__c0Probes?.subagents?.(__c0Options); return __c0CreateSubagentExtensions(__c0Options, __c0Pi); }\nfunction __c0CreateSubagentExtensions({');
  await patch('builtin/core-servers/web/servers-service.js', 'connect({ harness, env, rootConversationId, context: callContext }) {', 'connect({ harness, env, rootConversationId, context: callContext }) { globalThis.__c0Probes?.servers?.({ harness, env, rootConversationId, context: callContext });');
  globalThis.__c0Probes = { subagents: (options) => { probes.subagents = options; }, servers: (args) => { probes.servers = args; } };
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
  session = await app.load('session.js');
});
after(async () => {
  delete globalThis.__c0Probes;
  await app?.remove();
});

const contractMembers = () => [...S.getters, ...S.methods, ...Object.keys(S.excluded)].sort();
const keysOf = (value) => Object.keys(value).sort();
function assertShape(value, { required, optional }, label) {
  const keys = keysOf(value);
  for (const key of required) assert.ok(keys.includes(key), `${label}: missing ${key}`);
  const extra = keys.filter((key) => !required.includes(key) && !optional.includes(key));
  assert.deepEqual(extra, [], `${label}: keys not in agent.sessions@1`);
}
function assertSnapshot(snapshot, label) {
  assertShape(snapshot, S.snapshot, `${label} snapshot`);
  assertShape(snapshot.conversation, S.conversation, `${label} snapshot.conversation`);
  for (const thread of snapshot.threads) assertShape(thread, S.thread, `${label} snapshot.threads[${thread.id}]`);
  assert.ok(Array.isArray(snapshot.messages) && Array.isArray(snapshot.threads) && Array.isArray(snapshot.recoveryProviders));
}

async function open(name) {
  const { hostInfo, options } = CONFIGURATIONS[name]();
  const storage = new (class extends pd.MemoryStorage { async close() {} })();
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  try {
    const opened = await session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, ...options });
    return { opened, storage, restore: () => { globalThis.__piHostInfo = saved; } };
  } catch (error) {
    globalThis.__piHostInfo = saved;
    throw error;
  }
}
async function reply(opened, text) {
  const before = opened.snapshot.messages.length;
  await opened.send(text);
  await until(() => !opened.snapshot.busy && opened.snapshot.messages.length > before + 1 && opened.snapshot.messages.at(-1)?.role === 'assistant', 'reply did not finish');
}

for (const name of ['offline', 'native']) {
  test(`openAppSession (${name}) offers exactly agent.sessions@1 plus the excluded lifecycle members`, { skip }, async () => {
    const { opened, restore } = await open(name);
    try {
      assert.deepEqual(keysOf(opened), contractMembers());
      const getter = Object.getOwnPropertyDescriptor(opened, 'snapshot');
      assert.equal(typeof getter.get, 'function', 'snapshot is a getter');
      assert.equal(getter.set, undefined, 'snapshot is read-only');
      for (const method of S.methods) {
        assert.equal(typeof opened[method], 'function', `${method} is a method`);
        assert.ok(opened[method].length <= S.signatures[method].length, `${method} takes at most ${S.signatures[method].length} parameters`);
      }
      // P4 landed providers(): it moved from planned into the method list (read-only rows for Settings).
      assert.deepEqual(Object.keys(S.planned), [], 'nothing else is planned for agent.sessions@1');
      assert.ok(S.methods.includes('providers') && S.groups.providers.includes('providers'));
      const rows = opened.providers();
      assert.deepEqual(rows.map((row) => row.mode), ['offline', 'claude', 'chatgpt', 'openai'], 'the built-in rows, in table order');
      for (const row of rows) {
        assert.ok(Object.isFrozen(row), `${row.mode}: entries are frozen`);
        for (const key of ['mode', 'label', 'auth', 'defaultModelId', 'available', 'thinkingEfforts', 'catalog', 'models']) assert.ok(key in row, `${row.mode}: providers() entry has ${key}`);
        assert.equal(row.available, true);
        assert.ok(Array.isArray(row.catalog()) && Array.isArray(row.thinkingEfforts(row.defaultModelId)));
      }
      assertSnapshot(opened.snapshot, name);
      // subscribe calls the listener at once with the current snapshot and returns an unsubscribe.
      let seen;
      const unsubscribe = opened.subscribe((snapshot) => { seen = snapshot; });
      assert.equal(seen, opened.snapshot);
      assert.equal(typeof unsubscribe, 'function');
      unsubscribe();
    } finally {
      await opened.close();
      restore();
    }
  });
}

test('offline flows keep the snapshot within agent.sessions@1 (normalized record)', { skip }, async () => {
  const { opened, restore } = await open('offline');
  const record = [];
  const label = new Map();
  const name = (id) => {
    if (id === undefined) return undefined;
    if (!label.has(id)) label.set(id, `c${label.size}`);
    return label.get(id);
  };
  const conversationOf = (value) => ({
    id: name(value.id), keys: keysOf(value), title: value.title, isMain: value.isMain, draft: value.draft,
    ...value.archived ? { archived: true } : {}, ...value.parentId !== undefined ? { parentId: name(value.parentId) } : {},
    ...value.attachments ? { attachments: value.attachments.map((item) => ({ keys: keysOf(item), name: item.name, mimeType: item.mimeType })) } : {}
  });
  const step = (action) => {
    const snapshot = opened.snapshot;
    assertSnapshot(snapshot, action);
    record.push({
      action,
      keys: keysOf(snapshot),
      busy: snapshot.busy, paused: snapshot.paused, owned: snapshot.owned, kind: snapshot.kind, title: snapshot.title,
      persistence: snapshot.persistence, mode: snapshot.mode, modelId: snapshot.modelId, thinkingEffort: snapshot.thinkingEffort,
      modelSettings: snapshot.modelSettings,
      roles: snapshot.messages.map((message) => message.role),
      conversation: conversationOf(snapshot.conversation),
      threads: snapshot.threads.map(conversationOf)
    });
  };
  try {
    step('open');
    const main = opened.snapshot.conversation.id;
    await opened.setDraft('a draft');
    step('setDraft');
    await opened.addAttachments([new File(['attached text'], 'note.txt', { type: 'text/plain' })]);
    step('addAttachments');
    await opened.removeAttachment(opened.snapshot.conversation.attachments[0].id);
    step('removeAttachment');
    await opened.setDraft('');
    await reply(opened, 'hello contract');
    step('send');
    await opened.renameConversation(main, 'Renamed main');
    step('renameConversation');
    await opened.forkThread();
    step('forkThread');
    await opened.newThread();
    const thread = opened.snapshot.conversation.id;
    step('newThread');
    await opened.archiveConversation(thread);
    step('archiveConversation');
    await opened.unarchiveConversation(thread);
    step('unarchiveConversation');
    await opened.switchConversation(main);
    step('switchConversation');
    const tree = await opened.tree();
    const treeRecord = tree.map((node) => ({ keys: keysOf(node), id: name(node.id), parentId: name(node.parentId), kind: node.kind, title: node.title, busy: node.busy, selected: node.selected, archived: node.archived, empty: node.empty, model: node.model }));
    const normalized = JSON.parse(JSON.stringify({ contract: S.id, steps: record, tree: treeRecord }));
    if (process.env.C0_CAPTURE === '1') {
      await writeFile(SNAPSHOT_FILE, `${JSON.stringify(normalized, null, 2)}\n`);
    } else {
      assert.deepEqual(normalized, JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')), 'normalized flow differs from tests/plugin-c0-sessions.snapshot.json (C0_CAPTURE=1 only on purpose)');
    }
  } finally {
    await opened.close();
    restore();
  }
});

test('agent.harness@1 pieces are reachable where the doc says (native configuration)', { skip }, async () => {
  probes.subagents = probes.servers = undefined;
  const { opened, storage, restore } = await open('native');
  try {
    // createSubagentExtensions options = models/tools/prompt helpers + abortTask/abortSubmission.
    const options = probes.subagents;
    assert.ok(options, 'createSubagentExtensions was called');
    const expected = [...Object.values(H.models), ...Object.values(H.tools), ...Object.values(H.prompt), 'abortTask', 'abortSubmission'].sort();
    assert.deepEqual(keysOf(options), expected);
    for (const key of expected) assert.equal(typeof options[key], 'function', `${key} is a function`);
    assert.ok(Array.isArray(options.toolNames()), 'tools.names() lists tool names');
    assert.equal(typeof options.getTool(options.toolNames()[0])?.execute, 'function', 'tools.get(name) returns a tool');
    assert.equal(options.clampThinking({ provider: 'faux', modelId: 'faux-1' }, 'off'), 'off');
    // servers@1 connect() gets the session's Harness, env, root conversation and context.
    await until(() => probes.servers, 'servers@1 connect() was not called');
    const { harness, env, rootConversationId, context } = probes.servers;
    assert.ok(env && rootConversationId !== undefined && context !== undefined, 'env, rootConversationId and context are given');
    assert.equal(rootConversationId, opened.snapshot.conversation.id, 'root conversation = main');
    for (const method of H.methods) assert.equal(typeof harness[method], 'function', `Harness.${method} exists`);
    // The handle must hide these, so they are wrapped, not passed through (§B2).
    for (const method of H.forbidden) assert.equal(harness[method], undefined, `${method} is hidden by the agent.harness@1 handle`);
    for (const method of H.storage) assert.equal(typeof storage[method], 'function', `Storage.${method} exists`);
    // The read-only storage view works against the session's storage.
    const page = await storage.scanConversations({}, 10, undefined, context);
    assert.ok(page.items.some((item) => item.id === rootConversationId));
    assert.equal((await storage.conversation(rootConversationId, context))?.id, rootConversationId);
    const inspected = await harness.inspect(context);
    assert.ok(Array.isArray(inspected.tasks) && Array.isArray(inspected.submissions));
    // Session members never leak the Harness/Storage.
    for (const key of keysOf(opened)) assert.ok(opened[key] !== harness && opened[key] !== storage, `session.${key} exposes internals`);
  } finally {
    await opened.close();
    restore();
  }
});
