import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, offeredTools, until } from './plugin-agent-support.mjs';

// Real session.js (offline demo model, memory storage) with plugin agent extensions.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, ai, chord, session, runtimeModule, agentModule, clientModule, piModule, subagentsModule, fauxModule, fixture;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
  fauxModule = await app.load('library/pi-ai/providers/faux.js');
  session = await app.load('session.js');
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  clientModule = await app.load('plugin-client.js');
  piModule = await app.load('plugin-pi.js');
  subagentsModule = await app.load('builtin/core-subagents/web/subagents.js');
  fixture = await import(new URL('./plugin-agent-fixture.mjs', import.meta.url));
});
after(async () => { await app?.remove(); });

const context = () => chord.BACKGROUND_CONTEXT;
const hash = (c) => c.repeat(64);
// A page: runtime + installed plugins loaded through plugin-client with ctx.pi.
async function page(plugins) {
  const calls = [];
  const bridge = { async call(method, params) {
    if (method === 'plugins.list') return { api: 1, plugins: plugins.map(({ id }, index) => ({
      id, name: id, version: '0.1.0', hash: hash(String.fromCharCode(97 + index)), enabled: true, state: 'installed',
      web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [], uses: [] })) };
    if (method === 'plugins.call') { calls.push(params); return { value: 42 }; }
    throw new Error(`unexpected ${method}`);
  } };
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  const byUrl = new Map(plugins.map(({ id, module }, index) => [`/assets/web/plugins/${id}/${hash(String.fromCharCode(97 + index))}/web/index.js`, module]));
  const loaded = await clientModule.loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities: { plugins: true } }, importModule: async (url) => byUrl.get(url) });
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime, { installed: loaded.plugins });
  return { runtime, agentExtensions, calls };
}
class ReopenableStorage {
  static create(MemoryStorage) {
    return new (class extends MemoryStorage { async close() {} })();
  }
}
const extra = { setup(ctx) {
  const { defineExtension, defineTool, Type } = ctx.pi;
  ctx.contribute('agent.extensions', 'extra', defineExtension({ name: 'plugin-agent-extra', tools: [defineTool({
    name: 'extra_tool', description: 'Extra.', parameters: Type.Object({}), replay: 'safe', async execute() { return { content: [{ type: 'text', text: 'x' }] }; }
  })] }));
} };
async function reply(opened, text) {
  const before = opened.snapshot.messages.length;
  await opened.send(text);
  await until(() => !opened.snapshot.busy && opened.snapshot.messages.length > before + 1 && opened.snapshot.messages.at(-1)?.role === 'assistant', 'reply did not finish');
}

test('plugin tools are selected by default, excluded per conversation, persisted; new plugins appear, exclusions stay', { skip }, async () => {
  const storage = ReopenableStorage.create(pd.MemoryStorage);
  const first = await page([{ id: 'counter', module: fixture }]);
  const opened = await session.openAppSession({ storage, agentExtensions: first.agentExtensions });
  assert.equal(first.agentExtensions.list().registries, 1);
  assert.deepEqual(opened.plugins().map((row) => [row.id, row.toggle, row.enabled, row.tools]), [['counter', true, true, ['counter_value']]]);
  await reply(opened, 'hello');
  const main = opened.snapshot.conversation.id;
  let requests = await offeredTools(storage, main, context());
  assert.ok(requests.at(-1).includes('counter_value'), `default selection offers the plugin tool: ${requests.at(-1)}`);
  assert.ok(requests.at(-1).includes('workspace_write'), 'core tools stay');
  // Exclude for this conversation only, from its next model request.
  await opened.setPluginEnabled('counter', false);
  assert.equal(opened.plugins()[0].enabled, false);
  await reply(opened, 'again');
  requests = await offeredTools(storage, main, context());
  assert.ok(!requests.at(-1).includes('counter_value'), 'excluded plugin tool is no longer offered');
  assert.ok(requests.at(-1).includes('workspace_write'));
  // Another conversation is unaffected.
  await opened.newThread();
  const thread = opened.snapshot.conversation.id;
  assert.equal(opened.plugins()[0].enabled, false, 'a new thread copies the current tool set');
  await opened.setPluginEnabled('counter', true);
  assert.equal(opened.plugins()[0].enabled, true);
  await opened.switchConversation(main);
  assert.equal(opened.plugins()[0].enabled, false);
  await opened.close();
  assert.equal(first.agentExtensions.list().registries, 0, 'session close detaches its registry');
  assert.equal(first.runtime.list().find((record) => record.id === 'counter').state, 'active', 'and leaves the page runtime running');
  // Next page (reload / app revision): a newly installed plugin appears, the exclusion stays.
  const second = await page([{ id: 'counter', module: fixture }, { id: 'extra', module: extra }]);
  const reopened = await session.openAppSession({ storage, agentExtensions: second.agentExtensions });
  assert.equal(reopened.snapshot.conversation.id, main);
  assert.deepEqual(reopened.plugins().map((row) => [row.id, row.enabled]), [['counter', false], ['extra', true]]);
  await reply(reopened, 'third');
  requests = await offeredTools(storage, main, context());
  assert.ok(requests.at(-1).includes('extra_tool'), 'new plugin joins by default');
  assert.ok(!requests.at(-1).includes('counter_value'), 'excluded stays excluded');
  await reopened.switchConversation(thread);
  assert.deepEqual(reopened.plugins().map((row) => [row.id, row.enabled]), [['counter', true], ['extra', true]]);
  await reopened.close();
  await first.runtime.close();
  await second.runtime.close();
});

