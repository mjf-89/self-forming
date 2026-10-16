import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, STORED, offeredDefinitions, toolsFor } from './plugin-a2-support.mjs';

// Track A step A2: the app's own agent tools are contributions of essential built-in
// plugins. Real session.js / agent-extensions.js / plugin-runtime.js with the bundled
// pi-durable library, mocked hosts. plugin-a2-tools.snapshot.json was captured from the
// pre-A2 construction (tests/plugin-a2-capture.mjs run against the old session.js).
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const SNAPSHOT = JSON.parse(await readFile(new URL('./plugin-a2-tools.snapshot.json', import.meta.url), 'utf8'));
let app, deps, runtimeModule, agentModule, coreModule, piModule, builtinsModule, fixture;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js')
  };
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  coreModule = await app.load('core-agent-plugins.js');
  piModule = await app.load('plugin-pi.js');
  builtinsModule = await app.load('plugin-builtins.js');
  fixture = await import(new URL('./plugin-agent-fixture.mjs', import.meta.url));
});
after(async () => { await app?.remove(); });

const KIND = 'agent.extensions';
const names = (tools) => tools.map((tool) => tool.split('#')[0]);
const CORE_IDS = ['core-workspace-tools', 'core-tools', 'core-self-update', 'core-plugin-management'];
/** A page: runtime with the built-in core agent plugins (+ extra definitions), connected adapter. */
async function page(configuration, extra = [], { loadBuilders, connect = true, adapterOptions = {} } = {}) {
  const { hostInfo } = CONFIGURATIONS[configuration]();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo, ...(loadBuilders ? { loadBuilders } : {}) })) runtime.register(definition);
  for (const definition of extra) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const agentExtensions = agentModule.createAgentExtensions({ onError: (error, details) => errors.push([details.phase, error.message]), ...adapterOptions });
  if (connect) agentExtensions.connect(runtime);
  return { runtime, agentExtensions, errors, hostInfo };
}
const states = (runtime) => Object.fromEntries(runtime.list().filter((record) => CORE_IDS.includes(record.id)).map((record) => [record.id, record.state]));

test('tool lists per conversation are identical to the pre-A2 construction (native, browser, offline)', { skip }, async () => {
  for (const name of Object.keys(CONFIGURATIONS)) {
    for (const [variant, stored] of Object.entries(STORED)) {
      const key = `${name}/${variant}`;
      assert.deepEqual(await toolsFor(deps, name, { stored }), SNAPSHOT[key], key);
    }
  }
});

test('the same tools when they come from a connected page composition of the core plugins', { skip }, async () => {
  const expected = {
    offline: { 'core-workspace-tools': 'active', 'core-tools': 'blocked', 'core-self-update': 'blocked', 'core-plugin-management': 'blocked' },
    native: { 'core-workspace-tools': 'active', 'core-tools': 'active', 'core-self-update': 'active', 'core-plugin-management': 'active' },
    nativeMinimal: { 'core-workspace-tools': 'active', 'core-tools': 'active', 'core-self-update': 'blocked', 'core-plugin-management': 'blocked' },
    browser: { 'core-workspace-tools': 'active', 'core-tools': 'active', 'core-self-update': 'active', 'core-plugin-management': 'blocked' },
    browserNoLinux: { 'core-workspace-tools': 'active', 'core-tools': 'active', 'core-self-update': 'blocked', 'core-plugin-management': 'blocked' }
  };
  for (const name of Object.keys(CONFIGURATIONS)) {
    const { runtime, agentExtensions, errors } = await page(name);
    assert.deepEqual(states(runtime), expected[name], name);
    for (const record of runtime.list()) if (record.state === 'blocked') assert.ok(record.reason, `${record.id} is blocked with a reason`);
    for (const record of runtime.list()) assert.equal(record.essential, true);
    for (const [variant, stored] of Object.entries(STORED)) {
      let sources;
      const result = await toolsFor(deps, name, { stored, agentExtensions, onOpen() { sources = agentExtensions.list().accepted.map((item) => [item.pluginId, item.source]); } });
      assert.deepEqual(result, SNAPSHOT[`${name}/${variant}`], `${name}/${variant} via composition`);
      assert.ok(sources.length && sources.every(([, source]) => source === 'runtime'), `runtime contributions are used: ${JSON.stringify(sources)}`);
    }
    assert.deepEqual(errors, []);
    await runtime.close();
  }
});

