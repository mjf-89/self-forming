import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, tick } from './plugin-agent-support.mjs';

const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, ai, chord, runtimeModule, agentModule, clientModule, piModule;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  clientModule = await app.load('plugin-client.js');
  piModule = await app.load('plugin-pi.js');
});
after(async () => { await app?.remove(); });

const KIND = 'agent.extensions';
const def = (id, setup, options = {}) => ({ id, version: '1.0.0', setup, ...options });
const tool = (name, text = name) => pd.defineTool({
  name, description: `${name} tool`, parameters: ai.Type.Object({}), replay: 'safe',
  async execute() { return { content: [{ type: 'text', text }] }; }
});
function coreRegistry() {
  const registry = pd.createRegistry();
  registry.install(pd.defineExtension({ name: 'self-forming-native', tools: [tool('read'), tool('bash', 'core bash')] }));
  return registry;
}
function spy(registry) {
  const calls = [];
  return {
    calls,
    registry: {
      snapshot: () => registry.snapshot(),
      subscribe: (listener) => registry.subscribe(listener),
      install(extension) { calls.push(['install', extension.name]); return registry.install(extension); },
      uninstall(extension) { calls.push(['uninstall', extension.name]); return registry.uninstall(extension); }
    }
  };
}
const installedNames = (registry) => registry.snapshot().installed().map((extension) => extension.name);

test('ctx.pi is the host bag for built-in and installed plugins; plugin-client passes it', { skip }, async () => {
  const { pluginPi } = piModule;
  assert.ok(Object.isFrozen(pluginPi));
  for (const name of ['defineExtension', 'defineTool', 'section', 'hook', 'wrapTool', 'wrapSection', 'ToolTask', 'GenerationTask', 'Type']) assert.ok(pluginPi[name], name);
  assert.equal(pluginPi.defineTool, pd.defineTool, 'same library instance as the session');
  const runtime = runtimeModule.createPluginRuntime({ pi: pluginPi });
  let builtin, external;
  runtime.register(def('core-sample', (ctx) => { builtin = ctx.pi; }));
  const hash = 'b'.repeat(64);
  const bridge = { async call(method) {
    if (method === 'plugins.list') return { api: 1, plugins: [{ id: 'fixture', name: 'Fixture', version: '0.1.0', hash, enabled: true, state: 'installed', web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [], uses: [] }] };
    if (method === 'plugins.call') return { value: 7 };
    throw new Error(method);
  } };
  const fixture = await import(new URL('./plugin-agent-fixture.mjs', import.meta.url));
  const loaded = await clientModule.loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities: { plugins: true } },
    importModule: async () => ({ setup(ctx) { external = ctx.pi; return fixture.setup(ctx); } }) });
  assert.equal(loaded.plugins[0].name, 'Fixture');
  await runtime.start();
  assert.equal(builtin, pluginPi);
  assert.equal(external, pluginPi);
  const [entry] = runtime.contributions(KIND);
  assert.equal(entry.providerId, 'fixture');
  assert.equal(entry.value.tools[0].name, 'counter_value');
  const result = await entry.value.tools[0].execute({}, {}, {});
  assert.equal(result.content[0].text, '{"value":7}');
  await runtime.close();
});

test('runtime contributions install, reload in place and uninstall in an attached registry', { skip }, async () => {
  const runtime = runtimeModule.createPluginRuntime();
  let ctx;
  runtime.register(def('alpha', (c) => { ctx = c; }));
  await runtime.start();
  const adapter = agentModule.createAgentExtensions();
  const registry = coreRegistry();
  const detach = adapter.attach(registry);
  adapter.connect(runtime);
  assert.deepEqual(installedNames(registry), ['self-forming-native']);
  const v1 = pd.defineExtension({ name: 'alpha-tools', tools: [tool('alpha_one')] });
  const dispose = ctx.contribute(KIND, 'tools', v1);
  await tick();
  // Installed through the host compatibility wrap (legacy tool results, pi-durable 1.2): one stable wrapper per extension.
  assert.equal(registry.snapshot().extension('alpha-tools'), agentModule.compatibleExtension(v1));
  assert.deepEqual(runtime.list()[0].contributions, [{ kind: KIND, key: 'tools', order: 0, state: 'installed', position: 0, name: 'alpha-tools', tools: ['alpha_one'] }]);
  // Reload: the same extension name is replaced in place (running calls keep old code).
  dispose();
  const v2 = pd.defineExtension({ name: 'alpha-tools', tools: [tool('alpha_one', 'v2')] });
  ctx.contribute(KIND, 'tools', v2);
  await tick();
  assert.equal(registry.snapshot().extension('alpha-tools'), agentModule.compatibleExtension(v2));
  assert.deepEqual(installedNames(registry), ['self-forming-native', 'alpha-tools']);
  await runtime.stop('alpha');
  await tick();
  assert.deepEqual(installedNames(registry), ['self-forming-native']);
  detach();
  adapter.close();
});

