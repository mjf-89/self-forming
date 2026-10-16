import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { initPluginSettings, builtinName, pendingWarning } = await app.load('builtin/core-plugin-management/web/plugin-settings.js');
const { createPluginRuntime } = await app.load('plugin-runtime.js');
const { createBuiltinPlugins } = await app.load('plugin-builtins.js');
const { loadInstalledPlugins } = await app.load('plugin-client.js');
const { createAgentExtensions } = await app.load('agent-extensions.js');

// Settings → Plugins overview with the real runtime, built-in definitions, plugin client
// and agent-extensions adapter; mocked DOM, host bridge and session. Not visual
// verification of the Settings view.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.id = ''; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  focus() { globalThis.document.activeElement = this; }
  click() { for (const listener of this.listeners.click ?? []) listener(); }
}
const all = (node) => [node, ...(node.children ?? []).flatMap((child) => child instanceof Node ? all(child) : [])];
const text = (node) => node instanceof Node ? node.textContent + node.children.map(text).join('') : node.text ?? '';
const IDS = ['plugin-settings', 'plugin-group-conversation', 'plugin-list', 'plugin-group-builtin', 'plugin-builtin-count', 'plugin-builtin', 'plugin-group-installed', 'plugin-installed', 'plugin-status', 'chat-settings'];
function dom() {
  const fixed = Object.fromEntries(IDS.map((id) => [id, Object.assign(new Node('div'), { id, hidden: id.startsWith('plugin-group') || id === 'plugin-settings' })]));
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => fixed[id] ?? Object.values(fixed).flatMap(all).find((node) => node.id === id) ?? null
  };
  return fixed;
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const hash = (c) => c.repeat(64);
// Plugin rows anywhere below the container (built-ins sit inside bundle rows).
const rows = (container) => all(container).filter((node) => node !== container && node.className === 'plugin-item');
const rowNamed = (container, name) => rows(container).find((row) => all(row).some((node) => node.className === 'plugin-name' && node.textContent === name));

const counterModule = { setup(ctx) {
  ctx.provide('counter.value', 1, Object.freeze({ get: async () => 1 }));
  ctx.contribute('agent.extensions', 'counter', { name: 'counter-ext', tools: [{ name: 'counter_value', async execute() { return { content: [] }; } }] });
} };

// A page as plugin-bootstrap.js composes it, plus a host bridge with a mutable inventory.
async function page({ capabilities = {}, platform = 'android', inventory } = {}) {
  const hostInfo = { platform, capabilities: { executionEnv: true, plugins: true, editableApp: false, apkInstall: false, ...capabilities } };
  const calls = [];
  const state = {
    plugins: inventory ?? [
      { id: 'counter', name: 'Counter', version: '0.1.0', hash: hash('a'), enabled: true, state: 'active', web: { entry: 'web/index.js' }, native: { jar: 'native/module.jar' }, reload: 'restart', provides: [{ id: 'counter.value', version: 1 }], requires: [], uses: [] },
      { id: 'nat', name: 'Native only', version: '2.0.0', hash: hash('b'), enabled: true, state: 'restart-required', reason: 'A new native revision loads after the app restarts', native: { jar: 'native/module.jar' }, reload: 'restart', provides: [], requires: [], uses: [] },
      { id: 'off', name: 'Off', version: '1.0.0', hash: hash('c'), enabled: false, state: 'disabled', web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [{ id: 'missing', version: 1 }], uses: [] }
    ],
    responses: {}
  };
  const bridge = { async call(method, params) {
    calls.push([method, params]);
    if (method === 'plugins.list') return { api: 1, plugins: structuredClone(state.plugins) };
    const response = state.responses[method];
    if (response instanceof Error) throw response;
    if (response) return response;
    throw new Error(`unexpected ${method}`);
  } };
  const runtime = createPluginRuntime();
  for (const definition of createBuiltinPlugins({
    openExecution: () => ({}),
    agentTools: { hostInfo, loadBuilders: async () => ({}) }
  })) runtime.register(definition);
  const installed = await loadInstalledPlugins({ runtime, bridge, hostInfo, importModule: async () => counterModule });
  await runtime.start();
  const agentExtensions = createAgentExtensions();
  agentExtensions.connect(runtime, { installed: installed.plugins });
  calls.length = 0;
  return { hostInfo, bridge, runtime, agentExtensions, installed, calls, state };
}
function sessionFor(agentExtensions, pending = async () => ({ tasks: 0, conversations: [], partial: false })) {
  const asked = [];
  return {
    asked,
    snapshot: { conversation: { id: 1 }, owned: false },
    plugins: () => agentExtensions.describe(undefined),
    setPluginEnabled: async () => {},
    async pendingWorkFor(names) { asked.push(names); return pending(names); }
  };
}