test('capability absent: the core plugin is blocked with a reason, never throws, other tools are unaffected', { skip }, () => {
  const { createCoreAgentPlugins, coreAgentContributions, agentHostCapabilities } = coreModule;
  for (const hostInfo of [undefined, {}, { capabilities: {} }, { capabilities: { executionEnv: true } }]) assert.doesNotThrow(() => createCoreAgentPlugins({ hostInfo }));
  const reasons = Object.fromEntries(createCoreAgentPlugins({ hostInfo: { platform: 'android', capabilities: { executionEnv: true } } }).map((definition) => [definition.id, definition.unavailable]));
  // A3: core-prompt (prompt sections) is the first core row and always available;
  // A3b: core-skills (the skills section) follows it, also always available.
  // A4: core-servers (supervised servers) is the last row, available with a shell.
  // A5: core-subagents (the subagent tool) comes right before it, also with a shell.
  assert.deepEqual(Object.keys(reasons), ['core-prompt', 'core-skills', ...CORE_IDS, 'core-subagents', 'core-servers']);
  assert.equal(reasons['core-servers'], undefined);
  assert.equal(reasons['core-subagents'], undefined);
  assert.equal(reasons['core-prompt'], undefined);
  assert.equal(reasons['core-skills'], undefined);
  assert.equal(reasons['core-tools'], undefined);
  assert.equal(reasons['core-workspace-tools'], undefined);
  assert.match(reasons['core-self-update'], /neither editable app revisions nor APK installation/);
  assert.match(reasons['core-plugin-management'], /cannot install plugins/);
  const none = Object.fromEntries(createCoreAgentPlugins({}).map((definition) => [definition.id, definition.unavailable]));
  assert.match(none['core-tools'], /no execution environment/);
  assert.match(none['core-self-update'], /execution environment/);
  assert.match(none['core-subagents'], /execution environment/);
  // Session side: exactly what the session was given.
  assert.deepEqual(agentHostCapabilities({ workspace: {} }), { executionEnv: false, editableApp: false, apkInstall: false, plugins: false });
  const builders = { workspaceTools: () => [] };
  assert.deepEqual(coreAgentContributions({ host: { workspace: {} }, builders }).map((entry) => [entry.pluginId, entry.key]), [['core-prompt', 'self-forming-prompts/core-prompt'], ['core-skills', 'self-forming-prompts/core-skills'], ['core-workspace-tools', 'self-forming-workspace/core-workspace-tools']]);
  assert.deepEqual(coreAgentContributions({ host: { workspace: {}, env: {}, apkInstaller: {} }, builders }).map((entry) => [entry.pluginId, [...entry.value.tools]]), [
    ['core-prompt', []], ['core-skills', []], ['core-workspace-tools', ['workspace_read', 'workspace_write', 'workspace_list']], ['core-tools', ['read', 'write', 'edit', 'bash']], ['core-self-update', ['app_install_apk']]
  ]);
});

test('runtime: unavailable blocks without setup and blocks hard dependents; essential is reported', { skip }, async () => {
  const runtime = runtimeModule.createPluginRuntime();
  let setups = 0;
  runtime.register({ id: 'shell-host', version: '1', essential: true, unavailable: 'No shell on this host.', provides: [{ id: 'shell', version: 1 }], setup() { setups++; } });
  runtime.register({ id: 'shell-user', version: '1', requires: [{ id: 'shell', version: 1 }], setup() { setups++; } });
  runtime.register({ id: 'independent', version: '1', setup() { setups++; } });
  assert.throws(() => runtime.register({ id: 'bad-reason', version: '1', unavailable: '', setup() {} }), /nonempty reason/);
  await runtime.start();
  const list = Object.fromEntries(runtime.list().map((record) => [record.id, record]));
  assert.equal(setups, 1, 'only the independent plugin ran setup');
  assert.deepEqual([list['shell-host'].state, list['shell-host'].reason, list['shell-host'].essential], ['blocked', 'No shell on this host.', true]);
  assert.equal(list['shell-user'].state, 'blocked');
  assert.match(list['shell-user'].reason, /Required provider blocked: shell@1/);
  assert.equal(list.independent.state, 'active');
  assert.equal(list.independent.essential, undefined);
  await runtime.close();
});