test('tool collisions are rejected unless replaces is explicit; order is deterministic and diagnosed', { skip }, async () => {
  const errors = [];
  const runtime = runtimeModule.createPluginRuntime();
  const replacement = pd.defineExtension({ name: 'epsilon-tools', tools: [tool('bash', 'plugin bash')] });
  runtime.register(def('beta', (ctx) => { ctx.contribute(KIND, 'b', pd.defineExtension({ name: 'beta-tools', tools: [tool('read')] }), 10); }));
  runtime.register(def('gamma', (ctx) => { ctx.contribute(KIND, 'g', pd.defineExtension({ name: 'gamma-tools', tools: [tool('shared')], hooks: [pd.hook(pd.ToolTask, {})] }), 1); }));
  runtime.register(def('delta', (ctx) => {
    ctx.contribute(KIND, 'd', pd.defineExtension({ name: 'delta-tools', tools: [tool('shared')] }), 2);
    ctx.contribute(KIND, 'd2', pd.defineExtension({ name: 'self-forming-prompts', tools: [tool('other')] }), 3);
    ctx.contribute('example.panels', 'unrelated', {});
  }));
  runtime.register(def('epsilon', (ctx) => { ctx.contribute(KIND, 'e', { extension: replacement, replaces: ['bash'] }, 0); }));
  runtime.register(def('zeta', (ctx) => { ctx.contribute(KIND, 'z', { extension: pd.defineExtension({ name: 'zeta-tools', tools: [tool('bash')] }), replaces: ['bash'] }, 5); }));
  await runtime.start();
  const adapter = agentModule.createAgentExtensions({ onError: (error, details) => errors.push([details.id, error.message]) });
  const registry = coreRegistry();
  adapter.attach(registry);
  adapter.connect(runtime);
  assert.deepEqual(adapter.list().accepted.map((item) => [item.pluginId, item.name, item.position]), [
    ['gamma', 'gamma-tools', 0], ['epsilon', 'epsilon-tools', 1]
  ], 'plain contributions first, then explicit replacements; first in order wins a collision');
  const reasons = Object.fromEntries(adapter.list().rejected.map((item) => [item.key, item.reason]));
  assert.match(reasons.b, /Tool read is already provided by built-in self-forming-native; declare replaces/);
  assert.match(reasons.d, /Tool shared is already provided by plugin gamma/);
  assert.match(reasons.d2, /Extension name self-forming-prompts is already used/);
  assert.match(reasons.z, /Tool bash is already replaced by plugin epsilon/);
  assert.deepEqual(installedNames(registry), ['self-forming-native', 'gamma-tools', 'epsilon-tools']);
  const states = Object.fromEntries(runtime.list().map((record) => [record.id, record.state]));
  assert.deepEqual(states, { beta: 'active', gamma: 'active', delta: 'active', epsilon: 'active', zeta: 'active' }, 'only the contribution fails');
  const beta = runtime.list().find((record) => record.id === 'beta');
  assert.equal(beta.contributions[0].state, 'failed');
  const delta = runtime.list().find((record) => record.id === 'delta');
  assert.deepEqual(delta.contributions.map((item) => [item.kind, item.key, item.state]), [[KIND, 'd', 'failed'], [KIND, 'd2', 'failed'], ['example.panels', 'unrelated', undefined]]);
  assert.equal(errors.length, 4);
  // pi-durable composes the selection in order: the explicit replacement wins, never by accident.
  const models = ai.createModels();
  const harness = await pd.Harness.open(new pd.MemoryStorage(), { models, registry, settings: { get extensions() { return adapter.selection([registry.snapshot().extension('self-forming-native')], registry); } } }, chord.BACKGROUND_CONTEXT);
  const root = await harness.root(chord.BACKGROUND_CONTEXT);
  const agent = await root.agent(chord.BACKGROUND_CONTEXT);
  assert.deepEqual(agent.extensions.map((extension) => extension.name), ['self-forming-native', 'gamma-tools', 'epsilon-tools']);
  assert.equal(agent.tools.find((candidate) => candidate.name === 'bash'), agentModule.compatibleExtension(replacement).tools[0]);
  assert.deepEqual(agent.tools.map((candidate) => candidate.name).sort(), ['bash', 'read', 'shared']);
  await harness.close(chord.BACKGROUND_CONTEXT);
  await runtime.close();
});

