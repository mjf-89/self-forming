import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, HELPERS, promptsFor, subagentRunFor } from './plugin-a3-support.mjs';
import { capture } from './plugin-a3-capture.mjs';

// Track A step A3: prompt sections are the essential built-in plugin core-prompt
// (extension self-forming-prompts, doc kind self-forming.prompt-sections; both
// permanent). Real session.js / agent-extensions.js / plugin-runtime.js with the bundled
// pi-durable library, mocked hosts. plugin-a3-prompts.snapshot.json was captured from
// the pre-A3 construction (tests/plugin-a3-capture.mjs run against the old session.js,
// which installed self-forming-prompts itself) and regenerated on purpose for A3b,
// which only ADDED the core-skills section "skills" (after the core sections) where
// skills exist; every other section key, text hash and length stayed identical.
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const SNAPSHOT = JSON.parse(await readFile(new URL('./plugin-a3-prompts.snapshot.json', import.meta.url), 'utf8'));
let app, deps, runtimeModule, agentModule, coreModule, piModule, builtinsModule, settingsModule;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    prompts: await app.load('builtin/core-prompt/web/prompt-sections.js')
  };
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  coreModule = await app.load('core-agent-plugins.js');
  piModule = await app.load('plugin-pi.js');
  builtinsModule = await app.load('plugin-builtins.js');
  settingsModule = await app.load('builtin/core-plugin-management/web/plugin-settings.js');
});
after(async () => { await app?.remove(); });

const KIND = 'agent.extensions';
const CORE_KEYS = ['device', 'app', 'self-rebuild', 'subagents', 'servers', 'agents-guide', 'transcript'];
const keys = (sections) => sections.map(([key]) => key);
/** A page: runtime with the built-in core agent plugins (+ extra definitions), connected adapter. */
async function page(configuration, extra = [], { loadBuilders, connect = true } = {}) {
  const { hostInfo } = CONFIGURATIONS[configuration]();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo, ...(loadBuilders ? { loadBuilders } : {}) })) runtime.register(definition);
  for (const definition of extra) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const agentExtensions = agentModule.createAgentExtensions({ onError: (error, details) => errors.push([details.phase, error.message]) });
  if (connect) agentExtensions.connect(runtime);
  return { runtime, agentExtensions, errors, hostInfo };
}
/**
 * Fixture plugin contributing one prompt section through agent.extensions, built with
 * the host's pi-durable (ctx.pi.section). sessionBound: the {name, sections, create}
 * form; replaces: explicit replacement of an existing key.
 */
function sectionPlugin(id, key, text, { order = 0, replaces, sessionBound = false, tool } = {}) {
  return {
    id, version: '1.0.0',
    setup(ctx) {
      const { defineExtension, defineTool, section, Type } = ctx.pi;
      const part = { sections: [section(key, () => text)] };
      if (tool) part.tools = [defineTool({ name: tool, description: 'Fixture.', parameters: Type.Object({}), replay: 'safe', async execute() { return { content: [{ type: 'text', text: 'x' }] }; } })];
      const name = `${id}-ext`;
      const value = sessionBound ? { name, sections: [key], ...(tool ? { tools: [tool] } : {}), ...(replaces ? { replaces } : {}), create: () => part }
        : replaces ? { extension: defineExtension({ name, ...part }), replaces } : defineExtension({ name, ...part });
      ctx.contribute(KIND, id, value, order);
    }
  };
}

test('rendered system prompts are identical to the pre-A3 construction (bundled core-prompt; native, browser, offline)', { skip, timeout: 300000 }, async () => {
  const now = await capture(deps);
  assert.deepEqual(Object.keys(now), Object.keys(SNAPSHOT));
  for (const key of Object.keys(SNAPSHOT)) assert.deepEqual(now[key], SNAPSHOT[key], key);
});