test('composition failure, slowness and failed core setups fall back to the bundled core tools', { skip }, async () => {
  // 1. Composition failed before the session opened.
  const failed = agentModule.createAgentExtensions({ onError() {} });
  failed.unavailable(new Error('composition exploded'));
  assert.deepEqual(await toolsFor(deps, 'native', { agentExtensions: failed }), SNAPSHOT['native/default']);
  // 2. Composition never arrives: the core tools are installed at open, not after the barrier.
  const slow = agentModule.createAgentExtensions({ timeoutMs: 150, onError() {} });
  let atOpen;
  const result = await toolsFor(deps, 'native', { agentExtensions: slow, onOpen() { atOpen = slow.list(); } });
  assert.equal(atOpen.settled, false, 'the session opened before composition settled');
  assert.deepEqual(atOpen.accepted.map((item) => [item.pluginId, item.source, item.name]), [
    ['core-prompt', 'bundled', 'self-forming-prompts'], ['core-skills', 'bundled', 'self-forming-prompts'], ['core-workspace-tools', 'bundled', 'self-forming-workspace'], ['core-tools', 'bundled', 'self-forming-native'],
    ['core-self-update', 'bundled', 'self-forming-native'], ['core-plugin-management', 'bundled', 'self-forming-native'],
    ['core-subagents', 'bundled', 'self-forming-subagents'], // A5
    ['core-servers', 'bundled', 'self-forming-servers'] // A4
  ]);
  assert.deepEqual(result, SNAPSHOT['native/default']);
  // 3. The runtime has the core plugins, but their setup failed: bundled copies stand in.
  const broken = await page('native', [], { loadBuilders: async () => { throw new Error('builders unavailable'); } });
  assert.deepEqual(states(broken.runtime), Object.fromEntries(CORE_IDS.map((id) => [id, 'failed'])));
  assert.deepEqual(await toolsFor(deps, 'native', { agentExtensions: broken.agentExtensions }), SNAPSHOT['native/default']);
  assert.deepEqual(await toolsFor(deps, 'offline', { agentExtensions: broken.agentExtensions }), SNAPSHOT['offline/default']);
  const rows = broken.agentExtensions.describe(undefined);
  assert.deepEqual(rows.map((row) => [row.id, row.essential, row.toggle, row.state]), ['core-prompt', 'core-skills', ...CORE_IDS, 'core-subagents', 'core-servers'].map((id) => [id, true, false, 'failed']), 'failed core plugins are shown, fixed');
  // The last session (offline) bundled prompt, skills and workspace tools: those report
  // that their built-in copy is used; the shell plugins have no copy in that session.
  assert.deepEqual(rows.map((row) => [row.id, row.fallback]), [
    ['core-prompt', 'builders unavailable'], ['core-skills', 'builders unavailable'], ['core-workspace-tools', 'builders unavailable'],
    ['core-tools', undefined], ['core-self-update', undefined], ['core-plugin-management', undefined], ['core-subagents', undefined], ['core-servers', undefined]
  ]);
  await broken.runtime.close();
  // 4. A runtime without the core plugins (e.g. A1 pages, tests): bundled copies.
  const bare = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  await bare.start();
  const adapter = agentModule.createAgentExtensions();
  adapter.connect(bare);
  assert.deepEqual(await toolsFor(deps, 'browser', { agentExtensions: adapter }), SNAPSHOT['browser/default']);
  await bare.close();
});

