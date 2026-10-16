import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';

// pi-durable 1.2.0 (CHANGELOG "Breaking Changes": `ToolExecutionResult.content` is now `output`): app tools
// answer `output`; the host compatibility wrap (agent-extensions.js compatibleExtension) passes a legacy
// `{content}` result of an installed plugin (or a built-in not migrated yet) on as `output`. Real
// pi-durable Harness + faux provider + the agent extension adapter. No device or network.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, ai, faux, chord, adapterModule, workspaceTools;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  faux = await app.load('library/pi-ai/providers/faux.js');
  chord = await app.load('library/chord/context.js');
  adapterModule = await app.load('agent-extensions.js');
  workspaceTools = await app.load('builtin/core-workspace-tools/web/workspace-tools.js');
});
after(async () => { await app?.remove(); });

test('compatibleExtension: legacy {content} becomes output; output results, other fields and identity are kept', { skip }, async () => {
  const legacy = pd.defineTool({ name: 'legacy', description: 'l', parameters: ai.Type.Object({}), replay: 'safe',
    async execute() { return { content: [{ type: 'text', text: 'old' }], details: { n: 1 }, isError: false }; } });
  const current = pd.defineTool({ name: 'current', description: 'c', parameters: ai.Type.Object({}), replay: 'safe',
    async execute() { return { output: [{ type: 'text', text: 'new' }], content: 'ignored' }; } });
  const extension = pd.defineExtension({ name: 'compat-test', tools: [legacy, current] });
  const wrapped = adapterModule.compatibleExtension(extension);
  assert.equal(adapterModule.compatibleExtension(extension), wrapped, 'one wrapper per extension');
  assert.deepEqual(wrapped.tools.map((tool) => tool.name), ['legacy', 'current']);
  assert.equal(wrapped.tools[0].description, 'l');
  assert.deepEqual(await wrapped.tools[0].execute({}, {}, chord.BACKGROUND_CONTEXT), { details: { n: 1 }, isError: false, output: [{ type: 'text', text: 'old' }] });
  assert.deepEqual(await wrapped.tools[1].execute({}, {}, chord.BACKGROUND_CONTEXT), { output: [{ type: 'text', text: 'new' }], content: 'ignored' });
  const empty = pd.defineExtension({ name: 'no-tools', sections: [] });
  assert.equal(adapterModule.compatibleExtension(empty), empty);
});

test('the model sees a legacy plugin tool result and an app tool result (workspace_read answers output)', { skip }, async () => {
  const ctx = chord.BACKGROUND_CONTEXT;
  const files = new Map([['note.txt', 'from the workspace']]);
  const [workspaceRead] = workspaceTools.workspaceTools({ read: async (path) => files.get(path), write: async () => {}, list: async () => [] });
  assert.deepEqual(await workspaceRead.execute({ path: 'note.txt' }), { output: [{ type: 'text', text: 'from the workspace' }] });
  const legacy = pd.defineTool({ name: 'legacy_tool', description: 'Legacy.', parameters: ai.Type.Object({}), replay: 'safe',
    async execute() { return { content: [{ type: 'text', text: 'legacy result' }] }; } });
  const adapter = adapterModule.createAgentExtensions({ onError() {} });
  adapter.unavailable(new Error('no runtime in this test'));
  const registry = pd.createRegistry();
  const detach = adapter.attach(registry, { builtins: [
    { pluginId: 'legacy-plugin', key: 'legacy', order: 0, value: pd.defineExtension({ name: 'legacy-plugin-tools', tools: [legacy] }) },
    { pluginId: 'workspace-plugin', key: 'workspace', order: 1, value: pd.defineExtension({ name: 'workspace-test-tools', tools: [workspaceRead] }) }
  ] });
  const models = ai.createModels();
  const provider = faux.fauxProvider({ tokensPerSecond: 0 });
  models.setProvider(provider.provider);
  provider.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall('legacy_tool', {}), faux.fauxToolCall('workspace_read', { path: 'note.txt' })], { stopReason: 'toolUse' }),
    faux.fauxAssistantMessage('done')
  ]);
  const storage = new pd.MemoryStorage();
  const harness = await pd.Harness.open(storage, { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  assert.equal((await (await root.submit({ type: 'input', content: 'go' }, ctx)).wait(ctx)).status, 'done');
  const view = await root.context(ctx);
  const results = view.messages.filter((message) => message.role === 'toolResult');
  const text = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.deepEqual(results.map((message) => [message.toolName, text(message), message.isError]), [
    ['legacy_tool', 'legacy result', false],
    ['workspace_read', 'from the workspace', false]
  ]);
  await harness.close(ctx);
  detach();
});