test('the same prompts when core-prompt comes from a connected page composition', { skip, timeout: 300000 }, async () => {
  for (const name of Object.keys(CONFIGURATIONS)) {
    const { runtime, agentExtensions, errors } = await page(name);
    const record = runtime.list().find((item) => item.id === 'core-prompt');
    assert.deepEqual([record.state, record.essential], ['active', true], name);
    let sources;
    const result = await promptsFor(deps, name, { agentExtensions, onOpen() { sources = agentExtensions.list().accepted.map((item) => [item.pluginId, item.source]); } });
    assert.deepEqual(result, SNAPSHOT[name], `${name} via composition`);
    assert.deepEqual(sources[0], ['core-prompt', 'runtime'], 'the runtime copy is used');
    assert.ok(sources.every(([, source]) => source === 'runtime'));
    if (name === 'native' || name === 'browser') {
      for (const key of Object.keys(SNAPSHOT).filter((item) => item.startsWith(`${name}/subagentRun:`))) {
        const context = key.split(':')[1] === 'default' ? undefined : key.split(':')[1].split('+');
        assert.deepEqual(await subagentRunFor(deps, name, { context, agentExtensions }), SNAPSHOT[key], `${key} via composition`);
      }
    }
    assert.deepEqual(errors, []);
    // Diagnostics: the contribution carries its section keys (Settings → Plugins shows them).
    const diagnostic = runtime.list().find((item) => item.id === 'core-prompt').contributions[0];
    assert.deepEqual([diagnostic.kind, diagnostic.state, diagnostic.name, diagnostic.sections, diagnostic.tools], [KIND, 'installed', 'self-forming-prompts', CORE_KEYS, []]);
    await runtime.close();
  }
});

test('composition failure, slowness, a failed core-prompt setup and late composition keep the same prompt', { skip, timeout: 120000 }, async () => {
  // Failed before the session opened.
  const failed = agentModule.createAgentExtensions({ onError() {} });
  failed.unavailable(new Error('composition exploded'));
  assert.deepEqual(await promptsFor(deps, 'native', { agentExtensions: failed }), SNAPSHOT.native);
  // Never arrives: the prompt is installed at open, before the barrier.
  const slow = agentModule.createAgentExtensions({ timeoutMs: 150, onError() {} });
  let atOpen;
  assert.deepEqual(await promptsFor(deps, 'browser', { agentExtensions: slow, onOpen() { atOpen = slow.list(); } }), SNAPSHOT.browser);
  assert.equal(atOpen.settled, false);
  assert.deepEqual(atOpen.accepted[0], { key: 'bundled:self-forming-prompts/core-prompt', pluginId: 'core-prompt', name: 'self-forming-prompts', tools: [], sections: CORE_KEYS, replaces: [], position: 0, essential: true, source: 'bundled' });
  // The runtime has core-prompt but its setup failed: the bundled copy stands in.
  const broken = await page('native', [], { loadBuilders: async () => { throw new Error('builders unavailable'); } });
  assert.equal(broken.runtime.list().find((item) => item.id === 'core-prompt').state, 'failed');
  assert.deepEqual(await promptsFor(deps, 'native', { agentExtensions: broken.agentExtensions }), SNAPSHOT.native);
  assert.deepEqual(await promptsFor(deps, 'offline', { agentExtensions: broken.agentExtensions }), SNAPSHOT.offline);
  await broken.runtime.close();
  // Late: composition connects after the session opened; the runtime copy replaces the
  // bundled one in place (same name, same keys, same text and position).
  const late = agentModule.createAgentExtensions({ timeoutMs: 10_000, onError() {} });
  let runtime;
  const result = await promptsFor(deps, 'native', { agentExtensions: late, async onOpen() {
    assert.ok(late.list().accepted.every((item) => item.source === 'bundled'));
    ({ runtime } = await page('native', [], { connect: false }));
    late.connect(runtime);
    assert.ok(late.list().accepted.every((item) => item.source === 'runtime'));
  } });
  assert.deepEqual(result, SNAPSHOT.native);
  await runtime.close();
  // Core fallback (was: a stopped core plugin is respected): a stopped or closed
  // runtime hands core-prompt back to its bundled copy and says so.
  assert.equal(runtime.list().find((item) => item.id === 'core-prompt').state, 'stopped');
  assert.equal(late.list().accepted.find((item) => item.pluginId === 'core-prompt')?.source, 'bundled');
  assert.deepEqual(late.list().fallbacks.find((item) => item.pluginId === 'core-prompt'), { pluginId: 'core-prompt', reason: 'Stopped unexpectedly' });
});

