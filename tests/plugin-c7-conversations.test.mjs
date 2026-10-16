import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleApp, until } from './plugin-agent-support.mjs';
import { El, all, installDom } from './plugin-p4-support.mjs';

// Step C7b (docs/plugins-providers-agent-core.md): the conversations drawer is the essential
// built-in core-conversations (plugins/core-conversations/web/conversations.js) on
// agent.sessions@1. app.js puts the drawer's nodes in place at load (mountBundled) and wires the
// bundled copy when composition fails or core-conversations did not wire it; only the first
// wiring counts. Real plugin, lifecycle and runtime against a mocked DOM and fake sessions.
// Mocked DOM only: NOT visual or on-device verification.
const root = fileURLToPath(new URL('..', import.meta.url));
let app, lifecycle, revisions, chatHostModule, registry, runtimeModule, builtins, builtinDefinition, contracts;
before(async () => {
  app = await assembleApp({ withLibrary: false }); // the drawer needs no library
  lifecycle = await app.load('agent-sessions.js');
  revisions = await app.load('app-revisions.js');
  chatHostModule = await app.load('chat-host.js');
  registry = await app.load('builtin-plugins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  builtins = await app.load('plugin-builtins.js');
  builtinDefinition = await app.load('builtin-definition.js');
  contracts = await app.load('agent-contracts.js');
});
after(async () => { await app?.remove(); lifecycle?.setPageAgentSessions(undefined); chatHostModule?.setPageChatHost(undefined); });

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
// What conversations.js needs beyond the P4 mock: classList, insertBefore, class selectors.
if (!Object.getOwnPropertyDescriptor(El.prototype, 'classList')) {
  Object.defineProperty(El.prototype, 'classList', { get() {
    const classes = (this._classes ??= new Set());
    return { toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }, contains: (name) => classes.has(name) };
  } });
}
// Reflected attributes, as in a browser (el() in conversations.js sets them as attributes).
const setAttribute = El.prototype.setAttribute;
El.prototype.setAttribute = function (name, value) {
  setAttribute.call(this, name, value);
  if (name === 'id') this.id = String(value);
  if (name === 'hidden') this.hidden = true;
};
Object.defineProperty(El.prototype, 'firstChild', { configurable: true, get() { return this.children[0] ?? null; } });
El.prototype.insertBefore = function (node, reference) {
  node.parent?.removeChild(node);
  node.parent = this;
  const index = this.children.indexOf(reference);
  this.children.splice(index < 0 ? this.children.length : index, 0, node);
};
El.prototype.querySelector = function (selector) {
  const match = (node) => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tag === selector;
  return all(this).slice(1).find(match) ?? null;
};

function drawerDom() {
  let topbar;
  const dom = installDom({ 'chat-screen': 'section', error: 'div' }, (fixed) => {
    topbar = Object.assign(new El('header'), { className: 'topbar' });
    topbar.append(Object.assign(new El('h1'), { id: 'chat-title' }));
    fixed['chat-screen'].append(topbar);
    fixed.error.hidden = true;
  });
  globalThis.document.body = new El('body');
  globalThis.document.querySelector = () => null;
  return { ...dom, topbar };
}
const byId = (id) => globalThis.document.getElementById(id) ?? all(globalThis.document.body).find((node) => node.id === id) ?? null;

function fakeSession(state) {
  return {
    get snapshot() { return { conversation: { id: state.current, draft: 'kept draft' }, busy: true }; },
    subscribe(listener) { listener(this.snapshot); return () => {}; },
    async tree() { return state.nodes.map((node) => ({ ...node, selected: node.id === state.current })); },
    async switchConversation(id) { state.calls.push(['switch', id]); state.current = id; },
    async newThread() { state.calls.push(['new']); },
    async forkThread() { state.calls.push(['fork', state.current]); },
    async archiveConversation(id) { state.calls.push(['archive', id]); },
    async unarchiveConversation(id) { state.calls.push(['unarchive', id]); },
    async renameConversation(id, title) { state.calls.push(['rename', id, title]); },
    async setDraft(text) { state.calls.push(['setDraft', text]); },
    async stop() { state.calls.push(['stop']); },
    async close() {}
  };
}
function page() {
  const state = { current: 1, calls: [], nodes: [{ id: 1, title: 'Main', kind: 'main' }, { id: 2, title: 'Side', kind: 'thread' }] };
  const sessions = lifecycle.createAgentSessions({
    open: async () => fakeSession(state),
    closer: revisions.createSessionCloser(() => Promise.resolve()),
    hostInfo: { foreground: true, capabilities: {} }
  });
  lifecycle.setPageAgentSessions(sessions);
  // A page with the chat screen registers its chat host (core-chat and core-conversations).
  chatHostModule.setPageChatHost(chatHostModule.createChatHost());
  return { state, sessions };
}
const entry = () => registry.builtinPlugin('core-conversations').entry;

