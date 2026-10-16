import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, promptsFor, subagentRunFor } from './plugin-a3-support.mjs';
import { toolsFor } from './plugin-a2-support.mjs';

// A3b: Agent Skills in plugins, through the real session.js / agent-extensions.js /
// plugin-runtime.js / core-agent-plugins.js / plugin-skills.js with the bundled
// pi-durable library and mocked hosts (the A2 memory execution environment; the
// served plugin snapshot is a mocked fetch). Covers the skills section text, the app's
// own skills, packaged/inline/path skills, per-conversation exclusion (also for
// subagents), collisions and replacement, and Settings → Plugins. Not on-device
// verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
let app, deps, runtimeModule, agentModule, coreModule, piModule, settingsModule, skillsModule;
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
  skillsModule = await app.load('plugin-skills.js');
});
after(async () => { await app?.remove(); });

const KIND = 'agent.skills';
const hash = (c) => c.repeat(64);
const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
// What the Android host would serve from the installed snapshots (web/skills/**).
const SERVED = {
  [`/assets/web/plugins/notes/${hash('a')}/web/skills/notes/SKILL.md`]: SKILL('notes', 'Keep notes in notes/. Use when the user asks to remember something.'),
  [`/assets/web/plugins/notes/${hash('a')}/web/skills/notes/scripts/add.sh`]: 'echo note\n'
};
const INSTALLED = ['notes', 'weather', 'clash', 'rebuild-plus', 'broken'].map((id, index) => ({ id, name: id, hash: hash('abcde'[index]), state: 'active', web: true, registered: true }));
function plugin(id, setup) { return { id, version: '1.0.0', setup }; }
const PLUGINS = {
  notes: plugin('notes', (ctx) => { ctx.contribute(KIND, 'notes', { name: 'notes', description: 'Keep notes in notes/. Use when the user asks to remember something.', files: ['SKILL.md', 'scripts/add.sh'] }); }),
  weather: plugin('weather', (ctx) => {
    const { defineExtension, defineTool, Type } = ctx.pi;
    ctx.contribute('agent.extensions', 'weather', defineExtension({ name: 'weather-ext', tools: [defineTool({ name: 'weather_now', description: 'Weather.', parameters: Type.Object({}), replay: 'safe', async execute() { return { content: [{ type: 'text', text: 'sunny' }] }; } })] }));
    ctx.contribute(KIND, 'forecast', { name: 'forecast', description: 'Read forecasts.', contents: { 'SKILL.md': SKILL('forecast', 'Read forecasts.') } });
  }),
  clash: plugin('clash', (ctx) => { ctx.contribute(KIND, 'clash', { name: 'plugins', description: 'A second plugins skill.', path: 'plugins/clash/SKILL.md' }); }),
  rebuildPlus: plugin('rebuild-plus', (ctx) => { ctx.contribute(KIND, 'rebuild-plus', { name: 'self-rebuild', description: 'Rebuild with extras.', path: 'plugins/rebuild-plus/SKILL.md', replaces: ['self-rebuild'] }); }),
  noHash: plugin('no-hash', (ctx) => { ctx.contribute(KIND, 'no-hash', { name: 'orphan', description: 'Not installed.', files: ['SKILL.md'] }); }),
  broken: plugin('broken', (ctx) => { ctx.contribute(KIND, 'broken', { name: 'broken', description: 'Its files are missing.', files: ['SKILL.md'] }); })
};
async function page(configuration, extra = []) {
  const { hostInfo } = CONFIGURATIONS[configuration]();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
  for (const definition of extra) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const agentExtensions = agentModule.createAgentExtensions({ onError: (error, details) => errors.push([details.phase, details.id, error.message]) });
  agentExtensions.connect(runtime, { installed: INSTALLED });
  return { runtime, agentExtensions, errors };
}
async function withServedFiles(fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => SERVED[url] === undefined ? new Response('', { status: 404 }) : new Response(SERVED[url]);
  try { return await fn(); } finally { globalThis.fetch = saved; }
}
const skillsText = (sections) => Object.fromEntries(sections).skills;
const listed = (text) => [...(text ?? '').matchAll(/^- ([a-z0-9-]+): (.*) \((\/[^)]+)\)$/gm)].map((match) => [match[1], match[3]]);