test('core-prompt is essential and named; a fork can still leave it out by its row', { skip }, async () => {
  const { runtime, agentExtensions } = await page('native');
  assert.deepEqual(agentExtensions.describe(undefined), [], 'healthy core plugins are not per-conversation choices');
  assert.throws(() => agentExtensions.change(undefined, 'core-prompt', false), /stay on in every conversation/);
  assert.equal(settingsModule.builtinName('core-prompt'), 'Prompt sections');
  // Needs no host capability (every host, also a fork without shell, gets a prompt).
  for (const hostInfo of [undefined, {}, { platform: 'browser', capabilities: {} }]) {
    const definition = coreModule.createCoreAgentPlugins({ hostInfo }).find((item) => item.id === 'core-prompt');
    assert.equal(definition.unavailable, undefined);
    assert.equal(definition.essential, true);
  }
  const withTools = builtinsModule.createBuiltinPlugins({ openExecution() {}, agentTools: { hostInfo: {} } }).map((definition) => definition.id);
  // A4: core-servers is the last row; A5: core-subagents comes right before it.
  assert.deepEqual(withTools.slice(-8), ['core-prompt', 'core-skills', 'core-workspace-tools', 'core-tools', 'core-self-update', 'core-plugin-management', 'core-subagents', 'core-servers']);
  const rows = coreModule.CORE_AGENT_PLUGINS.filter((row) => row.id !== 'core-prompt');
  assert.ok(!coreModule.createCoreAgentPlugins({ rows }).some((definition) => definition.id === 'core-prompt'));
  // The section keys declared statically are exactly what prompt-sections.js renders.
  const { PromptExtension } = deps.prompts.createPromptExtension({});
  assert.deepEqual(PromptExtension.sections.map((item) => item.key), [...coreModule.PROMPT_SECTION_KEYS]);
  assert.equal(PromptExtension.name, coreModule.PROMPT_EXTENSION);
  await toolsOpen(agentExtensions, async (opened) => {
    await assert.rejects(opened.setPluginEnabled('core-prompt', false), /stay on in every conversation/);
  });
  await runtime.close();
});
async function toolsOpen(agentExtensions, fn) {
  return promptsFor(deps, 'native', { agentExtensions, onOpen: fn, helpers: {} });
}

test('plugin sections: after the core sections in composition order, before instructions; session-bound too', { skip, timeout: 120000 }, async () => {
  const plugins = [
    sectionPlugin('weather', 'weather', 'It is sunny.', { order: 5 }),
    sectionPlugin('notes', 'notes', 'Notes live in notes/.', { order: 1, sessionBound: true, tool: 'notes_tool' })
  ];
  const { runtime, agentExtensions, errors } = await page('native', plugins);
  assert.deepEqual(errors, []);
  assert.deepEqual(agentExtensions.list().accepted.filter((item) => !item.essential).map((item) => [item.pluginId, item.sections]), [['notes', ['notes']], ['weather', ['weather']]]);
  const result = await promptsFor(deps, 'native', { agentExtensions, text: true });
  const core = SNAPSHOT.native;
  assert.deepEqual(keys(result.main), [...keys(core.main), 'notes', 'weather'], 'core sections first, then plugins in composition order');
  assert.match(Object.fromEntries(result.main).weather, /It is sunny\./);
  // Plugin sections follow the conversation's plugin (extension) selection, not the core
  // section selection: helpers that inherit the plugins get them, before instructions.
  // (A3b: the core skills section comes right after the core sections.)
  assert.deepEqual(keys(result.subagentDefault), ['device', 'skills', 'notes', 'weather', 'instructions']);
  assert.deepEqual(keys(result.oldHelper), ['notes', 'weather', 'instructions']);
  // The core sections themselves are unchanged.
  const hashed = await promptsFor(deps, 'native', { agentExtensions });
  for (const scenario of Object.keys(core)) assert.deepEqual(hashed[scenario].filter(([key]) => !['notes', 'weather'].includes(key)), core[scenario], scenario);
  // Settings → Plugins rows (runtime registration order) say what each plugin adds.
  const rows = agentExtensions.describe(undefined);
  assert.deepEqual(rows.map((row) => [row.id, row.toggle, row.tools, row.sections]), [['weather', true, [], ['weather']], ['notes', true, ['notes_tool'], ['notes']]]);
  await runtime.close();
});

