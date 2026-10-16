import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { PLUGIN_BUNDLES, bundleOf, groupByBundle, bundleSummary } = await app.load('plugin-bundles.js');
const { initPluginSettings, reloadPending } = await app.load('builtin/core-plugin-management/web/plugin-settings.js');

// Bundles in Settings → Plugins (docs/plugins.md §9b2) and the optional "Reload now"
// (docs/plugins-providers-agent-core.md §F.3). Mocked DOM and runtime; not visual verification.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.id = ''; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  focus() { globalThis.document.activeElement = this; }
  click() { for (const listener of this.listeners.click ?? []) listener(); }
  toggle(open) { this.open = open; for (const listener of this.listeners.toggle ?? []) listener(); }
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
const names = (node) => all(node).filter((child) => child.className === 'plugin-name').map((child) => child.textContent);

// A minimal runtime: list() records, contributions(), subscribe().
function fakeRuntime(records, extra = {}) {
  const listeners = new Set();
  return {
    records,
    list: () => records.map((record) => ({ version: '1.0.0', reload: 'page', provides: [], requires: [], uses: [], state: 'active', ...record })),
    contributions: () => [],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(); },
    ...extra
  };
}
const CORE_IDS = ['core-execution', 'core-prompt', 'core-skills', 'core-workspace-tools', 'core-tools'];
const DEV_IDS = [
];
// Built-ins in page order: core-execution, the optional dev bundle (when present), the rest of the core.
const BUILTIN_IDS = [CORE_IDS[0], ...DEV_IDS, ...CORE_IDS.slice(1)];
const builtinCount = (more) => String(BUILTIN_IDS.length + more);
const SF_IDS = ['core-self-update', 'core-plugin-management', 'core-servers'];
const session = { snapshot: { conversation: { id: 1 }, owned: false }, plugins: () => [], setPluginEnabled: async () => {} };

test('bundle table: ids, labels, versions; plain data with prefix patterns', () => {
  assert.deepEqual(PLUGIN_BUNDLES.map((bundle) => [bundle.id, bundle.label, typeof bundle.version]), [
    ['self-forming-core', 'self-forming-core', 'string'], ['self-forming-tools', 'self-forming-tools', 'string'],
    ['self-forming-net', 'self-forming-net', 'string'], ['self-forming-look', 'self-forming-look', 'string'],
  ]);
  assert.ok(Object.isFrozen(PLUGIN_BUNDLES) && PLUGIN_BUNDLES.every((bundle) => Object.isFrozen(bundle) && Object.isFrozen(bundle.plugins)));
  for (const id of CORE_IDS) assert.equal(bundleOf(id)?.id, 'self-forming-core', id);
  for (const id of DEV_IDS) assert.equal(bundleOf(id)?.id, 'self-forming-dev', id);
  for (const id of [...SF_IDS, 'core-subagents']) assert.equal(bundleOf(id)?.id, 'self-forming-tools', id);
  for (const id of ['net-tor', 'net-tailscale']) assert.equal(bundleOf(id)?.id, 'self-forming-net', id);
  for (const id of ['look-public', 'look-private']) assert.equal(bundleOf(id)?.id, 'self-forming-look', id);
  for (const id of ['core-agent', 'core-providers-openai']) assert.equal(bundleOf(id)?.id, 'self-forming-core', id);
  assert.equal(bundleOf('counter'), null);
  assert.equal(bundleOf('core-providers'), null, 'a prefix pattern needs the whole prefix');
  assert.equal(bundleOf(undefined), null);
  assert.equal(bundleSummary(9, 0), '9 · all active');
  assert.equal(bundleSummary(3, 1), '3 · 1 not active');
});

test('groupByBundle keeps row order, places bundles at their first member, ignores absent ids', () => {
  const rows = ['core-execution', 'odd', 'core-self-update', 'core-tools', 'core-servers', 'other'].map((id) => ({ id }));
  const entries = groupByBundle(rows);
  assert.deepEqual(entries.map((entry) => entry.bundle ? [entry.bundle.id, entry.rows.map((row) => row.id)] : entry.row.id), [
    ['self-forming-core', ['core-execution', 'core-tools']], 'odd', ['self-forming-tools', ['core-self-update', 'core-servers']], 'other'
  ]);
  // Ids listed in the table but absent (core-subagents, core-agent ...) never create rows; empty bundles are not shown.
  assert.deepEqual(groupByBundle([{ id: 'x' }]).map((entry) => entry.row?.id), ['x']);
  assert.deepEqual(groupByBundle([]), []);
});

