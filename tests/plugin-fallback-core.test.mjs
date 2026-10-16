import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { toolsFor } from './plugin-a2-support.mjs';
import { CONFIGURATIONS, promptsFor } from './plugin-a3-support.mjs';

// Core fallback (docs/plugins.md §9a, A3 known gap): when the page runtime's copy of an
// ESSENTIAL core contribution cannot be used, every session keeps (or gets back) the
// bundled copy, so tools and prompt stay exactly the A2/A3 snapshots, and the failure
// is reported as "... (using built-in copy)". Real session.js / agent-extensions.js /
// plugin-runtime.js / core-agent-plugins.js with the bundled pi-durable library,
// mocked hosts. Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const TOOLS = JSON.parse(await readFile(new URL('./plugin-a2-tools.snapshot.json', import.meta.url), 'utf8'));
const PROMPTS = JSON.parse(await readFile(new URL('./plugin-a3-prompts.snapshot.json', import.meta.url), 'utf8'));
let app, deps, runtimeModule, agentModule, coreModule, piModule, settingsModule, builders;
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
  settingsModule = await app.load('builtin/core-plugin-management/web/plugin-settings.js');
  builders = await coreModule.loadCoreBuilders();
});
after(async () => { await app?.remove(); });

/** A page whose core plugins build from the given builders (the runtime copy only). */
async function page(configuration, { loadBuilders } = {}) {
  const { hostInfo } = CONFIGURATIONS[configuration]();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo, loadBuilders: loadBuilders ?? (async () => builders) })) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const agentExtensions = agentModule.createAgentExtensions({ onError: (error, details) => errors.push([details.phase, details.id, error.message]) });
  agentExtensions.connect(runtime);
  return { runtime, agentExtensions, errors };
}
/** Tools and prompt of the native configuration equal the snapshots (fresh sessions). */
async function assertSnapshots(agentExtensions, label, { name = 'native', onOpen } = {}) {
  assert.deepEqual(await toolsFor(deps, name, { agentExtensions, onOpen }), TOOLS[`${name}/default`], `${label}: tools`);
  assert.deepEqual(await promptsFor(deps, name, { agentExtensions, onOpen }), PROMPTS[name], `${label}: prompt`);
}
const fallbackOf = (agentExtensions, id) => agentExtensions.list().fallbacks.find((item) => item.pluginId === id)?.reason;

test('create(host) throws: the session builds the bundled copy instead; reported once with "(using built-in copy)"', { skip, timeout: 120000 }, async () => {
  const broken = {
    ...builders,
    fileAndShellTools: () => { throw new Error('file tools exploded'); },
    createPromptExtension: () => { throw new Error('prompt builder exploded'); }
  };
  const { runtime, agentExtensions, errors } = await page('native', { loadBuilders: async () => broken });
  assert.ok(runtime.list().every((record) => record.state === 'active'), 'setup itself succeeded');
  await assertSnapshots(agentExtensions, 'create throws');
  assert.equal(fallbackOf(agentExtensions, 'core-tools'), 'file tools exploded');
  assert.equal(fallbackOf(agentExtensions, 'core-prompt'), 'prompt builder exploded');
  // The runtime contribution is diagnosed failed (Settings → Plugins shows it), the rest installed.
  const diagnostic = (id) => runtime.list().find((record) => record.id === id).contributions.find((entry) => entry.kind === 'agent.extensions');
  assert.deepEqual([diagnostic('core-tools').state, diagnostic('core-tools').reason], ['failed', 'file tools exploded (using built-in copy)']);
  assert.equal(diagnostic('core-self-update').state, 'installed');
  const created = errors.filter(([phase]) => phase === 'create');
  assert.deepEqual(created.map(([, id, text]) => [id, text]).sort(), [['core-prompt', 'prompt builder exploded (using built-in copy)'], ['core-tools', 'file tools exploded (using built-in copy)']], 'each failure reported once over several sessions');
  await runtime.close();
});

test('create(host) returns invalid tools or sections: bundled copy, same tools and prompt', { skip, timeout: 120000 }, async () => {
  const invalid = {
    ...builders,
    // A tool without execute() and a section without render().
    selfUpdateTools: () => [{ name: 'app_update' }],
    createPromptExtension: (options) => {
      const real = builders.createPromptExtension(options);
      return { ...real, PromptExtension: { ...real.PromptExtension, sections: real.PromptExtension.sections.map(({ key }) => ({ key })) } };
    }
  };
  const { runtime, agentExtensions } = await page('native', { loadBuilders: async () => invalid });
  await assertSnapshots(agentExtensions, 'invalid parts');
  assert.match(fallbackOf(agentExtensions, 'core-self-update'), /each tool needs a name and execute\(\)/);
  assert.match(fallbackOf(agentExtensions, 'core-prompt'), /section device needs render\(\)/);
  // Undeclared tools are invalid too.
  const extra = { ...builders, workspaceTools: (workspace) => [...builders.workspaceTools(workspace), { name: 'surprise', async execute() { return { content: [] }; } }] };
  const second = await page('native', { loadBuilders: async () => extra });
  await assertSnapshots(second.agentExtensions, 'undeclared tool');
  assert.match(fallbackOf(second.agentExtensions, 'core-workspace-tools'), /created tool surprise was not declared/);
  await runtime.close();
  await second.runtime.close();
});

test('plugin setup fails: every failed core plugin is served by its bundled copy (native and browser)', { skip, timeout: 120000 }, async () => {
  const { runtime, agentExtensions } = await page('native', { loadBuilders: async () => { throw new Error('builders unavailable'); } });
  assert.ok(runtime.list().every((record) => record.state === 'failed'));
  await assertSnapshots(agentExtensions, 'setup failed');
  await assertSnapshots(agentExtensions, 'setup failed (browser)', { name: 'browser' });
  assert.equal(fallbackOf(agentExtensions, 'core-prompt'), 'builders unavailable');
  assert.equal(fallbackOf(agentExtensions, 'core-skills'), 'builders unavailable');
  await runtime.close();
});