test('readiness barrier: waits for composition at most the deadline, then reports and installs late', { skip }, async () => {
  const errors = [];
  const adapter = agentModule.createAgentExtensions({ timeoutMs: 60, onError: (error, details) => errors.push([details.phase, error.message]) });
  const registry = coreRegistry();
  adapter.attach(registry);
  const started = Date.now();
  await adapter.ready();
  assert.ok(Date.now() - started >= 50, 'waited for the deadline');
  assert.equal(adapter.status().late, true);
  assert.equal(errors[0][0], 'readiness');
  assert.equal(adapter.ready(), adapter.ready(), 'one page-level barrier');
  const runtime = runtimeModule.createPluginRuntime();
  runtime.register(def('late', (ctx) => { ctx.contribute(KIND, 'x', pd.defineExtension({ name: 'late-tools', tools: [tool('late_tool')] })); }));
  await runtime.start();
  adapter.connect(runtime);
  assert.deepEqual(installedNames(registry), ['self-forming-native', 'late-tools'], 'joins from the next request');
  assert.equal(adapter.status().late, false);
  // Composition that settles in time releases the barrier immediately; failure does too.
  const quick = agentModule.createAgentExtensions({ timeoutMs: 10_000 });
  const waiting = quick.ready();
  quick.unavailable(new Error('composition failed'));
  const at = Date.now();
  await waiting;
  assert.ok(Date.now() - at < 1000);
  assert.equal(quick.status().unavailable, 'composition failed');
  await runtime.close();
});