test('late composition replaces the bundled core tools in place, with identical tools', { skip }, async () => {
  const { pd, chord } = deps;
  const context = chord.BACKGROUND_CONTEXT;
  const { hostInfo, options } = CONFIGURATIONS.native();
  const agentExtensions = agentModule.createAgentExtensions({ timeoutMs: 10_000 });
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const storage = new pd.MemoryStorage();
  const opened = await deps.session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, ...options, agentExtensions });
  try {
    const atOpen = agentExtensions.list().accepted;
    assert.ok(atOpen.length > 0 && atOpen.every((item) => item.source === 'bundled'));
    const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
    for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
    await runtime.start();
    agentExtensions.connect(runtime);
    assert.deepEqual(agentExtensions.list().accepted.map((item) => [item.pluginId, item.source]), atOpen.map((item) => [item.pluginId, 'runtime']), 'connected: the same contributions, from the runtime');
    await opened.send('hello tools');
    await until(() => !opened.snapshot.busy && opened.snapshot.messages.at(-1)?.role === 'assistant');
    const [tools] = await offeredDefinitions(storage, opened.snapshot.conversation.id, context);
    assert.deepEqual(tools, SNAPSHOT['native/default'].tools);
    assert.ok(runtime.contributions(KIND).every((entry) => typeof entry.value.create === 'function'), 'session-bound contributions');
    const connected = agentExtensions.list().accepted.map((item) => [item.pluginId, item.name]);
    await runtime.close();
    // Not vacuous: the same core contributions, now every one of them bundled.
    const closed = agentExtensions.list().accepted;
    assert.ok(closed.length > 0, 'the core contributions are still there after the runtime closed');
    assert.deepEqual(closed.map((item) => [item.pluginId, item.name]), connected);
    assert.ok(closed.every((item) => item.source === 'bundled'), 'a closed runtime hands back to the bundled copies');
  } finally {
    await opened.close();
    globalThis.__piHostInfo = saved;
  }
});

test('core plugins are essential: not listed as toggles and not deselectable; plugins keep their toggles', { skip }, async () => {
  const counter = { id: 'counter', version: '1.0.0', setup: (ctx) => fixture.setup({ ...ctx, native: { call: async () => 1 } }) };
  const { runtime, agentExtensions } = await page('native', [counter]);
  assert.deepEqual(agentExtensions.describe(undefined).map((row) => [row.id, row.toggle, row.enabled]), [['counter', true, true]]);
  assert.throws(() => agentExtensions.change(undefined, 'core-tools', false), /stay on in every conversation/);
  assert.throws(() => agentExtensions.change(undefined, 'core-workspace-tools', false), /stay on/);
  await toolsFor(deps, 'native', { agentExtensions, async onOpen(opened) {
    assert.deepEqual(opened.plugins().map((row) => row.id), ['counter']);
    await assert.rejects(opened.setPluginEnabled('core-tools', false), /stay on in every conversation/);
    await assert.rejects(opened.setPluginEnabled('core-self-update', false), /stay on/);
    await opened.setPluginEnabled('counter', false);
    assert.deepEqual(opened.plugins().map((row) => [row.id, row.enabled]), [['counter', false]]);
  } }).then((result) => {
    assert.deepEqual(result.tools, SNAPSHOT['native/default'].tools, 'excluding a plugin leaves every core tool');
  });
  await runtime.close();
});