test('plugin stopped unexpectedly, before or while a session is open: bundled copy, same tools and prompt', { skip, timeout: 120000 }, async () => {
  const before = await page('native');
  await before.runtime.stop('core-tools');
  await before.runtime.stop('core-prompt');
  await assertSnapshots(before.agentExtensions, 'stopped before open');
  assert.equal(fallbackOf(before.agentExtensions, 'core-tools'), 'Stopped unexpectedly');
  assert.equal(fallbackOf(before.agentExtensions, 'core-prompt'), 'Stopped unexpectedly');
  await before.runtime.close();
  // Live: the session opened on the healthy runtime copies; they stop before the request.
  const live = await page('native');
  let sources;
  const stopLive = async () => {
    await live.runtime.stop('core-self-update');
    await live.runtime.stop('core-skills');
    await new Promise((resolve) => setTimeout(resolve, 0));
    sources = Object.fromEntries(live.agentExtensions.list().accepted.map((item) => [item.pluginId, item.source]));
  };
  assert.deepEqual(await toolsFor(deps, 'native', { agentExtensions: live.agentExtensions, onOpen: stopLive }), TOOLS['native/default']);
  assert.equal(sources['core-self-update'], 'bundled');
  assert.equal(sources['core-tools'], 'runtime', 'healthy core plugins keep their runtime copy');
  assert.deepEqual(await promptsFor(deps, 'native', { agentExtensions: live.agentExtensions }), PROMPTS.native);
  await live.runtime.close();
});

test('runtime closes while a session is open: everything is handed back to the bundled copies', { skip, timeout: 120000 }, async () => {
  const { runtime, agentExtensions } = await page('native');
  let counts;
  const close = async () => {
    const connected = agentExtensions.list().accepted.map((item) => item.pluginId);
    assert.ok(connected.length >= 6);
    await runtime.close();
    const now = agentExtensions.list();
    counts = [connected, now.accepted.map((item) => item.pluginId), now.accepted.every((item) => item.source === 'bundled')];
  };
  assert.deepEqual(await toolsFor(deps, 'native', { agentExtensions, onOpen: close }), TOOLS['native/default']);
  assert.deepEqual(counts[1], counts[0], 'the same core contributions, none lost');
  assert.equal(counts[2], true);
  assert.deepEqual(await promptsFor(deps, 'native', { agentExtensions }), PROMPTS.native, 'closed runtime: prompt');
  assert.ok(agentExtensions.list().fallbacks.every((item) => item.reason === 'Stopped unexpectedly'));
  // Essential plugins stay non-deselectable and cannot be disabled app-wide (no such API).
  assert.throws(() => agentExtensions.change(undefined, 'core-tools', false), /stay on in every conversation/);
});

// Settings → Plugins (mocked DOM, as in plugin-overview-settings.test.mjs).
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.id = ''; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  focus() {}
}
const all = (node) => [node, ...(node.children ?? []).flatMap((child) => child instanceof Node ? all(child) : [])];
const text = (node) => node instanceof Node ? node.textContent + node.children.map(text).join('') : node.text ?? '';
const IDS = ['plugin-settings', 'plugin-group-conversation', 'plugin-list', 'plugin-group-builtin', 'plugin-builtin-count', 'plugin-builtin', 'plugin-group-installed', 'plugin-installed', 'plugin-status', 'chat-settings'];

test('Settings → Plugins: a core plugin on its bundled copy says "Failed: … (using built-in copy)"', { skip, timeout: 60000 }, async () => {
  const fixed = Object.fromEntries(IDS.map((id) => [id, Object.assign(new Node('div'), { id })]));
  globalThis.document = { activeElement: null, createElement: (tag) => new Node(tag), getElementById: (id) => fixed[id] ?? null };
  try {
    const broken = { ...builders, fileAndShellTools: () => { throw new Error('file tools exploded'); } };
    const { runtime, agentExtensions } = await page('native', { loadBuilders: async () => broken });
    await toolsFor(deps, 'native', { agentExtensions, async onOpen(opened) {
      const settings = settingsModule.initPluginSettings({ agentExtensions, getSession: () => opened });
      await settings.connect({ runtime });
      settings.update();
      const rows = all(fixed['plugin-builtin']).filter((node) => node.className === 'plugin-item'); // rows sit inside bundle rows
      const row = rows.find((item) => all(item).some((node) => node.className === 'plugin-name' && node.textContent === 'File and shell tools'));
      assert.match(text(row), /Failed: file tools exploded \(using built-in copy\)$/);
      assert.equal(all(row).find((node) => node.tag === 'strong').textContent, 'Failed');
      assert.match(fixed['plugin-builtin-count'].textContent, /1 not active/);
      await runtime.stop('core-prompt');
      settings.update();
      const prompt = all(fixed['plugin-builtin']).find((item) => item.className === 'plugin-item' && all(item).some((node) => node.className === 'plugin-name' && node.textContent === 'Prompt sections'));
      assert.equal(text(prompt), 'Prompt sectionsbuilt-inFailed: Stopped unexpectedly (using built-in copy)');
      assert.deepEqual(opened.plugins().map((row) => [row.id, row.essential, row.toggle]), [['core-prompt', true, false], ['core-tools', true, false]], 'shown as fixed rows, never switches');
    } });
    await runtime.close();
  } finally {
    delete globalThis.document;
  }
});
