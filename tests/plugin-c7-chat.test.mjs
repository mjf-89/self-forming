import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { El, builtinModeOptions, installDom } from './plugin-p4-support.mjs';

// Step C7a (docs/plugins-providers-agent-core.md §B2 "How chat becomes a plugin"): the chat is
// the essential built-in core-chat (plugins/core-chat/web/chat.js) on agent.sessions@1. Its setup
// mounts the chat; app.js mounts the bundled copy when composition fails or core-chat did not
// (blocked, failed, late); only the first mount wins. The real core-chat, agent-sessions.js
// lifecycle, app-revisions closer and plugin runtime against a mocked DOM and fake sessions.
// Mocked DOM only: NOT visual or on-device verification.
const root = fileURLToPath(new URL('..', import.meta.url));
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (session.js constants) is not present';

let app, lifecycle, revisions, chatHostModule, registry, runtimeModule, builtins, builtinDefinition;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  lifecycle = await app.load('agent-sessions.js');
  revisions = await app.load('app-revisions.js');
  chatHostModule = await app.load('chat-host.js');
  registry = await app.load('builtin-plugins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  builtins = await app.load('plugin-builtins.js');
  builtinDefinition = await app.load('builtin-definition.js');
});
after(async () => { await app?.remove(); lifecycle?.setPageAgentSessions(undefined); chatHostModule?.setPageChatHost(undefined); });

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
if (!Object.getOwnPropertyDescriptor(El.prototype, 'classList')) {
  Object.defineProperty(El.prototype, 'classList', { get() {
    const classes = (this._classes ??= new Set());
    return {
      toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: (name) => classes.has(name)
    };
  } });
}

const SELECTS = ['mode', 'chatgpt-model', 'claude-model', 'thinking-effort'];
const IDS = ['messages', 'main-scroll', 'welcome', 'status', 'error', 'prompt', 'send', 'stop', 'api-key', 'model', 'resume', 'chatgpt-login', 'chatgpt-logout',
  'chatgpt-switch', 'chatgpt-cancel', 'chatgpt-open', 'auth-status', 'refresh-models', 'claude-login', 'claude-logout', 'claude-cancel', 'claude-open',
  'claude-auth-status', 'claude-code', 'claude-code-form', 'claude-code-submit', 'composer', 'provider-panel', 'chat-title', 'resume-panel', 'status-dot',
  'chatgpt-account', 'claude-account', 'openai-settings', 'mode-description', 'chatgpt-settings', 'claude-settings', 'thinking-settings', 'thinking-note',
  'chatgpt-note', 'composer-shortcuts', 'composer-shortcuts-menu', 'composer-model', 'composer-model-label', 'chat-settings', 'chat-screen', 'jump-latest',
  'composer-attachments', 'attach-files', 'attach-images', 'attachment-files-input', 'attachment-images-input'];
function chatDom() {
  const tags = Object.fromEntries([...IDS.map((id) => [id, 'div']), ...SELECTS.map((id) => [id, 'select'])]);
  return installDom(tags, (fixed) => {
    builtinModeOptions(fixed.mode);
    fixed.prompt.tag = 'textarea';
    fixed.prompt.value = '';
    fixed.prompt.disabled = true;
    fixed.messages.ownerDocument = { getSelection: () => null };
    fixed.messages.firstElementChild = null;
    const recovery = new El('p');
    fixed['resume-panel'].append(recovery);
    fixed['resume-panel'].querySelector = (selector) => selector === 'p' ? recovery : null;
    fixed['status'].textContent = 'Opening your conversation…';
    fixed['composer-attachments'].querySelectorAll = () => [];
  });
}