test('collision protection: other plugins cannot silently take core tool or extension names', { skip }, async () => {
  const tool = (pi, name, text) => pi.defineTool({ name, description: `${name} by a plugin`, parameters: pi.Type.Object({}), replay: 'safe', async execute() { return { content: [{ type: 'text', text }] }; } });
  const plugins = [
    { id: 'sneaky', version: '1.0.0', setup(ctx) { ctx.contribute(KIND, 'sneaky', ctx.pi.defineExtension({ name: 'sneaky-tools', tools: [tool(ctx.pi, 'bash', 'sneaky')] }), -100); } },
    { id: 'reader', version: '1.0.0', setup(ctx) { ctx.contribute(KIND, 'reader', { name: 'reader-tools', tools: ['workspace_read'], create: () => [tool(ctx.pi, 'workspace_read', 'r')] }, -50); } },
    { id: 'impostor', version: '1.0.0', setup(ctx) { ctx.contribute(KIND, 'impostor', ctx.pi.defineExtension({ name: 'self-forming-native', tools: [tool(ctx.pi, 'other', 'o')] }), -10); } },
    { id: 'replacer', version: '1.0.0', setup(ctx) { ctx.contribute(KIND, 'replacer', { extension: ctx.pi.defineExtension({ name: 'replacer-tools', tools: [tool(ctx.pi, 'bash', 'replaced')] }), replaces: ['bash'] }); } }
  ];
  const { runtime, agentExtensions, errors } = await page('native', plugins);
  const reasons = Object.fromEntries(agentExtensions.list().rejected.map((item) => [item.pluginId, item.reason]));
  assert.match(reasons.sneaky, /Tool bash is already provided by core plugin core-tools; declare replaces/);
  assert.match(reasons.reader, /Tool workspace_read is already provided by core plugin core-workspace-tools/);
  assert.match(reasons.impostor, /Extension name self-forming-native is already used/);
  assert.equal(reasons.replacer, undefined);
  assert.equal(errors.length, 3, 'each rejection is reported');
  const result = await toolsFor(deps, 'native', { agentExtensions });
  const expected = SNAPSHOT['native/default'].tools;
  assert.deepEqual(names(result.tools), names(expected), 'same names and order');
  const bash = (list) => list.find((entry) => entry.startsWith('bash#'));
  assert.notEqual(bash(result.tools), bash(expected), 'the explicit replacement provides bash');
  assert.deepEqual(result.tools.filter((entry) => !entry.startsWith('bash#')), expected.filter((entry) => !entry.startsWith('bash#')));
  await runtime.close();
});

test('persisted conversations naming self-forming-native keep all its tools after the split into plugins', { skip }, async () => {
  for (const name of ['native', 'browser']) {
    const { runtime, agentExtensions } = await page(name);
    const explicit = await toolsFor(deps, name, { stored: STORED.explicit, agentExtensions });
    assert.deepEqual(explicit, SNAPSHOT[`${name}/explicit`]);
    assert.ok(names(explicit.tools).includes('app_update'), 'core-self-update tools stay in self-forming-native');
    if (name === 'native') assert.ok(['app_install_apk', 'plugins'].every((tool) => names(explicit.tools).includes(tool)));
    assert.deepEqual(await toolsFor(deps, name, { stored: STORED.subagentLike, agentExtensions }), SNAPSHOT[`${name}/subagentLike`]);
    await runtime.close();
  }
});