test('the app\'s own skills match skills/<name>/SKILL.md and are offered only with their capability', { skip }, async () => {
  for (const skill of Object.values(coreModule.BUILTIN_SKILLS)) {
    const file = `${ROOT}${skill.path.replace(/^self-forming\//, '')}`;
    await access(file);
    assert.deepEqual(skillsModule.skillFrontmatter(await readFile(file, 'utf8')), { name: skill.name, description: skill.description }, skill.path);
  }
  const names = (host) => coreModule.coreSkillContributions({ host }).map((entry) => [entry.pluginId, entry.value.name, entry.kind]);
  assert.deepEqual(names({ workspace: {} }), []);
  assert.deepEqual(names({ env: {}, appRevision: {} }), [['core-self-update', 'self-rebuild', KIND]]);
  assert.deepEqual(names({ env: {}, apkInstaller: {}, pluginHost: {} }), [['core-self-update', 'self-rebuild', KIND], ['core-plugin-management', 'plugins', KIND]]);
  assert.deepEqual(names({ pluginHost: {} }), [], 'no execution environment: neither feature, neither skill');
  // The browser host (web-only packages, nativePlugins false) offers the plugins skill too; hosts without plugin support do not.
  const browserHost = { env: {}, pluginHost: {}, hostInfo: { platform: 'browser', capabilities: { plugins: true, nativePlugins: false } } };
  assert.deepEqual(names(browserHost), [['core-plugin-management', 'plugins', KIND]], 'browser with plugins: the plugins skill');
  assert.deepEqual(names({ env: {}, hostInfo: { platform: 'browser', capabilities: {} } }), [], 'browser without plugin support: no plugins skill');
  // The runtime definitions contribute the same skills (and core-skills is always there).
  const { runtime } = await page('native');
  const contributed = runtime.contributions(KIND).map((entry) => [entry.providerId, entry.value.name]);
  assert.deepEqual(contributed, [['core-self-update', 'self-rebuild'], ['core-plugin-management', 'plugins']]);
  assert.equal(runtime.list().find((record) => record.id === 'core-skills').essential, true);
  await runtime.close();
});