/** A fake agent.sessions@1 session: records drafts, sends, stops and closes. */
function fakeSession(state, id = 1) {
  const listeners = new Set();
  let snapshot = {
    messages: [], truncated: false, loadingHistory: false, busy: false, paused: false, recoveryProviders: [], anyBusy: false, owned: false, title: 'Main',
    kind: 'main', persistence: 'memory', mode: 'offline', modelId: 'faux-1', thinkingEffort: '', modelSettings: { mode: 'offline', modelId: 'faux-1', thinkingEffort: '' },
    conversation: { id, title: 'Main', isMain: true, draft: state.draft, attachments: [] }, threads: []
  };
  const publish = () => { for (const listener of [...listeners]) listener(snapshot); };
  const session = {
    get snapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
    async setDraft(text) { state.drafts.push(text); state.draft = text; snapshot = { ...snapshot, conversation: { ...snapshot.conversation, draft: text } }; },
    async send(text, config, conversationId) { state.sent.push({ text, mode: config.mode, conversationId }); snapshot = { ...snapshot, busy: true }; publish(); },
    async setModelSettings(choice) { state.models.push(choice); },
    async stop() { state.stops++; },
    async close() { state.closed++; },
    providers: () => [],
    providerLabel: () => undefined,
    busy(value) { snapshot = { ...snapshot, busy: value }; publish(); },
    retry(value) { snapshot = { ...snapshot, busy: true, ...value ? { retry: value } : {} }; if (!value) delete snapshot.retry; publish(); }
  };
  state.sessions.push(session);
  return session;
}

/** What app.js does at load: controller, closer saving the chat's draft, chat host; a fake bridge. */
function page() {
  const state = { draft: 'saved draft', drafts: [], sent: [], models: [], stops: 0, closed: 0, sessions: [] };
  const events = [];
  const bridge = { subscribe(listener) { events.push(listener); }, call: async () => ({}) };
  let host;
  const sessions = lifecycle.createAgentSessions({
    open: async () => fakeSession(state, state.sessions.length + 1),
    closer: revisions.createSessionCloser((current) => host.chat?.saveDraft(current) ?? Promise.resolve()),
    bridge,
    hostInfo: { foreground: true, capabilities: {} }
  });
  lifecycle.setPageAgentSessions(sessions);
  const rendered = [];
  host = chatHostModule.setPageChatHost(chatHostModule.createChatHost({ afterRender: (snapshot) => rendered.push(snapshot) }));
  const lifecycleEvent = (foreground) => { for (const listener of events) listener({ event: 'host.lifecycle', foreground }); };
  return { state, sessions, host, rendered, lifecycleEvent };
}

const byId = (id) => globalThis.document.getElementById(id);

test('normal path: core-chat (required agent.sessions@1) mounts the chat in its setup; the bundled copy then changes nothing', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    const runtime = runtimeModule.createPluginRuntime({ onError() {} });
    for (const definition of builtins.createBuiltinPlugins({ openExecution() {} })) runtime.register(definition);
    await runtime.start();
    await until(() => p.host.chat, 'core-chat did not mount the chat');
    assert.equal(p.host.mountedBy, 'core-chat');
    const listed = runtime.list().find((item) => item.id === 'core-chat');
    assert.equal(listed.state, 'active');
    assert.equal(runtime.service('agent.sessions', 1).foreground, true, 'facade getter (C7)');
    // The bundled copy (app.js after composition) finds the chat mounted.
    assert.equal(await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' }), false);
    p.sessions.start();
    await p.sessions.begun;
    await until(() => byId('status').textContent === 'Ready', 'chat did not render the session');
    assert.equal(byId('prompt').value, 'saved draft', 'the draft is restored');
    assert.equal(byId('prompt').disabled, false);
    assert.ok(p.rendered.length > 0, 'the page part (afterRender) runs after each render');
    // One send per submit: listeners were added once.
    byId('prompt').value = 'Hello';
    await byId('composer').dispatch('submit');
    await until(() => p.state.sent.length === 1);
    await settle(10);
    assert.deepEqual(p.state.sent, [{ text: 'Hello', mode: 'offline', conversationId: 1 }]);
    assert.equal(byId('prompt').value, '', 'sent text leaves the composer');
    assert.equal(byId('stop').hidden, false, 'Stop while the reply runs');
    // A user stop of core-chat (essential, reload "page") is refused (C6); an internal stop
    // withdraws the plugin but never unmounts the chat or touches the reply.
    await assert.rejects(runtime.requestStop('core-chat'), /applies only after the app reloads/);
    await runtime.stop('core-chat');
    assert.equal(byId('stop').hidden, false);
    assert.equal(p.state.stops, 0);
    await runtime.close();
    assert.equal(p.host.chat !== null, true, 'page-owned: closing the runtime never unmounts the chat');
  } finally {
    dom.restore();
  }
});