test('exclusions: stored as pi.agent extensions.remove; new plugins appear, excluded stay excluded', { skip }, () => {
  const { excludes, selectionChange } = agentModule;
  const off = selectionChange(undefined, ['counter-tools'], false);
  assert.deepEqual(off, { remove: [{ name: 'counter-tools' }] });
  const stored = { extensions: { remove: ['counter-tools'] } }; // what configure() persists (names)
  assert.equal(excludes(stored, ['counter-tools']), true);
  assert.equal(excludes(stored, ['newer-tools']), false, 'a newly installed plugin is selected by default');
  assert.equal(excludes(undefined, ['counter-tools']), false);
  assert.equal(selectionChange(stored, ['counter-tools'], true), null, 'back to the live host default');
  assert.deepEqual(selectionChange({ extensions: { add: ['x'], remove: ['a'] } }, ['b'], false), { add: [{ name: 'x' }], remove: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(selectionChange({ extensions: ['p', 'q'] }, ['q'], false), [{ name: 'p' }], 'an explicit list stays explicit');
});

test('describe/change map plugins to their extension names per conversation', { skip }, async () => {
  const runtime = runtimeModule.createPluginRuntime();
  runtime.register(def('counter', (ctx) => { ctx.contribute(KIND, 'k', pd.defineExtension({ name: 'counter-tools', tools: [tool('counter_value')] })); }));
  runtime.register(def('broken', () => { throw new Error('setup exploded'); }));
  runtime.register(def('core-example', () => {}));
  await runtime.start();
  const adapter = agentModule.createAgentExtensions({ onError() {} });
  adapter.connect(runtime, { installed: [{ id: 'broken', name: 'Broken', state: 'installed', registered: true }, { id: 'counter', name: 'Counter', registered: true }] });
  const rows = adapter.describe({ extensions: { remove: ['counter-tools'] } });
  assert.deepEqual(rows.map((row) => [row.id, row.name, row.toggle, row.enabled, row.state]), [
    ['counter', 'Counter', true, false, 'active'], ['broken', 'Broken', false, true, 'failed']
  ]);
  assert.match(rows[1].reason, /setup exploded/);
  assert.deepEqual(adapter.change({ extensions: { remove: ['counter-tools'] } }, 'counter', true), null);
  assert.throws(() => adapter.change(undefined, 'broken', false), /no agent tools/);
  await runtime.close();
});

test('sessions reattach without duplicate installs or leaked listeners; detaching keeps the runtime', { skip }, async () => {
  const runtime = runtimeModule.createPluginRuntime();
  let ctx;
  runtime.register(def('counter', (c) => { ctx = c; c.contribute(KIND, 'k', pd.defineExtension({ name: 'counter-tools', tools: [tool('counter_value')] })); }));
  await runtime.start();
  let subscriptions = 0;
  const counted = { ...runtime, subscribe(listener) { subscriptions++; return runtime.subscribe(listener); } };
  const adapter = agentModule.createAgentExtensions();
  adapter.connect(counted);
  const first = spy(coreRegistry());
  const detachFirst = adapter.attach(first.registry);
  assert.equal(adapter.attach(first.registry), detachFirst, 'attaching twice is one attachment');
  assert.deepEqual(first.calls, [['install', 'counter-tools']]);
  detachFirst(); detachFirst();
  const second = spy(coreRegistry());
  const detachSecond = adapter.attach(second.registry);
  assert.equal(adapter.list().registries, 1);
  assert.deepEqual(second.calls, [['install', 'counter-tools']]);
  ctx.contribute(KIND, 'extra', pd.defineExtension({ name: 'counter-extra', tools: [tool('counter_reset')] }));
  await tick();
  ctx.contribute('example.panels', 'noise', {});
  await tick();
  assert.deepEqual(first.calls, [['install', 'counter-tools']], 'a closed session registry is left alone');
  assert.deepEqual(second.calls, [['install', 'counter-tools'], ['install', 'counter-extra']], 'no duplicate installs');
  detachSecond();
  assert.equal(adapter.list().registries, 0);
  assert.equal(subscriptions, 1, 'one runtime subscription per page');
  assert.equal(runtime.list()[0].state, 'active', 'closing sessions never stops plugins');
  await runtime.close();
});

test('fork-safe: no plugin loading capability means no wait; built-in definitions contribute without plugin-client', { skip }, async () => {
  const bootstrap = await app.load('plugin-bootstrap.js');
  const reports = [];
  const adapter = agentModule.createAgentExtensions({ timeoutMs: 10_000, onError: (error, details) => reports.push(details.phase) });
  const waiting = adapter.ready();
  const at = Date.now();
  // A host without capabilities.plugins (e.g. a fork/store build): installed loading is skipped.
  const composition = await bootstrap.startPluginComposition({
    bridge: { call: async (method) => { throw new Error(`unexpected ${method}`); } }, hostInfo: { capabilities: {} },
    openExecution: () => { throw new Error('no execution'); }, onError() {}, agentExtensions: adapter
  });
  await waiting;
  assert.ok(Date.now() - at < 2000, 'the barrier is released by composition, not the deadline');
  assert.equal(adapter.status().connected, true);
  assert.deepEqual(composition.installed, { available: false, plugins: [] });
  assert.deepEqual(reports, []);
  await composition.runtime.close();
  // The fixture as a built-in: without a native facet it offers nothing and does not fail.
  const fixture = await import(new URL('./plugin-agent-fixture.mjs', import.meta.url));
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  runtime.register(def('counter', fixture.setup));
  runtime.register(def('counter-native', (ctx) => fixture.setup({ ...ctx, native: { call: async () => 1 } })));
  await runtime.start();
  const builtin = agentModule.createAgentExtensions();
  builtin.connect(runtime);
  assert.deepEqual(runtime.list().map((record) => record.state), ['active', 'active']);
  assert.deepEqual(builtin.list().accepted.map((item) => item.pluginId), ['counter-native']);
  await runtime.close();
});