test('skills section: essential skills, packaged and inline plugin skills (copied), path skills, replacement and collisions', { skip, timeout: 120000 }, async () => {
  const { runtime, agentExtensions, errors } = await page('native', Object.values(PLUGINS));
  const result = await withServedFiles(() => promptsFor(deps, 'native', { agentExtensions, text: true }));
  const text = skillsText(result.main);
  assert.match(text, /^<skills>\nSkills give you specialized instructions for particular tasks\. When a task matches a skill's description, read its SKILL\.md with the read tool before you start and follow it\./);
  assert.match(text, /Skills under \.skills\/ are read-only copies from installed plugins/);
  assert.deepEqual(listed(text), [
    ['self-rebuild', '/workspace/plugins/rebuild-plus/SKILL.md'], // explicit replacement keeps the position
    ['plugins', '/workspace/self-forming/skills/plugins/SKILL.md'],
    ['forecast', '/workspace/.skills/weather/forecast/SKILL.md'],
    ['notes', '/workspace/.skills/notes/notes/SKILL.md']
  ], 'broken (files unreadable) and the rejected ones are not listed');
  assert.match(text, /- self-rebuild: Rebuild with extras\. \(/);
  // Section order: core sections, then skills, then plugin sections and instructions.
  assert.deepEqual(result.main.map(([key]) => key), ['device', 'app', 'self-rebuild', 'subagents', 'servers', 'agents-guide', 'skills', 'plugins']); // plugins: the section of core-plugin-management (added with the plugins prompt section)
  assert.deepEqual(result.subagentDefault.map(([key]) => key), ['device', 'skills', 'instructions']);
  assert.deepEqual(listed(skillsText(result.subagentDefault)).map(([name]) => name), ['self-rebuild', 'plugins', 'forecast', 'notes'], 'helpers inherit the plugins and their skills');
  assert.deepEqual(result.oldHelper.map(([key]) => key), ['instructions'], 'old helpers keep their own prompt');
  const reasons = Object.fromEntries(agentExtensions.list().rejected.map((item) => [item.pluginId, item.reason]));
  assert.match(reasons.clash, /Skill plugins is already provided by core plugin core-plugin-management; declare replaces: \["plugins"\] to replace it/);
  assert.match(reasons['no-hash'], /packaged skills need an installed plugin revision/);
  assert.equal(reasons['rebuild-plus'], undefined);
  // The mirror could not read broken's files: it is not listed and diagnosed failed.
  const broken = runtime.list().find((record) => record.id === 'broken').contributions[0];
  assert.deepEqual([broken.kind, broken.state], [KIND, 'failed']);
  assert.match(broken.reason, /HTTP 404/);
  assert.ok(errors.some(([phase, id]) => phase === 'skills' && id === 'broken'));
  const notes = runtime.list().find((record) => record.id === 'notes').contributions[0];
  assert.deepEqual([notes.state, notes.name, notes.packaged], ['installed', 'notes', true]);
  await runtime.close();
});

test('per-conversation exclusion removes a plugin\'s skills (skills-only plugins via their carrier), also for subagents', { skip, timeout: 120000 }, async () => {
  const { runtime, agentExtensions } = await page('native', [PLUGINS.notes, PLUGINS.weather]);
  const rows = Object.fromEntries(agentExtensions.describe(undefined).map((row) => [row.id, row]));
  assert.deepEqual([rows.notes.toggle, rows.notes.extensions, rows.notes.tools, rows.notes.skills], [true, [agentModule.skillCarrierName('notes')], [], ['notes']]);
  assert.deepEqual([rows.weather.toggle, rows.weather.extensions, rows.weather.skills], [true, ['weather-ext'], ['forecast']]);
  await withServedFiles(async () => {
    const excluded = await promptsFor(deps, 'native', { agentExtensions, text: true, helpers: {}, async onOpen(opened) {
      await opened.setPluginEnabled('notes', false);
      assert.deepEqual(opened.plugins().map((row) => [row.id, row.enabled]), [['notes', false], ['weather', true]]);
    } });
    assert.deepEqual(listed(skillsText(excluded.main)).map(([name]) => name), ['self-rebuild', 'plugins', 'forecast']);
    const both = await promptsFor(deps, 'native', { agentExtensions, text: true, helpers: {}, async onOpen(opened) {
      await opened.setPluginEnabled('notes', false);
      await opened.setPluginEnabled('weather', false);
    } });
    assert.deepEqual(listed(skillsText(both.main)).map(([name]) => name), ['self-rebuild', 'plugins'], 'excluded: only the app\'s own skills');
    assert.doesNotMatch(skillsText(both.main), /read-only copies/);
    // Subagents start with their owner's selection.
    const included = await subagentRunFor(deps, 'native', { context: ['device'], agentExtensions, text: true });
    assert.match(included.child.prompt, /- notes: Keep notes/);
    const child = await subagentRunFor(deps, 'native', { context: ['device'], agentExtensions, text: true, async onOpen(opened) { await opened.setPluginEnabled('notes', false); } });
    assert.deepEqual(child.child.tags, ['device', 'skills', 'instructions']);
    assert.doesNotMatch(child.child.prompt, /- notes:/);
    assert.match(child.child.prompt, /- forecast: Read forecasts\./);
  });
  // Excluding a skills-only plugin changes no tool (its carrier extension has none).
  const tools = await withServedFiles(() => toolsFor(deps, 'native', { agentExtensions, async onOpen(opened) { await opened.setPluginEnabled('notes', false); } }));
  assert.ok(tools.tools.some((entry) => entry.startsWith('weather_now#')));
  await runtime.close();
});

test('hosts without plugins or shell: no mirror, no packaged skills; prompts without skills stay unchanged', { skip, timeout: 120000 }, async () => {
  for (const name of ['nativeMinimal', 'offline', 'browserNoLinux']) {
    const { runtime, agentExtensions } = await page(name, [PLUGINS.notes]);
    const result = await withServedFiles(() => promptsFor(deps, name, { agentExtensions, text: true, helpers: {} }));
    assert.equal(skillsText(result.main), undefined, `${name}: nothing to list (no app skills, packaged skills need the mirror)`);
    await runtime.close();
  }
  // Browser: the app's own self-rebuild skill only (editableApp), no mirror for plugin skills.
  const { runtime, agentExtensions } = await page('browser', [PLUGINS.notes]);
  const browser = await withServedFiles(() => promptsFor(deps, 'browser', { agentExtensions, text: true, helpers: {} }));
  assert.deepEqual(listed(skillsText(browser.main)).map(([name]) => name), ['self-rebuild']);
  await runtime.close();
});

test('skill contributions are validated', { skip }, async () => {
  const bad = [
    ['caps', { name: 'Notes', description: 'x' }, /Invalid skill name/],
    ['nodesc', { name: 'nodesc', description: ' ' }, /needs a description/],
    ['traversal', { name: 'traversal', description: 'x', path: '../outside/SKILL.md' }, /without \.\./],
    ['nomd', { name: 'nomd', description: 'x', files: ['run.sh'] }, /files need SKILL\.md/],
    ['twoforms', { name: 'twoforms', description: 'x', path: 'a/SKILL.md', files: ['SKILL.md'] }, /use one of path, files or contents/],
    ['other', { name: 'other', description: 'x', path: 'a/SKILL.md', replaces: ['plugins'] }, /replaces may only name the skill itself/]
  ];
  const { runtime, agentExtensions } = await page('native', bad.map(([id, value]) => plugin(`bad-${id}`, (ctx) => { ctx.contribute(KIND, id, value); })));
  const reasons = Object.fromEntries(agentExtensions.list().rejected.map((item) => [item.pluginId, item.reason]));
  for (const [id, , pattern] of bad) assert.match(reasons[`bad-${id}`], pattern, id);
  assert.ok(agentExtensions.list().rejected.every((item) => item.kind === KIND));
  await runtime.close();
});

// Settings → Plugins (mocked DOM, as in plugin-overview-settings.test.mjs).
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.id = ''; this.checked = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  focus() {}
}
const all = (node) => [node, ...(node.children ?? []).flatMap((child) => child instanceof Node ? all(child) : [])];
const text = (node) => node instanceof Node ? node.textContent + node.children.map(text).join('') : node.text ?? '';
const IDS = ['plugin-settings', 'plugin-group-conversation', 'plugin-list', 'plugin-group-builtin', 'plugin-builtin-count', 'plugin-builtin', 'plugin-group-installed', 'plugin-installed', 'plugin-status', 'chat-settings'];

test('Settings → Plugins shows the skills each plugin contributes', { skip }, async () => {
  const fixed = Object.fromEntries(IDS.map((id) => [id, Object.assign(new Node('div'), { id })]));
  globalThis.document = { activeElement: null, createElement: (tag) => new Node(tag), getElementById: (id) => fixed[id] ?? Object.values(fixed).flatMap(all).find((node) => node.id === id) ?? null };
  try {
    const { runtime, agentExtensions } = await page('native', [PLUGINS.notes, PLUGINS.weather]);
    const hostInfo = CONFIGURATIONS.native().hostInfo;
    const inventory = INSTALLED.filter((item) => ['notes', 'weather'].includes(item.id)).map((item) => ({ ...item, version: '1.0.0', enabled: true, reload: 'page', provides: [], requires: [], uses: [] }));
    const bridge = { async call(method) { if (method === 'plugins.list') return { api: 1, plugins: structuredClone(inventory) }; throw new Error(method); } };
    const session = { snapshot: { conversation: { id: 1 }, owned: false }, plugins: () => agentExtensions.describe(undefined), setPluginEnabled: async () => {} };
    const settings = settingsModule.initPluginSettings({ agentExtensions, getSession: () => session });
    await settings.connect({ runtime, installed: { plugins: INSTALLED }, bridge, hostInfo });
    const row = (container, name) => all(container).find((child) => child.className === 'plugin-item' && all(child).some((node) => node.className === 'plugin-name' && node.textContent === name));
    assert.match(text(row(fixed['plugin-installed'], 'notes')), /Active · skill: notes/);
    assert.match(text(row(fixed['plugin-installed'], 'weather')), /Active · tool: weather_now · skill: forecast/);
    assert.equal(all(row(fixed['plugin-list'], 'notes')).find((node) => node.className === 'plugin-meta').textContent, '1 skill');
    assert.equal(all(row(fixed['plugin-list'], 'weather')).find((node) => node.className === 'plugin-meta').textContent, '1 tool');
    assert.equal(text(row(fixed['plugin-builtin'], 'App self-update')), 'App self-updatebuilt-inActive · tools: app_update, app_install_apk · skill: self-rebuild');
    assert.equal(text(row(fixed['plugin-builtin'], 'Skills')), 'Skillsbuilt-inActive · prompt section: skills');
    await runtime.close();
  } finally {
    delete globalThis.document;
  }
});