test('the first model request of a page waits for plugin composition up to the deadline', { skip }, async () => {
  const storage = ReopenableStorage.create(pd.MemoryStorage);
  const reports = [];
  const agentExtensions = agentModule.createAgentExtensions({ timeoutMs: 300, onError: (error, details) => reports.push(details.phase) });
  const opened = await session.openAppSession({ storage, agentExtensions });
  const started = Date.now();
  await reply(opened, 'hello');
  assert.ok(Date.now() - started >= 280, 'send waited for the readiness deadline');
  assert.deepEqual(reports, ['readiness']);
  // Composition that arrives later installs into the open session for the next request.
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  runtime.register({ id: 'counter', version: '1.0.0', setup: (ctx) => fixture.setup({ ...ctx, native: { call: async () => 1 } }) });
  await runtime.start();
  agentExtensions.connect(runtime);
  const at = Date.now();
  await reply(opened, 'again');
  assert.ok(Date.now() - at < 2500, 'later requests do not wait again');
  const requests = await offeredTools(storage, opened.snapshot.conversation.id, context());
  assert.ok(!requests[0].includes('counter_value') && requests.at(-1).includes('counter_value'));
  await opened.close();
  await runtime.close();
});

test('background/foreground reopen reattaches the same page plugins once per session', { skip }, async () => {
  const storage = ReopenableStorage.create(pd.MemoryStorage);
  const { runtime, agentExtensions } = await page([{ id: 'counter', module: fixture }]);
  for (let round = 0; round < 3; round++) {
    const opened = await session.openAppSession({ storage, agentExtensions });
    assert.equal(agentExtensions.list().registries, 1);
    assert.deepEqual(opened.plugins().map((row) => row.id), ['counter']);
    await opened.close();
    assert.equal(agentExtensions.list().registries, 0);
  }
  assert.equal(runtime.list()[0].state, 'active');
  await runtime.close();
});