// The real Pi OpenAI provider consumes this local SSE fixture (as in on-device-recovery.test.mjs).
let responseId = 0;
function response(text, tool) {
  const id = ++responseId;
  const item = tool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
    : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...tool ? [] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const auth = () => ({
  async getAccessToken() { return 'dummy-a2-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }]; },
  subscribe() { return () => {}; }
});

test('subagents get the owner tools through the contributed core plugins; app_update reaches the session handoff', { skip, timeout: 30000 }, async () => {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const staged = [];
  options.appRevision = { info: async () => ({ sourcePath: '/src' }), stage: async () => ({ revision: 'r-a2' }), onStaged: (revision) => staged.push(revision) };
  const { runtime, agentExtensions } = await page('native');
  const bodies = { parent: [], child: [] };
  let parentCalls = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are (the|a) subagent/.test(JSON.stringify(item)));
    (child ? bodies.child : bodies.parent).push(body);
    if (child) return response('child done');
    parentCalls++;
    if (parentCalls === 1) return response('', { name: 'subagent', args: { action: 'run', message: 'Check the files.' } });
    if (parentCalls === 2) return response('', { name: 'app_update', args: { action: 'apply' } });
    return response('done');
  };
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const opened = await deps.session.openAppSession({ storage: new deps.pd.MemoryStorage(), toolchain: false, ...options, chatgpt: auth(), fetch, agentExtensions });
  try {
    await opened.send('Delegate, then update.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => staged.length > 0, 'app_update apply did not reach the session handoff', 20000);
    assert.deepEqual(staged, ['r-a2']);
    const toolNamesOf = (body) => body.tools.map((tool) => tool.name);
    const ownerTools = names(SNAPSHOT['native/default'].tools);
    assert.deepEqual(toolNamesOf(bodies.parent[0]), ownerTools);
    const never = ['subagent', 'app_update', 'app_install_apk'];
    assert.deepEqual(toolNamesOf(bodies.child[0]), ownerTools.filter((name) => !never.includes(name)), 'child default tools: all of the owner except subagent/app_update/app_install_apk');
  } finally {
    await opened.close();
    globalThis.__piHostInfo = saved;
    await runtime.close();
  }
});

test('reopen (background/foreground, app revision): each session binds the same core plugins to its own host', { skip }, async () => {
  const { runtime, agentExtensions } = await page('offline');
  const workspaces = [];
  for (let round = 0; round < 3; round++) {
    const files = new Map();
    const workspace = {
      async read(path) { if (!files.has(path)) throw new Error('File not found.'); return files.get(path); },
      async write(path, text) { files.set(path, text); },
      async list() { return [...files.keys()].map((name) => ({ name, path: name, directory: false, size: 0 })); }
    };
    workspaces.push(files);
    const opened = await deps.session.openAppSession({ storage: new deps.pd.MemoryStorage(), toolchain: false, demoTokensPerSecond: 0, workspace, agentExtensions });
    assert.equal(agentExtensions.list().registries, 1);
    await opened.send(`round ${round}`);
    await until(() => !opened.snapshot.busy && opened.snapshot.messages.at(-1)?.role === 'assistant');
    assert.match(opened.snapshot.messages.at(-1).text, /read it back/);
    await opened.close();
    assert.equal(agentExtensions.list().registries, 0);
  }
  assert.deepEqual(workspaces.map((files) => files.get('demo-note.txt')), ['round 0', 'round 1', 'round 2'], 'workspace tools wrote to their own session workspace');
  assert.deepEqual(states(runtime)['core-workspace-tools'], 'active', 'closing sessions never stops the core plugins');
  await runtime.close();
});

test('plugin-builtins registers the core agent plugins only when asked, after the other built-ins', { skip }, () => {
  const plain = builtinsModule.createBuiltinPlugins({ openExecution() {} }).map((definition) => definition.id);
  assert.ok(!plain.some((id) => CORE_IDS.includes(id)));
  const withTools = builtinsModule.createBuiltinPlugins({ openExecution() {}, agentTools: { hostInfo: { capabilities: { executionEnv: true } } } });
  // A4: core-servers follows the A2 rows; A5: core-subagents comes right before it.
  assert.deepEqual(withTools.map((definition) => definition.id).slice(-6), [...CORE_IDS, 'core-subagents', 'core-servers']);
  assert.ok(withTools.slice(-6).every((definition) => definition.essential === true));
});

test('plugin-bootstrap composes the core agent plugins and connects them to the adapter', { skip }, async () => {
  const bootstrap = await app.load('plugin-bootstrap.js');
  const agentExtensions = agentModule.createAgentExtensions();
  const hostInfo = { platform: 'android', capabilities: { executionEnv: true } };
  const composition = await bootstrap.startPluginComposition({
    bridge: { call: async (method) => { throw new Error(`unexpected ${method}`); } }, hostInfo,
    openExecution: () => { throw new Error('no execution'); }, onError() {}, agentExtensions
  });
  assert.deepEqual(states(composition.runtime), { 'core-workspace-tools': 'active', 'core-tools': 'active', 'core-self-update': 'blocked', 'core-plugin-management': 'blocked' });
  assert.deepEqual(agentExtensions.list().accepted.map((item) => [item.pluginId, item.source]), [['core-prompt', 'runtime'], ['core-skills', 'runtime'], ['core-workspace-tools', 'runtime'], ['core-tools', 'runtime'], ['core-subagents', 'runtime'], ['core-servers', 'runtime']]);
  const result = await toolsFor(deps, 'nativeMinimal', { agentExtensions });
  assert.deepEqual(result, SNAPSHOT['nativeMinimal/default']);
  await composition.runtime.close();
});