test('fallback: core-chat blocked (no agent.sessions@1) or composition failed: app.js mounts the bundled copy and the chat works', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    // A composition without core-agent: core-chat is blocked by its requirement and mounts nothing.
    const runtime = runtimeModule.createPluginRuntime({ onError() {} });
    runtime.register({ ...builtinDefinition.definitionShell('core-chat'), ...registry.builtinPlugin('core-chat').entry.create({ page: p.host }) });
    await runtime.start().catch(() => {});
    await settle(10);
    assert.notEqual(runtime.list().find((item) => item.id === 'core-chat').state, 'active');
    assert.equal(p.host.mountedBy, undefined, 'core-chat mounted nothing');
    // app.js bundledChat(): the same module, on the page controller.
    assert.equal(await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' }), true);
    assert.equal(p.host.mountedBy, 'bundled');
    p.sessions.start();
    await until(() => byId('status').textContent === 'Ready', 'bundled chat did not render');
    assert.equal(byId('prompt').value, 'saved draft');
    byId('prompt').value = 'From the bundled chat';
    await byId('composer').dispatch('submit');
    await until(() => p.state.sent.length === 1);
    assert.equal(p.state.sent[0].text, 'From the bundled chat');
    await runtime.close();
  } finally {
    dom.restore();
  }
});

test('late mount: the bundled copy mounted after the session opened catches up (draft, model, status)', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    p.sessions.start();
    await p.sessions.begun;
    assert.ok(p.sessions.current());
    assert.equal(byId('prompt').value, '');
    await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' });
    assert.equal(byId('prompt').value, 'saved draft');
    assert.equal(byId('status').textContent, 'Ready');
    assert.equal(byId('mode').value, 'offline');
    assert.equal(byId('composer-model-label').textContent, 'Offline demo');
  } finally {
    dom.restore();
  }
});

test('drafts: typing is saved; background close saves the unsent draft without stopping the reply; reopening restores it', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' });
    p.sessions.start();
    await until(() => byId('status').textContent === 'Ready');
    byId('prompt').value = 'typed words';
    await byId('prompt').dispatch('input');
    await until(() => p.state.drafts.includes('typed words'), 'draft not saved after typing', 2000);
    p.state.sessions[0].busy(true);
    byId('prompt').value = 'unsent words';
    p.lifecycleEvent(false);
    await until(() => p.state.closed === 1, 'session not closed on background');
    assert.equal(p.state.drafts.at(-1), 'unsent words', 'closing saved what the composer held');
    assert.equal(p.state.stops, 0, 'closing never stops the reply');
    assert.equal(byId('status').textContent, 'Paused in background');
    assert.equal(p.sessions.foreground, false);
    p.lifecycleEvent(true);
    await until(() => p.state.sessions.length === 2 && byId('status').textContent === 'Ready', 'did not reopen');
    assert.equal(byId('prompt').value, 'unsent words', 'the draft comes back');
  } finally {
    dom.restore();
  }
});

test('model settings: #mode change is saved on the session; Stop asks the session', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' });
    p.sessions.start();
    await until(() => byId('status').textContent === 'Ready');
    byId('mode').value = 'claude';
    await byId('mode').dispatch('change');
    assert.equal(p.state.models.at(-1).mode, 'claude');
    assert.equal(byId('claude-account').hidden, false);
    p.state.sessions[0].busy(true);
    await byId('stop').click();
    await settle(5);
    assert.equal(p.state.stops, 1);
  } finally {
    dom.restore();
  }
});