test('subagents inherit the owner plugin exclusions and only get its selected plugin tools', { skip }, async () => {
  const ctx = chord.BACKGROUND_CONTEXT;
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  runtime.register({ id: 'counter', version: '1.0.0', setup: (c) => fixture.setup({ ...c, native: { call: async () => 5 } }) });
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions();
  agentExtensions.connect(runtime);
  const registry = pd.createRegistry();
  const Core = pd.defineExtension({ name: 'self-forming-native', tools: [pd.defineTool({ name: 'read', description: 'r', parameters: ai.Type.Object({}), replay: 'safe', async execute() { return { content: [{ type: 'text', text: 'r' }] }; } })] });
  let SubagentTools;
  const all = () => [Core, SubagentTools, ...agentExtensions.extensions()];
  const created = subagentsModule.createSubagentExtensions({
    getTool: (name) => all().flatMap((extension) => extension.tools ?? []).find((candidate) => candidate.name === name),
    toolNames: (agent) => [...new Set(all().filter((extension) => !agent || agentExtensions.selects(agent, extension.name)).flatMap((extension) => (extension.tools ?? []).map((candidate) => candidate.name)))],
    resolveModel: async () => undefined, listModels: async () => '', clampThinking: () => undefined,
    configurePrompt: async () => {}, abortTask: (id, c) => harness.abortTask(id, c), abortSubmission: (id, c, conv) => harness.abortSubmission(id, c, conv)
  }, piModule.pluginPi);
  SubagentTools = created.SubagentTools;
  registry.install(Core);
  registry.install(SubagentTools);
  agentExtensions.attach(registry);
  const models = ai.createModels();
  const faux = fauxModule.fauxProvider({ tokensPerSecond: 0 });
  models.setProvider(faux.provider);
  const step = (transcript) => {
    faux.appendResponses([step]);
    const child = transcript.messages.some((message) => message.role === 'system' && JSON.stringify(message).includes('You are a subagent'));
    if (child) return fauxModule.fauxAssistantMessage('child done');
    if (!transcript.messages.some((message) => message.role === 'toolResult')) return fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall('subagent', { action: 'run', message: 'go' }), { stopReason: 'toolUse' });
    return fauxModule.fauxAssistantMessage('parent done');
  };
  faux.setResponses([step]);
  const storage = new pd.MemoryStorage();
  const harness = await pd.Harness.open(storage, { models, registry, settings: { get extensions() { return agentExtensions.selection([Core, SubagentTools], registry); } } }, ctx);
  const childAgents = [];
  for (const exclude of [true, false]) {
    const owner = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } }, ctx);
    if (exclude) await owner.configure({ extensions: agentExtensions.change(undefined, 'counter', false) }, ctx);
    const submission = await owner.submit({ type: 'input', content: 'delegate' }, ctx);
    const settled = await submission.wait(ctx);
    assert.equal(settled.status, 'done');
    const children = (await storage.scanConversations({}, 50, undefined, ctx)).items.filter((record) => record.owner && !childAgents.some((seen) => seen.id === record.id));
    assert.equal(children.length, 1);
    childAgents.push({ id: children[0].id, agent: await harness.snapshot(pd.AgentDoc, children[0].id, ctx), resolved: await (await harness.conversation(children[0].id, ctx)).agent(ctx) });
  }
  const [excluded, included] = childAgents;
  assert.deepEqual(excluded.agent.extensions, { remove: ['self-forming-subagents', 'plugin-agent-fixture'] });
  assert.ok(!excluded.agent.tools.includes('counter_value'));
  assert.ok(!excluded.resolved.tools.some((candidate) => candidate.name === 'counter_value'));
  assert.deepEqual(included.agent.extensions, { remove: ['self-forming-subagents'] });
  assert.ok(included.resolved.tools.some((candidate) => candidate.name === 'counter_value'), 'selected plugin tools reach subagents');
  assert.ok(!included.resolved.tools.some((candidate) => candidate.name === 'subagent'));
  await harness.close(ctx);
  await runtime.close();
});

test('a model call of the contributed tool runs the plugin code and its pinned native call', { skip }, async () => {
  const ctx = chord.BACKGROUND_CONTEXT;
  const { runtime, agentExtensions, calls } = await page([{ id: 'counter', module: fixture }]);
  const registry = pd.createRegistry();
  agentExtensions.attach(registry);
  const models = ai.createModels();
  const faux = fauxModule.fauxProvider({ tokensPerSecond: 0 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall('counter_value', {}), { stopReason: 'toolUse' }),
    fauxModule.fauxAssistantMessage('done')
  ]);
  const storage = new pd.MemoryStorage();
  const harness = await pd.Harness.open(storage, { models, registry, settings: { get extensions() { return agentExtensions.selection(undefined, registry); } } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const settled = await (await root.submit({ type: 'input', content: 'count' }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done');
  const page1 = await storage.scanEntries({ conversationId: root.id }, 50, undefined, ctx);
  const results = [];
  for (const record of page1.items) for (const message of (await storage.entry(record.id, ctx)).entry.model ?? []) if (message.role === 'toolResult') results.push(message);
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, 'counter_value');
  assert.equal(results[0].isError, false);
  assert.equal(results[0].content[0].text, '{"value":42}');
  assert.deepEqual(calls, [{ id: 'counter', hash: hash('a'), method: 'get', input: {} }]);
  await harness.close(ctx);
  await runtime.close();
});