test('names: core ids map to plain names; labelled built-ins use their label', () => {
  assert.equal(builtinName('core-tools'), 'File and shell tools');
  assert.equal(builtinName('core-workspace-tools'), 'Workspace files');
  assert.equal(builtinName('core-execution'), 'Command execution');
  assert.equal(builtinName('core-unknown'), 'core-unknown');
  assert.equal(pendingWarning('Counter', { tasks: 0, conversations: [] }), '');
  assert.equal(pendingWarning('Counter', { tasks: 2, conversations: [1] }), '2 pending tasks wait for Counter. They resume when it is enabled again.');
  assert.match(pendingWarning('Counter', { tasks: 1, conversations: [1, 4], partial: true }), /^At least 1 pending task waits for Counter in 2 conversations\./);
  assert.match(pendingWarning('Counter', { error: 'closed' }), /could not be checked: closed/);
});

test('groups: conversation choices, every built-in with contributions/state, every installed package', async () => {
  const fixed = dom();
  const p = await page();
  const session = sessionFor(p.agentExtensions);
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  assert.deepEqual(p.calls.map(([method]) => method), ['plugins.list']);
  assert.equal(fixed['plugin-settings'].hidden, false);
  // 1. This conversation: only the selectable plugin, as a checkbox.
  assert.equal(fixed['plugin-group-conversation'].hidden, false);
  const toggles = all(fixed['plugin-list']).filter((node) => node.tag === 'input');
  assert.deepEqual(toggles.map((input) => [input.id, input.checked, input.disabled]), [['plugin-toggle-counter', true, false]]);
  // 2. Built-in: every runtime plugin that is not an installed package, no switches.
  const builtin = fixed['plugin-builtin'];
  assert.equal(fixed['plugin-group-builtin'].hidden, false);
  assert.deepEqual(rows(builtin).map((row) => all(row).find((node) => node.className === 'plugin-name').textContent), [
    'Command execution', 'Prompt sections', 'Skills', 'Workspace files', 'File and shell tools',
    'Look: light',
    'App self-update', 'Plugin management', 'Subagents', 'Background servers'
  ]);
  assert.ok(all(builtin).every((node) => node.tag !== 'input' && node.tag !== 'button'), 'built-ins have no switch');
  assert.ok(rows(builtin).every((row) => all(row).some((node) => node.className === 'plugin-meta' && node.textContent === 'built-in')));
  assert.equal(text(rowNamed(builtin, 'Command execution')), 'Command executionbuilt-inActive · settings.sections execution · provides execution@1, workspace@1');
  assert.equal(text(rowNamed(builtin, 'File and shell tools')), 'File and shell toolsbuilt-inActive · tools: read, write, edit, bash');
  assert.equal(text(rowNamed(builtin, 'Workspace files')), 'Workspace filesbuilt-inActive · tools: workspace_read, workspace_write, workspace_list');
  // Blocked by a missing host capability: bold state word plus its reason.
  const blocked = rowNamed(builtin, 'App self-update');
  const strong = all(blocked).find((node) => node.tag === 'strong');
  assert.equal(strong.textContent, 'Blocked');
  assert.match(text(blocked), /Blocked: This host offers neither editable app revisions nor APK installation\./);
  assert.equal(fixed['plugin-builtin-count'].textContent, '10 · 1 not active');
  // Bundles (§9b2): one collapsed row each; the one with a blocked member is open.
  assert.deepEqual(builtin.children.map((node) => [node.tag, node.id, node.open, text(node.children[0])]), [
    ['details', 'plugin-bundle-self-forming-core', false, 'self-forming-core5 · all active'],
    ['details', 'plugin-bundle-self-forming-look', false, 'self-forming-look1 · all active'],
    ['details', 'plugin-bundle-self-forming-tools', true, 'self-forming-tools4 · 1 not active']
  ]);
  // A4: supervised servers, with the service it provides.
  assert.equal(text(rowNamed(builtin, 'Background servers')), 'Background serversbuilt-inActive · tool: manage_server · provides servers@1, servers.engine@1');
  assert.equal(text(rowNamed(builtin, 'Subagents')), 'Subagentsbuilt-inActive · tool: subagent'); // A5
  // A3b: the skills section and the app's own skills (plugins capability: the plugins skill).
  assert.equal(text(rowNamed(builtin, 'Skills')), 'Skillsbuilt-inActive · prompt section: skills');
  assert.equal(text(rowNamed(builtin, 'Plugin management')), 'Plugin managementbuilt-inActive · tool: plugins · prompt section: plugins · skill: plugins · settings.sections plugins · settings.sections providers');
  // 3. Installed: name, version, short mono hash, state + reason, contributions, actions.
  const installed = fixed['plugin-installed'];
  assert.equal(fixed['plugin-group-installed'].hidden, false);
  assert.equal(rows(installed).length, 3);
  const counter = rowNamed(installed, 'Counter');
  assert.equal(all(counter).find((node) => node.tag === 'code').textContent, 'aaaaaaaa');
  assert.equal(all(counter).find((node) => node.tag === 'code').className, 'plugin-hash');
  assert.match(text(counter), /0\.1\.0 aaaaaaaaActive · tool: counter_value · provides counter\.value@1/);
  assert.deepEqual(all(counter).filter((node) => node.tag === 'button').map((node) => [node.id, node.textContent, node.className, node.attrs['aria-label']]), [
    ['plugin-disable-counter', 'Disable', 'quiet-button', 'Disable Counter'], ['plugin-rollback-counter', 'Roll back', 'quiet-button', 'Roll back Counter to its previous revision']
  ]);
  assert.match(text(rowNamed(installed, 'Native only')), /Restart required: A new native revision loads after the app restarts/);
  const off = rowNamed(installed, 'Off');
  assert.match(text(off), /Disabled/);
  assert.match(text(off), /needs missing@1/);
  assert.deepEqual(all(off).filter((node) => node.tag === 'button').map((node) => node.id), ['plugin-enable-off', 'plugin-rollback-off']);
  // Unique ids across the whole section.
  const ids = Object.values(fixed).flatMap(all).map((node) => node.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  // Opening Settings re-reads the host inventory (no polling otherwise).
  fixed['chat-settings'].click();
  await flush();
  assert.deepEqual(p.calls.map(([method]) => method), ['plugins.list', 'plugins.list']);
  await p.runtime.close();
});

test('actions call the right bridge methods once, show restart/reload status and errors, then refresh', async () => {
  const fixed = dom();
  const p = await page();
  const session = sessionFor(p.agentExtensions);
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  p.calls.length = 0;
  // Enable (web-only): reload wording, list re-read and the row updated.
  p.state.responses['plugins.enable'] = { id: 'off', state: 'installed', restartRequired: false };
  p.state.plugins[2] = { ...p.state.plugins[2], enabled: true, state: 'installed' };
  document.getElementById('plugin-enable-off').click();
  await flush();
  assert.deepEqual(p.calls, [['plugins.enable', { id: 'off' }], ['plugins.list', {}]]);
  assert.equal(fixed['plugin-status'].textContent, 'Off enabled. Takes effect after the app reloads.');
  assert.match(text(rowNamed(fixed['plugin-installed'], 'Off')), /Installed: Loads after the app reloads/);
  assert.ok(document.getElementById('plugin-disable-off'));
  // Disable a native-only plugin (contributes no agent tools): no pending check, restart wording.
  p.calls.length = 0;
  p.state.responses['plugins.disable'] = { id: 'nat', state: 'disabled', restartRequired: true };
  document.getElementById('plugin-disable-nat').click();
  await flush();
  assert.deepEqual(session.asked, []);
  assert.deepEqual(p.calls, [['plugins.disable', { id: 'nat' }], ['plugins.list', {}]]);
  assert.equal(fixed['plugin-status'].textContent, 'Native only disabled. Takes effect after the app restarts.');
  // Roll back without a previous revision: the host error is shown, never retried.
  p.calls.length = 0;
  p.state.responses['plugins.rollback'] = Object.assign(new Error('No previous plugin revision'), { code: 'PLUGIN_NO_PREVIOUS' });
  document.getElementById('plugin-rollback-counter').click();
  await flush();
  assert.deepEqual(p.calls, [['plugins.rollback', { id: 'counter' }], ['plugins.list', {}]]);
  assert.equal(fixed['plugin-status'].textContent, 'Could not roll back Counter: No previous plugin revision');
  // A successful rollback names the selected revision.
  p.calls.length = 0;
  p.state.responses['plugins.rollback'] = { id: 'counter', hash: hash('d'), state: 'restart-required', restartRequired: true };
  document.getElementById('plugin-rollback-counter').click();
  await flush();
  assert.equal(fixed['plugin-status'].textContent, 'Counter rolled back to dddddddd. Takes effect after the app restarts.');
  // A list that says there is no previous revision hides Roll back.
  p.state.plugins[0] = { ...p.state.plugins[0], hasPrevious: false };
  await settings.refresh();
  assert.equal(document.getElementById('plugin-rollback-counter'), null);
  await p.runtime.close();
});

test('disable warns only with pending work; cancel aborts, confirm proceeds', async () => {
  const fixed = dom();
  const p = await page();
  let work = { tasks: 2, conversations: [1], partial: false };
  const session = sessionFor(p.agentExtensions, async () => work);
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  p.calls.length = 0;
  p.state.responses['plugins.disable'] = { id: 'counter', state: 'disabled', restartRequired: true };
  document.getElementById('plugin-disable-counter').click();
  await flush();
  assert.deepEqual(session.asked, [['counter-ext']], 'asks about the plugin\'s contributed extension names');
  assert.deepEqual(p.calls, [], 'nothing is disabled before confirmation');
  const counter = rowNamed(fixed['plugin-installed'], 'Counter');
  const alert = all(counter).find((node) => node.attrs?.role === 'alert');
  assert.equal(text(alert), 'Pending work: 2 pending tasks wait for Counter. They resume when it is enabled again.');
  assert.equal(document.activeElement?.id, 'plugin-cancel-counter');
  assert.equal(document.getElementById('plugin-rollback-off').disabled, true, 'other actions wait while confirming');
  document.getElementById('plugin-cancel-counter').click();
  await flush();
  assert.deepEqual(p.calls, [], 'cancel aborts');
  assert.equal(document.getElementById('plugin-confirm-counter'), null);
  assert.ok(document.getElementById('plugin-disable-counter'));
  // Again, confirmed this time.
  document.getElementById('plugin-disable-counter').click();
  await flush();
  document.getElementById('plugin-confirm-counter').click();
  await flush();
  assert.deepEqual(p.calls, [['plugins.disable', { id: 'counter' }], ['plugins.list', {}]]);
  assert.equal(fixed['plugin-status'].textContent, 'Counter disabled. Takes effect after the app restarts.');
  // No pending work: no warning, the call goes straight out.
  p.calls.length = 0;
  work = { tasks: 0, conversations: [], partial: false };
  document.getElementById('plugin-disable-counter').click();
  await flush();
  assert.equal(document.getElementById('plugin-confirm-counter'), null);
  assert.deepEqual(p.calls, [['plugins.disable', { id: 'counter' }], ['plugins.list', {}]]);
  // Unknown (the check failed): treated as a warning, not as "nothing pending".
  p.calls.length = 0;
  session.pendingWorkFor = async () => { throw new Error('The conversation is closed.'); };
  document.getElementById('plugin-disable-counter').click();
  await flush();
  assert.ok(document.getElementById('plugin-confirm-counter'));
  assert.match(text(rowNamed(fixed['plugin-installed'], 'Counter')), /could not be checked: The conversation is closed\./);
  assert.deepEqual(p.calls, []);
  await p.runtime.close();
});

test('a browser host that serves installed web plugins lists them like any capable host', async () => {
  const fixed = dom();
  const p = await page({ platform: 'browser', capabilities: { plugins: true } });
  const session = sessionFor(p.agentExtensions);
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  fixed['chat-settings'].click();
  await flush();
  assert.ok(p.calls.some(([method]) => method === 'plugins.list'));
  assert.equal(fixed['plugin-group-installed'].hidden, false);
  await p.runtime.close();
});

test('hosts without plugin capability (Android or browser) show built-ins only', async () => {
  for (const options of [{ capabilities: { plugins: false } }, { platform: 'browser', capabilities: { plugins: false } }]) {
    const fixed = dom();
    const p = await page(options);
    const session = sessionFor(p.agentExtensions);
    const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
    await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
    fixed['chat-settings'].click();
    await flush();
    assert.ok(p.calls.every(([method]) => method !== 'plugins.list'), `no inventory call: ${JSON.stringify(options)}`);
    assert.equal(fixed['plugin-group-installed'].hidden, true);
    assert.equal(fixed['plugin-group-builtin'].hidden, false);
    assert.equal(fixed['plugin-settings'].hidden, false);
    const names = rows(fixed['plugin-builtin']).map((row) => all(row).find((node) => node.className === 'plugin-name').textContent);
    assert.ok(names.includes('Plugin management'));
    if (!options.capabilities.plugins) assert.match(text(rowNamed(fixed['plugin-builtin'], 'Plugin management')), /Blocked: This host cannot install plugins\./);
    await p.runtime.close();
  }
});

test('an inventory failure is shown, not mistaken for an empty list; without composition only session rows remain', async () => {
  const fixed = dom();
  const p = await page();
  p.bridge.call = async (method) => { p.calls.push([method]); throw new Error('Bridge detached'); };
  const session = sessionFor(p.agentExtensions);
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  assert.equal(fixed['plugin-group-installed'].hidden, false);
  assert.match(text(fixed['plugin-installed']), /Unavailable: Installed plugins could not be listed: Bridge detached/);
  await p.runtime.close();
  // Composition failed entirely: no runtime, the host list still works.
  const again = dom();
  const q = await page();
  const settings2 = initPluginSettings({ getSession: () => ({ snapshot: { conversation: { id: 1 } }, plugins: () => [] }) });
  await settings2.connect({ bridge: q.bridge, hostInfo: q.hostInfo });
  assert.equal(again['plugin-group-builtin'].hidden, true);
  assert.equal(rows(again['plugin-installed']).length, 3);
  assert.match(text(rowNamed(again['plugin-installed'], 'Counter')), /Installed: Loads after the app reloads/);
  await q.runtime.close();
});

test('C6 a refused stop of an essential page plugin shows "Applies after the app reloads" and Reload now', async () => {
  const fixed = dom();
  const p = await page();
  const session = sessionFor(p.agentExtensions);
  let reloads = 0;
  const settings = initPluginSettings({ agentExtensions: p.agentExtensions, getSession: () => session, reloadNow: async () => { reloads++; } });
  await settings.connect({ runtime: p.runtime, installed: p.installed, bridge: p.bridge, hostInfo: p.hostInfo });
  const essential = p.runtime.list().find((r) => r.essential && r.reload === 'page' && r.state === 'active');
  assert.ok(essential, 'a built-in essential page plugin is active');
  assert.equal(document.getElementById('plugin-reload-now')?.hidden === false && document.getElementById('plugin-reload')?.hidden === false, false);
  await assert.rejects(p.runtime.requestStop(essential.id), /after the app reloads/);
  await flush();
  assert.match(fixed['plugin-status'].textContent, new RegExp(`Applies after the app reloads: .*${essential.id}`));
  const box = document.getElementById('plugin-reload');
  assert.equal(box.hidden, false);
  document.getElementById('plugin-reload-now').click();
  await flush();
  assert.equal(reloads, 1);
});