test('normal path: nodes at load, then core-conversations (required agent.sessions@1) wires the drawer; the bundled copy changes nothing', async () => {
  const dom = drawerDom();
  const p = page();
  try {
    entry().mountBundled(); // app.js at load
    const button = byId('chat-tree');
    assert.equal(dom.topbar.children[0], button, 'the header button is first, as before');
    assert.equal(button.getAttribute('aria-label'), 'Conversations');
    assert.equal(byId('tree-screen').hidden, true);
    assert.equal(entry().conversationsMountedBy(), undefined, 'not wired yet');
    const runtime = runtimeModule.createPluginRuntime({ onError() {} });
    for (const definition of builtins.createBuiltinPlugins({ openExecution() {} })) runtime.register(definition);
    await runtime.start();
    assert.equal(runtime.list().find((item) => item.id === 'core-conversations').state, 'active');
    assert.equal(entry().conversationsMountedBy(), 'core-conversations');
    entry().mountBundled();
    assert.equal(byId('chat-tree'), button, 'one header button');
    assert.equal(button.listeners.click.length, 1);
    entry().mountConversations({ sessions: p.sessions, by: 'bundled' }); // app.js after composition
    assert.equal(button.listeners.click.length, 1, 'the bundled copy did not wire again');
    assert.equal(entry().conversationsMountedBy(), 'core-conversations');
    p.sessions.start();
    await p.sessions.begun;
    await button.click();
    assert.equal(byId('tree-screen').hidden, false, 'drawer open');
    await until(() => byId('tree-list').children.length === 2, 'tree not listed');
    const rows = byId('tree-list').children.map((row) => row.children[0]);
    assert.deepEqual(rows.map((open) => [open.textContent, open.getAttribute('aria-current')]), [['Main', 'true'], ['Side', null]]);
    await rows[1].click();
    await settle(5);
    assert.deepEqual(p.state.calls, [['switch', 2]]);
    assert.equal(byId('tree-screen').hidden, true, 'drawer closed after switching');
    // Opening and closing the drawer never stops a reply or touches a draft.
    await button.click();
    await byId('tree-back').click();
    assert.equal(byId('tree-screen').hidden, true);
    assert.ok(!p.state.calls.some(([name]) => name === 'stop' || name === 'setDraft'));
    await assert.rejects(runtime.requestStop('core-conversations'), /applies only after the app reloads/);
    await runtime.close();
    await byId('tree-new').click();
    await settle(5);
    assert.deepEqual(p.state.calls.at(-1), ['new'], 'page-owned: the drawer keeps working after the runtime closed');
  } finally {
    dom.restore();
  }
});

test('fallback: core-conversations blocked (no agent.sessions@1): app.js wires the bundled copy and the drawer works', async () => {
  const dom = drawerDom();
  const p = page();
  try {
    entry().mountBundled();
    const runtime = runtimeModule.createPluginRuntime({ onError() {} });
    runtime.register({ ...builtinDefinition.definitionShell('core-conversations'), ...entry().create() });
    await runtime.start().catch(() => {});
    assert.notEqual(runtime.list().find((item) => item.id === 'core-conversations').state, 'active');
    assert.equal(entry().conversationsMountedBy(), undefined);
    entry().mountConversations({ sessions: p.sessions, by: 'bundled' });
    assert.equal(entry().conversationsMountedBy(), 'bundled');
    // Before a session opens: the drawer shows the agent.sessions@1 not-open text.
    await byId('chat-tree').click();
    await byId('tree-new').click();
    const line = byId('tree-screen').querySelector('.conv-error');
    assert.equal(line.textContent, contracts.SESSION_NOT_OPEN_MESSAGE);
    assert.equal(line.hidden, false);
    p.sessions.start();
    await p.sessions.begun;
    await byId('tree-new').click();
    await settle(5);
    assert.deepEqual(p.state.calls, [['new']]);
    assert.equal(byId('tree-screen').hidden, true);
    await runtime.close();
  } finally {
    dom.restore();
  }
});

test('package and wiring: core-conversations owns conversations.js; app.js mounts the nodes at load and the bundled wiring as fallback', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'plugins/core-conversations/plugin.json'), 'utf8'));
  assert.equal(manifest.essential, true);
  assert.equal(manifest.bundle, 'self-forming-core');
  assert.equal(manifest.reload, 'page');
  assert.deepEqual(manifest.requires, [{ id: 'agent.sessions', version: 1 }]);
  await assert.rejects(readFile(join(root, 'apps/common/conversations.js'), 'utf8'));
  const drawer = await readFile(join(root, 'plugins/core-conversations/web/conversations.js'), 'utf8');
  assert.doesNotMatch(drawer, /^\s*import\b/m, 'no imports');
  // Persisted names and labels unchanged.
  for (const kept of ['"conv.showArchived"', '"aria-label": "Conversations"', '"aria-label": "New conversation"', '"aria-label": "Back to conversation"', '"aria-label": "Chat name"', 'id: "chat-tree"', 'id: "tree-screen"', 'id: "tree-list"', 'id: "tree-scrim"', 'id: "tree-new"', 'id: "tree-back"']) {
    assert.ok(drawer.includes(kept), `conversations.js keeps ${kept}`);
  }
  assert.doesNotMatch(drawer, /showFinished|Finished|\.finished/, 'the finished concept is gone');
  const code = (await readFile(join(root, 'apps/common/app.js'), 'utf8')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!code.includes('./conversations.js') && !code.includes('initConversations('));
  const mountAt = code.indexOf('coreConversations.mountBundled();');
  assert.ok(mountAt > 0 && mountAt < code.indexOf('async function start()'), 'nodes at load');
  assert.match(code, /if \(coreConversations\.conversationsMountedBy\(\)\) return;/);
  assert.match(code, /coreConversations\.mountConversations\(\{ sessions, by: "bundled", showError \}\)/);
  assert.match(code, /const bundledAgent = \(\) => \{\s*bundledChat\(\);\s*bundledConversations\(\);/);
  const pluginBuiltins = await readFile(join(root, 'apps/common/plugin-builtins.js'), 'utf8');
  assert.match(pluginBuiltins, /builtinPlugin\("core-conversations"\)\.entry\.create\(\)/);
});