test('Settings: one collapsed row per bundle with counts; unbundled built-ins listed individually', async () => {
  const fixed = dom();
  const runtime = fakeRuntime([...BUILTIN_IDS, ...SF_IDS, 'lonely-builtin'].map((id) => ({ id })));
  const settings = initPluginSettings({ getSession: () => session });
  await settings.connect({ runtime });
  const builtin = fixed['plugin-builtin'];
  assert.deepEqual(builtin.children.map((node) => [node.tag, node.id, node.className, node.open]), [
    ['details', 'plugin-bundle-self-forming-core', 'plugin-bundle', false],
    ['details', 'plugin-bundle-self-forming-tools', 'plugin-bundle', false],
    ['div', '', 'plugin-item', false]
  ]);
  const bundle = (id) => builtin.children.find((node) => node.id === `plugin-bundle-${id}`);
  const core = bundle('self-forming-core'), sf = bundle('self-forming-tools'), lonely = builtin.children.at(-1);
  assert.equal(core.children[0].tag, 'summary');
  assert.equal(text(core.children[0]), 'self-forming-core5 · all active');
  assert.equal(text(sf.children[0]), 'self-forming-tools3 · all active');
  assert.deepEqual(names(core.children[1]), ['Command execution', 'Prompt sections', 'Skills', 'Workspace files', 'File and shell tools']);
  assert.deepEqual(names(sf.children[1]), ['App self-update', 'Plugin management', 'Background servers']);
  assert.equal(core.children[1].attrs['aria-label'], 'Plugins in self-forming-core');
  assert.deepEqual(names(lonely), ['lonely-builtin']);
  assert.equal(fixed['plugin-builtin-count'].textContent, builtinCount(SF_IDS.length + 1));
  const ids = Object.values(fixed).flatMap(all).map((node) => node.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.equal(document.getElementById('plugin-reload'), null, 'no Reload now without reloadNow');
});

test('Settings: a member that is not active expands its bundle; a user choice survives re-render', async () => {
  const fixed = dom();
  const runtime = fakeRuntime([...BUILTIN_IDS.map((id) => ({ id })), ...SF_IDS.map((id) => ({ id }))]);
  const at = (id) => runtime.records.findIndex((record) => record.id === id);
  const settings = initPluginSettings({ getSession: () => session });
  await settings.connect({ runtime });
  runtime.records[at('core-skills')] = { id: 'core-skills', state: 'failed', reason: 'boom' };
  runtime.notify();
  await flush();
  const core = document.getElementById('plugin-bundle-self-forming-core');
  assert.equal(core.open, true);
  assert.equal(text(core.children[0]), 'self-forming-core5 · 1 not active');
  assert.match(text(core), /Failed: boom/);
  assert.equal(document.getElementById('plugin-bundle-self-forming-tools').open, false);
  assert.equal(fixed['plugin-builtin-count'].textContent, `${builtinCount(SF_IDS.length)} · 1 not active`);
  // The user closes it; the next render keeps it closed.
  core.toggle(false);
  runtime.records[at('core-workspace-tools')] = { id: 'core-workspace-tools', state: 'blocked', reason: 'no host' };
  runtime.notify();
  await flush();
  assert.equal(document.getElementById('plugin-bundle-self-forming-core').open, false);
  assert.match(text(document.getElementById('plugin-bundle-self-forming-core').children[0]), /5 · 2 not active/);
  // The user opens the healthy bundle; it stays open.
  document.getElementById('plugin-bundle-self-forming-tools').toggle(true);
  runtime.records.push({ id: 'core-subagents' });
  runtime.notify();
  await flush();
  const sf = document.getElementById('plugin-bundle-self-forming-tools');
  assert.equal(sf.open, true);
  assert.equal(text(sf.children[0]), 'self-forming-tools4 · all active');
});

test('reloadPending: runtime report, reload-required record, waiting web package, page action', () => {
  assert.equal(reloadPending({}), false);
  assert.equal(reloadPending({ runtime: fakeRuntime([{ id: 'a' }]) }), false);
  assert.equal(reloadPending({ runtime: fakeRuntime([{ id: 'a' }], { reloadRequired: () => true }) }), true);
  assert.equal(reloadPending({ runtime: fakeRuntime([{ id: 'core-agent', state: 'reload-required' }]) }), true);
  assert.equal(reloadPending({ runtime: fakeRuntime([{ id: 'core-agent', reloadPending: true }]) }), true);
  assert.equal(reloadPending({ installedRows: [{ id: 'p', state: 'installed', web: true }] }), true);
  assert.equal(reloadPending({ installedRows: [{ id: 'p', state: 'restart-required', web: false }] }), false);
  assert.equal(reloadPending({ actionReload: true }), true);
  assert.equal(reloadPending({ runtime: { list() { throw new Error('x'); } } }), false);
});

test('Reload now: shown only with reloadNow and a pending reload; calls it once; disabled while locked', async () => {
  const fixed = dom();
  let pending = false, isLocked = false;
  const calls = [];
  const runtime = fakeRuntime([{ id: 'core-prompt' }], { reloadRequired: () => pending });
  const settings = initPluginSettings({ getSession: () => session, locked: () => isLocked });
  await settings.connect({ runtime, reloadNow: async () => { calls.push('reload'); } });
  assert.equal(document.getElementById('plugin-reload'), null, 'nothing pending: no button');
  pending = true;
  runtime.notify();
  await flush();
  const box = document.getElementById('plugin-reload');
  const button = document.getElementById('plugin-reload-now');
  assert.equal(box.hidden, false);
  assert.ok(fixed['plugin-settings'].children.includes(box), 'sits in the section, after the status line');
  assert.deepEqual([button.tag, button.className, button.textContent, button.attrs['aria-label'], button.disabled], ['button', 'quiet-button', 'Reload now', 'Reload the app now to apply plugin changes', false]);
  button.click();
  await flush();
  assert.deepEqual(calls, ['reload']);
  // Locked (app update, sign-in, background): visible but disabled, clicks ignored.
  isLocked = true;
  settings.update();
  assert.equal(document.getElementById('plugin-reload-now').disabled, true);
  document.getElementById('plugin-reload-now').click();
  await flush();
  assert.deepEqual(calls, ['reload']);
  isLocked = false;
  // Nothing pending any more: hidden again.
  pending = false;
  runtime.notify();
  await flush();
  assert.equal(document.getElementById('plugin-reload').hidden, true);
});

test('Reload now from init options; a failed reload is reported in the status line; absent without the function', async () => {
  const fixed = dom();
  const runtime = fakeRuntime([{ id: 'core-servers', state: 'reload-required', reason: 'A replacement loads after the app reloads' }]);
  const settings = initPluginSettings({ getSession: () => session, reloadNow: async () => { throw new Error('Sign-in in progress'); } });
  await settings.connect({ runtime });
  assert.match(text(document.getElementById('plugin-bundle-self-forming-tools')), /Reload required: A replacement loads after the app reloads/);
  document.getElementById('plugin-reload-now').click();
  await flush();
  assert.equal(fixed['plugin-status'].textContent, 'Could not reload: Sign-in in progress');
  assert.equal(document.getElementById('plugin-reload-now').disabled, false);
  // Same pending state, no function: no button at all.
  const again = dom();
  const plain = initPluginSettings({ getSession: () => session });
  await plain.connect({ runtime });
  assert.equal(document.getElementById('plugin-reload'), null);
  assert.equal(again['plugin-status'].textContent, '');
});

test('Reload now after an app-wide action that applies on reload (web plugin enabled)', async () => {
  dom();
  const calls = [];
  const state = { plugins: [{ id: 'web1', name: 'Web one', version: '1.0.0', hash: 'f'.repeat(64), enabled: false, state: 'disabled', web: { entry: 'web/index.js' }, provides: [], requires: [], uses: [] }] };
  const bridge = { async call(method) {
    if (method === 'plugins.list') return { api: 1, plugins: structuredClone(state.plugins) };
    if (method === 'plugins.enable') { state.plugins[0] = { ...state.plugins[0], enabled: true, state: 'installed' }; return { id: 'web1', restartRequired: false }; }
    throw new Error(method);
  } };
  const settings = initPluginSettings({ getSession: () => session, reloadNow: () => { calls.push('reload'); } });
  await settings.connect({ runtime: fakeRuntime([{ id: 'core-prompt' }]), bridge, hostInfo: { platform: 'android', capabilities: { plugins: true } }, installed: { plugins: [] } });
  assert.equal(document.getElementById('plugin-reload'), null);
  document.getElementById('plugin-enable-web1').click();
  await flush();
  assert.equal(document.getElementById('plugin-reload').hidden, false);
  document.getElementById('plugin-reload-now').click();
  await flush();
  assert.deepEqual(calls, ['reload']);
});