test('package and wiring: core-chat owns the chat modules; app.js keeps bootstrap and the bundled fallback', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'plugins/core-chat/plugin.json'), 'utf8'));
  assert.equal(manifest.essential, true);
  assert.equal(manifest.bundle, 'self-forming-core');
  assert.equal(manifest.reload, 'page');
  assert.deepEqual(manifest.requires, [{ id: 'agent.sessions', version: 1 }]);
  for (const name of ['chat-renderer.js', 'chat-controls.js', 'attachment-composer.js', 'provider-settings.js', 'chat.js', 'index.js']) {
    await readFile(join(root, 'plugins/core-chat/web', name), 'utf8');
    await assert.rejects(readFile(join(root, 'apps/common', name === 'index.js' ? 'nothing.js' : name), 'utf8'), undefined, `${name} left apps/common`);
  }
  const entry = await readFile(join(root, 'plugins/core-chat/web/index.js'), 'utf8');
  const chat = await readFile(join(root, 'plugins/core-chat/web/chat.js'), 'utf8');
  assert.doesNotMatch(entry + chat, /^import .*library\//m, 'no library at evaluation');
  assert.match(chat, /await import\("\.\.\/\.\.\/\.\.\/session\.js"\)/);
  const code = (await readFile(join(root, 'apps/common/app.js'), 'utf8')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const gone of ['element("prompt")', 'element("mode")', 'initChatControls', 'createChatRenderer', 'initAttachmentComposer', 'initProviderSettings', 'function sendMessage', 'function renderAuth', 'openAppSession', 'CLAUDE_MODELS']) {
    assert.ok(!code.includes(gone), `app.js still has ${gone}`);
  }
  assert.doesNotMatch(code, /\bvar session\b|\blet session\b|[^.\w]session\s*=[^=]/);
  assert.match(code, /setPageChatHost\(createChatHost\(\{/);
  assert.ok(code.indexOf('setPageChatHost(') < code.indexOf('startPluginComposition'), 'host registered before composition');
  assert.match(code, /if \(chatHost\.mountedBy\) return;/);
  assert.match(code, /builtinPlugin\("core-chat"\)\.entry\.mountChat\(\{ sessions, page: chatHost, by: "bundled" \}\)/);
  assert.match(code, /const bundledAgent = \(\) => \{\s*bundledChat\(\);/, 'the chat fallback runs on failure, after composition and at the deadline');
  assert.match(code, /createSessionCloser\(\(current\) => chatHost\.chat\?\.saveDraft\(current\) \?\? Promise\.resolve\(\)\)/);
  const pluginBuiltins = await readFile(join(root, 'apps/common/plugin-builtins.js'), 'utf8');
  assert.match(pluginBuiltins, /builtinPlugin\("core-chat"\)\.entry\.create\(\{ page: chat \}\)/);
});

test('a reply waiting to retry (pi.live.generation.retry) shows ONE status line with a countdown and Stop', { skip }, async () => {
  const dom = chatDom();
  const p = page();
  try {
    p.sessions.start();
    await p.sessions.begun;
    await registry.builtinPlugin('core-chat').entry.mountChat({ sessions: p.sessions, page: p.host, by: 'bundled' });
    const session = p.sessions.current();
    session.retry({ attempt: 2, at: Date.now() + 4200, error: 'Connection error.' });
    assert.match(byId('status').textContent, /^Retrying \(2\) in [45]s\u2026$/);
    assert.equal(byId('status').title, 'Connection error.', 'the error is the tooltip, not another message');
    assert.equal(byId('stop').hidden, false, 'Stop next to it');
    await settle(1100);
    assert.match(byId('status').textContent, /^Retrying \(2\) in [34]s\u2026$/, 'the countdown ticks without a new snapshot');
    session.retry(undefined);
    assert.equal(byId('status').textContent, 'Working\u2026', 'the line goes away once the attempt runs');
    session.busy(false);
  } finally {
    dom.restore();
  }
});