test('excluding a plugin in a conversation removes its sections there, and from subagents that inherit it', { skip, timeout: 120000 }, async () => {
  const { runtime, agentExtensions } = await page('native', [sectionPlugin('weather', 'weather', 'It is sunny.')]);
  const result = await promptsFor(deps, 'native', { agentExtensions, async onOpen(opened) { await opened.setPluginEnabled('weather', false); } });
  assert.deepEqual(result.main, SNAPSHOT.native.main, 'excluded: exactly the core prompt');
  const included = await subagentRunFor(deps, 'native', { context: ['device'], agentExtensions });
  assert.deepEqual(included.child.tags, ['device', 'skills', 'weather', 'instructions']);
  const excluded = await subagentRunFor(deps, 'native', { context: ['device'], agentExtensions, async onOpen(opened) { await opened.setPluginEnabled('weather', false); } });
  assert.deepEqual(excluded.child.tags, ['device', 'skills', 'instructions'], 'a subagent keeps its owner\'s exclusions');
  assert.deepEqual(excluded.parent.tags, SNAPSHOT['native/subagentRun:default'].parent.tags);
  await runtime.close();
});

test('collisions: core section keys need an explicit replaces; replacements keep place and per-conversation selection', { skip, timeout: 120000 }, async () => {
  const plugins = [
    ...CORE_KEYS.map((key, index) => sectionPlugin(`clash-${index}`, key, `stolen ${key}`, { order: -100 })),
    sectionPlugin('device-plus', 'device', 'A plugin\'s device text.', { replaces: ['device'] }),
    sectionPlugin('device-again', 'device', 'Second replacement.', { replaces: ['device'], order: 10 }),
    sectionPlugin('wrong-replaces', 'mine', 'x', { replaces: ['app'] }),
    sectionPlugin('first', 'shared', 'first'),
    sectionPlugin('second', 'shared', 'second', { order: 1 })
  ];
  const { runtime, agentExtensions, errors } = await page('native', plugins);
  const reasons = Object.fromEntries(agentExtensions.list().rejected.map((item) => [item.pluginId, item.reason]));
  CORE_KEYS.forEach((key, index) => assert.match(reasons[`clash-${index}`], new RegExp(`Prompt section ${key} is already provided by core plugin core-prompt; declare replaces`)));
  assert.equal(reasons['device-plus'], undefined);
  assert.match(reasons['device-again'], /Prompt section device is already replaced by plugin device-plus/);
  assert.match(reasons['wrong-replaces'], /declares replaces app but contributes no tool or section of that name/);
  assert.match(reasons.second, /Prompt section shared is already provided by plugin first; declare replaces/);
  assert.equal(errors.length, Object.keys(reasons).length, 'each rejection is reported');
  const helpers = { ...HELPERS, noDevice: { change: HELPERS.subagentTranscript.change, prompt: { sections: ['transcript'], transcript: 'User: hi' } } };
  const result = await promptsFor(deps, 'native', { agentExtensions, helpers, text: true });
  const core = await promptsFor(deps, 'native', { text: true, helpers });
  // The replacement takes the core section's place (first) and text; the rest is unchanged.
  assert.deepEqual(keys(result.main), [...keys(core.main), 'shared']);
  assert.match(result.main[0][1], /A plugin's device text\./);
  assert.deepEqual(result.main.slice(1, -1), core.main.slice(1));
  assert.match(result.subagentDefault[0][1], /A plugin's device text\./, 'selected for this helper: the replacement renders');
  // Not selected for this conversation: the replacement is gated like the core section.
  assert.deepEqual(keys(result.noDevice), ['transcript', 'skills', 'shared', 'instructions']);
  assert.deepEqual(keys(result.oldHelper), ['shared', 'instructions'], 'old helpers (instructions, null selection) get no replaced core section');
  await runtime.close();
});

test('an explicit replacement can be session-bound; replaces must name a tool or section the contribution provides', { skip, timeout: 60000 }, async () => {
  const plugins = [sectionPlugin('servers-doc', 'servers', 'Use the server panel.', { replaces: ['servers'], sessionBound: true })];
  const { runtime, agentExtensions, errors } = await page('native', plugins);
  assert.deepEqual(errors, []);
  const result = await promptsFor(deps, 'native', { agentExtensions, text: true, helpers: { subagentSections: HELPERS.subagentSections } });
  const sections = Object.fromEntries(result.main);
  assert.deepEqual(keys(result.main), keys(SNAPSHOT.native.main));
  assert.match(sections.servers, /Use the server panel\./);
  assert.match(Object.fromEntries(result.subagentSections).servers, /Use the server panel\./);
  await runtime.close();
  // A session-bound declaration with replaces naming neither a tool nor a section is refused.
  const bad = await page('native', [{ id: 'bad', version: '1.0.0', setup(ctx) { ctx.contribute(KIND, 'bad', { name: 'bad-ext', sections: ['bad'], replaces: ['bash'], create: () => null }); } }]);
  assert.match(bad.agentExtensions.list().rejected[0].reason, /declares replaces bash but contributes no tool or section of that name/);
  await bad.runtime.close();
});

// Settings → Plugins overview (mocked DOM, as in plugin-overview-settings.test.mjs).
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.id = ''; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  focus() { globalThis.document.activeElement = this; }
}
const all = (node) => [node, ...(node.children ?? []).flatMap((child) => child instanceof Node ? all(child) : [])];
const text = (node) => node instanceof Node ? node.textContent + node.children.map(text).join('') : node.text ?? '';
const IDS = ['plugin-settings', 'plugin-group-conversation', 'plugin-list', 'plugin-group-builtin', 'plugin-builtin-count', 'plugin-builtin', 'plugin-group-installed', 'plugin-installed', 'plugin-status', 'chat-settings'];

test('Settings → Plugins: core-prompt is a built-in "Prompt sections" row with its section keys; section-only plugins say so', { skip }, async () => {
  const fixed = Object.fromEntries(IDS.map((id) => [id, Object.assign(new Node('div'), { id })]));
  globalThis.document = { activeElement: null, createElement: (tag) => new Node(tag), getElementById: (id) => fixed[id] ?? Object.values(fixed).flatMap(all).find((node) => node.id === id) ?? null };
  const { runtime, agentExtensions } = await page('native', [sectionPlugin('weather', 'weather', 'It is sunny.')]);
  const session = { snapshot: { conversation: { id: 1 }, owned: false }, plugins: () => agentExtensions.describe(undefined), setPluginEnabled: async () => {} };
  const settings = settingsModule.initPluginSettings({ agentExtensions, getSession: () => session });
  await settings.connect({ runtime, installed: { plugins: [{ id: 'weather', name: 'Weather', state: 'active' }] } });
  const builtin = all(fixed['plugin-builtin']).filter((node) => node.className === 'plugin-item'); // rows sit inside bundle rows
  const prompt = builtin.find((row) => all(row).some((node) => node.className === 'plugin-name' && node.textContent === 'Prompt sections'));
  assert.ok(prompt, 'Prompt sections is listed under Built-in');
  assert.equal(text(prompt), 'Prompt sectionsbuilt-inActive · prompt sections: device, app, self-rebuild, subagents, servers, agents-guide, transcript');
  assert.ok(builtin.every((row) => !all(row).some((node) => node.className === 'plugin-name' && /weather/i.test(node.textContent))), 'installed plugins are not built-ins');
  const weather = fixed['plugin-list'].children.find((child) => child instanceof Node && all(child).some((node) => node.id === 'plugin-toggle-weather'));
  assert.equal(all(weather).find((node) => node.className === 'plugin-meta').textContent, '1 prompt section');
  await runtime.close();
  delete globalThis.document;
});
