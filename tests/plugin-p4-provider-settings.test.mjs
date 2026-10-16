import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { all, builtinModeOptions, El, FakeOption, installDom } from './plugin-p4-support.mjs';

// Step P4 of docs/plugins-providers-agent-core.md: Settings for contributed model providers.
// provider-settings.js (#mode options + the generic #provider-panel), the composer label in
// chat-controls.js and the chat.js wiring (core-chat since C7; was app.js), against a mocked
// DOM and fake providers() rows.
// Mocked DOM only: NOT visual or on-device verification.
const root = new URL('..', import.meta.url).pathname;
const { initProviderSettings } = await import(new URL('../plugins/core-chat/web/provider-settings.js', import.meta.url));
const { initChatControls } = await import(new URL('../plugins/core-chat/web/chat-controls.js', import.meta.url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BUILTIN = ['offline', 'chatgpt', 'claude', 'openai'];

const model = (id, name) => ({ id, name: name ?? id });
/** A providers() entry as session.js reports it (frozen, functions bound to the row/instance). */
function entry(mode, extra = {}) {
  return Object.freeze({
    mode, label: extra.label ?? mode, auth: 'none', defaultModelId: '', available: true, status: undefined,
    thinkingEfforts: () => [], catalog: () => [], models: async () => [], ...extra
  });
}
function page({ rows = [], session = {} } = {}) {
  const dom = installDom({ mode: 'select', 'provider-panel': 'div' }, (fixed) => builtinModeOptions(fixed.mode));
  const state = { rows, changes: 0, updates: 0, connected: [] };
  const opened = { providers: () => state.rows, ...session };
  const settings = initProviderSettings({
    getSession: () => state.session === null ? null : opened,
    onChange: () => { state.changes++; },
    onUpdate: () => { state.updates++; settings.update(); },
    onConnected: (mode) => { state.connected.push(mode); }
  });
  return { ...dom, state, settings, mode: dom.fixed.mode, panel: dom.fixed['provider-panel'] };
}
/** Selects a mode in #mode (as the user would) and renders, as app.js renderAuth does. */
function show(p, mode, locked = false) {
  p.settings.sync();
  p.mode.value = mode;
  p.settings.update({ mode, locked });
}
const options = (select) => select.options.map((option) => [option.value, option.textContent, option.disabled, option.dataset.provider ?? '', option.dataset.contributed ?? '']);
const byId = (root, id) => all(root).find((node) => node.id === id);

test('#mode: contributed rows get options after the built-ins; built-in options and rows are left alone', () => {
  const p = page({ rows: [entry('offline', { label: 'Offline (row)' }), entry('chatgpt'), entry('llama-local', { label: 'Local llama' }), entry('remote-x', { label: 'Remote X' })] });
  try {
    p.settings.sync();
    assert.deepEqual(options(p.mode), [
      ['offline', 'Offline demo', false, '', ''], ['chatgpt', 'ChatGPT', false, '', ''], ['claude', 'Claude Code', false, '', ''], ['openai', 'OpenAI API key', false, '', ''],
      ['llama-local', 'Local llama', false, '', 'true'], ['remote-x', 'Remote X', false, '', 'true']
    ]);
    p.settings.sync();
    assert.equal(p.mode.options.length, 6, 'idempotent: no duplicate options');
    // A P3 option for the same mode (app.js modeOption) becomes the contributed one.
    p.state.rows = [entry('llama-local', { label: 'Local llama' }), entry('later', { label: 'Later' })];
    const p3 = new FakeOption('Later (not available)', 'later');
    p3.dataset.provider = 'unavailable';
    p3.disabled = true;
    p.mode.add(p3);
    p.settings.sync();
    assert.deepEqual(options(p.mode).slice(4), [['llama-local', 'Local llama', false, '', 'true'], ['later', 'Later', false, '', 'true']], 'remote-x removed (not selected); the P3 option converted');
  } finally { p.restore(); }
});

test('#mode: a selected contributed option whose row goes away becomes the P3 "(not available)" option', () => {
  const p = page({ rows: [entry('llama-local', { label: 'Local llama' }), entry('remote-x', { label: 'Remote X' })] });
  try {
    p.settings.sync();
    p.mode.value = 'llama-local';
    p.state.rows = [];
    p.settings.sync();
    assert.deepEqual(options(p.mode).slice(4), [['llama-local', 'Local llama (not available)', true, 'unavailable', '']]);
    assert.equal(p.mode.value, 'llama-local', 'the selection is kept, never switched to another provider');
    // Without an open session nothing is touched.
    p.state.session = null;
    p.settings.sync();
    assert.equal(p.mode.options.length, 5);
    // The row comes back: the same option is contributed again.
    p.state.session = undefined;
    p.state.rows = [entry('llama-local', { label: 'Local llama' })];
    p.settings.sync();
    assert.deepEqual(options(p.mode).slice(4), [['llama-local', 'Local llama', false, '', 'true']]);
  } finally { p.restore(); }
});

test('panel: hidden for built-in and missing modes; model select from catalog(), then live models(); status line role=status', async () => {
  let release;
  const live = new Promise((resolve) => { release = resolve; });
  const row = entry('llama-local', {
    label: 'Local llama', defaultModelId: 'llama-3', status: { ready: true, message: 'Connected to 127.0.0.1:8080' },
    catalog: () => [model('llama-3', 'Llama 3')], models: () => live
  });
  const p = page({ rows: [row] });
  try {
    for (const mode of [...BUILTIN, 'provider:gone-id']) {
      p.settings.update({ mode, locked: false });
      assert.equal(p.panel.hidden, true, `${mode}: no generic panel`);
    }
    assert.equal(p.panel.children.length, 3, 'label (with select), Connect, status');
    const select = byId(p.panel, 'provider-model'), status = byId(p.panel, 'provider-status'), connect = byId(p.panel, 'provider-connect');
    const label = p.panel.children[0];
    assert.equal(label.tag, 'label');
    assert.equal(label.htmlFor, 'provider-model');
    assert.equal(label.children[0], 'Model');
    assert.equal(select.tag, 'select');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(status.className, 'settings-note');
    assert.equal(connect.className, 'quiet-button');
    assert.deepEqual(all(p.panel).map((node) => node.id).filter(Boolean), ['provider-panel', 'provider-model', 'provider-connect', 'provider-status'], 'unique ids');
    p.settings.restore({ mode: 'llama-local', modelId: '', thinkingEffort: '' });
    show(p, 'llama-local');
    assert.equal(p.panel.hidden, false);
    assert.deepEqual(select.options.map((option) => [option.value, option.textContent]), [['', 'Default (Llama 3)'], ['llama-3', 'Llama 3']], 'catalog until the live list arrives');
    assert.equal(status.textContent, 'Connected to 127.0.0.1:8080 Loading models\u2026');
    assert.equal(connect.hidden, true, 'no connect() on the row: no button');
    release([model('llama-3', 'Llama 3'), model('llama-3-small', 'Llama 3 small')]);
    await settle();
    assert.ok(p.state.updates >= 1, 'the page is told when the live list arrived');
    assert.deepEqual(select.options.map((option) => option.value), ['', 'llama-3', 'llama-3-small']);
    assert.equal(status.textContent, 'Connected to 127.0.0.1:8080');
    assert.equal(select.value, '');
    // A stored id the provider no longer lists stays visible (never silently replaced).
    p.settings.restore({ mode: 'llama-local', modelId: 'llama-old', thinkingEffort: '' });
    assert.deepEqual(select.options.map((option) => option.value), ['', 'llama-3', 'llama-3-small', 'llama-old']);
    assert.equal(select.value, 'llama-old');
    // Locked (no session, busy, background): the model select is disabled.
    p.settings.update({ mode: 'llama-local', locked: true });
    assert.equal(select.disabled, true);
    p.settings.update({ mode: 'llama-local', locked: false });
    assert.equal(select.disabled, false);
    // Back to a built-in mode: panel hidden again.
    p.settings.update({ mode: 'chatgpt', locked: false });
    assert.equal(p.panel.hidden, true);
  } finally { p.restore(); }
});

test('panel: models() failing keeps the catalog and says why; a model choice is saved through onChange', async () => {
  const row = entry('llama-local', {
    label: 'Local llama', status: { ready: false }, catalog: () => [model('llama-3', 'Llama 3')],
    models: async () => { throw new Error('Start the local server first.'); }
  });
  const p = page({ rows: [row] });
  try {
    p.settings.restore({ mode: 'llama-local', modelId: '', thinkingEffort: '' });
    show(p, 'llama-local');
    await settle();
    const select = byId(p.panel, 'provider-model'), status = byId(p.panel, 'provider-status');
    assert.deepEqual(select.options.map((option) => option.value), ['', 'llama-3']);
    assert.equal(status.textContent, 'Local llama is not connected. Start the local server first.');
    assert.equal(p.settings.selectedModel('llama-local'), '');
    select.value = 'llama-3';
    await select.dispatch('change');
    assert.equal(p.state.changes, 1);
    assert.equal(p.settings.selectedModel('llama-local'), 'llama-3');
    assert.equal(p.settings.selectedModel('other-mode'), '', 'a mode the panel does not show: nothing chosen yet');
    for (const mode of BUILTIN) assert.equal(p.settings.selectedModel(mode), '', `${mode}: built-ins keep their own controls`);
  } finally { p.restore(); }
});

test('Connect: only when the row exposes connect(); click connects, reloads the models and reports; failures are shown', async () => {
  let up = false, fail = false;
  const calls = [];
  const rows = () => [entry('llama-local', {
    label: 'Local llama', status: up ? { ready: true, message: 'Connected' } : { ready: false, message: 'The local server is not running.' },
    catalog: () => [model('llama-3')], models: async () => up ? [model('llama-3'), model('llama-70b')] : [model('llama-3')],
    async connect() { calls.push('connect'); if (fail) throw new Error('port 8080 is busy'); up = true; }
  })];
  const p = page();
  Object.defineProperty(p.state, 'rows', { get: () => rows() });
  try {
    show(p, 'llama-local');
    await settle();
    const connect = byId(p.panel, 'provider-connect'), status = byId(p.panel, 'provider-status'), select = byId(p.panel, 'provider-model');
    assert.equal(connect.hidden, false);
    assert.equal(connect.textContent, 'Connect');
    assert.equal(connect.getAttribute('aria-label'), 'Connect Local llama');
    assert.equal(connect.type, 'button');
    assert.equal(status.textContent, 'The local server is not running.');
    // Locked: the button is disabled (kept visible with its label).
    p.settings.update({ mode: 'llama-local', locked: true });
    assert.equal(connect.disabled, true);
    await connect.click();
    assert.deepEqual(calls, [], 'a locked button does nothing');
    p.settings.update({ mode: 'llama-local', locked: false });
    fail = true;
    await connect.click();
    await settle();
    assert.deepEqual(calls, ['connect']);
    assert.equal(status.textContent, 'Could not connect: port 8080 is busy');
    assert.deepEqual(p.state.connected, []);
    fail = false;
    const clicked = connect.click();
    assert.equal(status.textContent, 'Connecting to Local llama\u2026');
    assert.equal(connect.disabled, true);
    await clicked;
    await settle();
    assert.deepEqual(p.state.connected, ['llama-local'], 'the page may resume saved work');
    assert.equal(status.textContent, 'Connected');
    assert.equal(connect.hidden, true, 'ready: no Connect button');
    assert.deepEqual(select.options.map((option) => option.value), ['', 'llama-3', 'llama-70b'], 'models reloaded after connecting');
  } finally { p.restore(); }
});

test('status changes from the row (subscribe) refresh the panel and, when readiness changes, the models', async () => {
  let ready = false;
  const listeners = new Set();
  let loads = 0;
  const make = () => entry('llama-local', {
    label: 'Local llama', status: { ready, message: ready ? 'Up' : 'Down' },
    models: async () => { loads++; return [model('m1')]; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
  const p = page();
  Object.defineProperty(p.state, 'rows', { get: () => [make()] });
  try {
    show(p, 'llama-local');
    await settle();
    assert.equal(listeners.size, 1);
    assert.equal(loads, 1);
    const status = byId(p.panel, 'provider-status');
    assert.equal(status.textContent, 'Down');
    ready = true;
    for (const listener of listeners) listener({ signedIn: true });
    await settle();
    await settle();
    assert.equal(status.textContent, 'Up');
    assert.equal(loads, 2, 'readiness changed: models reloaded');
    show(p, 'offline');
    assert.equal(listeners.size, 0, 'unsubscribed when the panel hides');
  } finally { p.restore(); }
});

test('thinking efforts, resume readiness and the composer label come from the row', async () => {
  const p = page({ rows: [
    entry('llama-local', { label: 'Local llama', defaultModelId: 'llama-3', catalog: () => [model('llama-3', 'Llama 3'), model('think', 'Thinker')], thinkingEfforts: (id) => id === 'think' ? ['low', 'high'] : [] }),
    entry('acct', { label: 'Account X', auth: 'account', status: { ready: false } }),
    entry('acct-ok', { label: 'Account OK', auth: 'account', status: { ready: true } }),
    entry('keyed', { label: 'Keyed', auth: 'transient-key', status: { ready: true } })
  ] });
  try {
    p.settings.sync();
    assert.deepEqual(p.settings.thinkingEfforts('llama-local', 'think'), ['low', 'high']);
    assert.deepEqual(p.settings.thinkingEfforts('llama-local', 'llama-3'), []);
    for (const mode of [...BUILTIN, 'provider:gone']) assert.equal(p.settings.thinkingEfforts(mode, ''), undefined, `${mode}: the static table decides`);
    assert.deepEqual(['llama-local', 'acct', 'acct-ok', 'keyed', 'chatgpt', 'gone'].map((mode) => p.settings.ready(mode)), [true, false, true, false, false, false]);
    for (const mode of BUILTIN) assert.equal(p.settings.modelLabel(mode), undefined);
    p.settings.restore({ mode: 'llama-local', modelId: '', thinkingEffort: '' });
    assert.equal(p.settings.modelLabel('llama-local'), 'Llama 3', 'stored "" = the row default, by name');
    assert.equal(p.settings.modelLabel('llama-local', 'think'), 'Thinker');
    assert.equal(p.settings.modelLabel('llama-local', 'unlisted'), 'unlisted');
    assert.equal(p.settings.modelLabel('acct'), 'Account X', 'no model known: the provider label');
    // Missing provider: the P3 option text, a running model id, else the raw id.
    const p3 = new FakeOption('Gone provider (not available)', 'gone');
    p3.dataset.provider = 'unavailable';
    p.mode.add(p3);
    assert.equal(p.settings.modelLabel('gone'), 'Gone provider (not available)');
    assert.equal(p.settings.modelLabel('provider:gone-id', 'model-7'), 'model-7');
    assert.equal(p.settings.modelLabel('provider:gone-id'), 'gone-id');
  } finally { p.restore(); }
});

// ---- chat-controls.js: the composer label -------------------------------------------------
function composer({ modelLabel } = {}) {
  const tags = { prompt: 'textarea', 'main-scroll': 'div', 'composer-shortcuts': 'button', 'composer-shortcuts-menu': 'div', 'composer-model': 'button', 'chat-settings': 'button', mode: 'select', 'chatgpt-model': 'select', 'claude-model': 'select', model: 'input', 'composer-model-label': 'span', 'chat-screen': 'main', messages: 'div', 'jump-latest': 'button', 'provider-panel': 'div' };
  const dom = installDom(tags, (fixed) => {
    builtinModeOptions(fixed.mode);
    fixed['chat-screen'].hidden = true;
    fixed.model.value = 'gpt-4.1-mini';
    fixed['chatgpt-model'].add(new FakeOption('Account default', ''));
    fixed['claude-model'].add(new FakeOption('Claude Sonnet 4.6', 'claude-sonnet-4-6'));
  });
  const snapshot = { current: undefined };
  const controls = initChatControls({ getSnapshot: () => snapshot.current, ...modelLabel ? { modelLabel } : {} });
  const label = () => dom.fixed['composer-model-label'].textContent;
  return { ...dom, controls, snapshot, label };
}

test('composer label: contributed and missing modes use the row model name, never the stale OpenAI field', () => {
  const asked = [];
  const c = composer({ modelLabel: (mode, modelId) => { asked.push([mode, modelId]); return mode === 'llama-local' ? (modelId ? `name of ${modelId}` : 'Llama 3') : mode === 'gone' ? 'Gone provider (not available)' : undefined; } });
  try {
    c.fixed.mode.add(new FakeOption('Local llama', 'llama-local'));
    c.fixed.mode.value = 'llama-local';
    c.controls.update();
    assert.equal(c.label(), 'Llama 3');
    assert.equal(c.fixed['composer-model'].getAttribute('aria-label'), 'Model: Llama 3. Open settings');
    assert.equal(c.fixed['composer-model'].title, 'Model: Llama 3. Open settings');
    c.controls.update({ busy: true, mode: 'llama-local', modelId: 'llama-3-small' });
    assert.equal(c.label(), 'name of llama-3-small', 'running: the running model, by name');
    c.fixed.mode.add(new FakeOption('Gone provider (not available)', 'gone'));
    c.fixed.mode.value = 'gone';
    c.controls.update({ busy: false });
    assert.equal(c.label(), 'Gone provider (not available)');
    c.controls.update({ busy: true, mode: 'provider:gone-id', modelId: 'model-7' });
    assert.equal(c.label(), 'model-7', 'a provider no row owns: the running model id');
    assert.ok(!asked.some(([mode]) => BUILTIN.includes(mode)), 'built-in modes never ask the rows');
    assert.notEqual(c.label(), 'gpt-4.1-mini');
  } finally { c.restore(); }
  // Without a modelLabel (older wiring): the raw mode, still not the OpenAI field.
  const bare = composer();
  try {
    bare.fixed.mode.add(new FakeOption('x', 'llama-local'));
    bare.fixed.mode.value = 'llama-local';
    bare.controls.update();
    assert.equal(bare.label(), 'llama-local');
  } finally { bare.restore(); }
});

test('composer label: built-in modes unchanged (offline, ChatGPT, Claude, OpenAI, running)', () => {
  const c = composer({ modelLabel: () => 'MUST NOT BE USED' });
  try {
    const cases = [['offline', undefined, 'Offline demo'], ['chatgpt', undefined, 'Account default'], ['claude', undefined, 'Claude Sonnet 4.6'], ['openai', undefined, 'gpt-4.1-mini'],
      ['offline', { busy: true, mode: 'offline', modelId: 'faux-1' }, 'Offline demo'], ['chatgpt', { busy: true, mode: 'chatgpt', modelId: 'gpt-5' }, 'gpt-5'], ['openai', { busy: true, mode: 'claude', modelId: 'claude-haiku-4-5' }, 'claude-haiku-4-5']];
    for (const [mode, snapshot, expected] of cases) {
      c.fixed.mode.value = mode;
      c.controls.update(snapshot);
      assert.equal(c.label(), expected, `${mode} ${JSON.stringify(snapshot)}`);
    }
    c.fixed.model.value = '';
    c.fixed.mode.value = 'openai';
    c.controls.update();
    assert.equal(c.label(), 'OpenAI');
  } finally { c.restore(); }
});

test('composer model button focuses the generic model select for a contributed mode', async () => {
  const c = composer({ modelLabel: () => 'Llama 3' });
  try {
    const select = Object.assign(new El('select'), { id: 'provider-model' });
    c.fixed['provider-panel'].append(select);
    c.fixed.mode.add(new FakeOption('Local llama', 'llama-local'));
    c.fixed.mode.value = 'llama-local';
    c.fixed['provider-panel'].hidden = false;
    await c.fixed['composer-model'].click();
    assert.equal(globalThis.document.activeElement, select);
    c.fixed['provider-panel'].hidden = true;
    await c.fixed['composer-model'].click();
    assert.equal(globalThis.document.activeElement, c.fixed.mode, 'no panel: the provider select');
    c.fixed.mode.value = 'claude';
    await c.fixed['composer-model'].click();
    assert.equal(globalThis.document.activeElement, c.fixed['claude-model'], 'built-in unchanged');
  } finally { c.restore(); }
});

// ---- chat.js (core-chat, C7; was app.js): wiring (functions extracted and run against mocks) ----
const appText = await readFile(join(root, 'plugins/core-chat/web/chat.js'), 'utf8');
const pageText = await readFile(join(root, 'apps/common/app.js'), 'utf8');
function extract(name) {
  const start = appText.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `app.js: function ${name} not found`);
  let depth = 0;
  for (let i = appText.indexOf('{', appText.indexOf(')', start)); i < appText.length; i++) {
    if (appText[i] === '{') depth++;
    else if (appText[i] === '}' && --depth === 0) return appText.slice(start, i + 1);
  }
  throw new Error(`app.js: function ${name} not closed`);
}

test('chat.js selectedModel: built-ins read their own controls; other modes ask provider-settings', () => {
  const make = new Function('mode', 'chatGPTModel', 'claudeModel', 'model', 'providerSettings', `${extract('selectedModel')}\nreturn selectedModel;`);
  const asked = [];
  const providerSettings = { selectedModel: (mode) => { asked.push(mode); return mode === 'llama-local' ? 'llama-3' : ''; } };
  const run = (value) => make({ value }, { value: 'gpt-5' }, { value: 'claude-haiku-4-5' }, { value: ' gpt-4.1-mini ' }, providerSettings)();
  assert.deepEqual(['chatgpt', 'claude', 'openai'].map(run), ['gpt-5', 'claude-haiku-4-5', 'gpt-4.1-mini']);
  assert.deepEqual(asked, []);
  assert.equal(run('offline'), '');
  assert.equal(run('llama-local'), 'llama-3');
});

test('chat.js updateThinking: a contributed mode uses the row efforts, built-ins the static table', () => {
  const make = new Function('auth', 'claudeAuth', 'mode', 'getThinkingEfforts', 'selectedModel', 'thinkingEffort', 'sessions', 'element', 'operation', 'appReloading', 'providerSettings',
    `${extract('updateThinking')}\nreturn updateThinking;`);
  const run = (value) => {
    const select = new El('select');
    const panels = { 'thinking-settings': new El('div'), 'thinking-note': new El('p') };
    const restore = installDom({});
    try {
      make({ snapshot: { signedIn: true } }, { snapshot: { signedIn: true } }, { value }, ({ mode }) => mode === 'chatgpt' ? ['low', 'medium'] : [], () => 'think', select,
        { current: () => ({ snapshot: { modelSettings: { thinkingEffort: 'high' } } }), foreground: true }, (id) => panels[id], false, () => false,
        { thinkingEfforts: (mode, modelId) => mode === 'llama-local' ? (modelId === 'think' ? ['off', 'high'] : []) : undefined })();
    } finally { restore.restore(); }
    return { options: select.options.map((option) => option.value), value: select.value, hidden: panels['thinking-settings'].hidden };
  };
  assert.deepEqual(run('llama-local'), { options: ['', 'off', 'high'], value: 'high', hidden: false });
  assert.deepEqual(run('chatgpt'), { options: ['', 'low', 'medium'], value: '', hidden: false });
  assert.deepEqual(run('offline'), { options: [''], value: '', hidden: true });
});

test('chat.js resumeRecoveredReply: built-ins as before; a ready contributed provider resumes its saved work', async () => {
  const make = new Function('native', 'sessions', 'operation', 'loginOperation', 'claudeLoginOperation', 'authReady', 'auth', 'claudeAuthReady', 'claudeAuth', 'resumeReply', 'providerSettings',
    `${extract('resumeRecoveredReply')}\nreturn resumeRecoveredReply;`);
  const run = async (mode, { ready = false, signedIn = false } = {}) => {
    const resumed = [];
    await make(true, { foreground: true, current: () => ({ snapshot: { paused: true, mode } }) }, false, false, false, true, { snapshot: { signedIn } }, true, { snapshot: { signedIn } },
      async (config) => { resumed.push(config); }, { ready: (value) => value === 'llama-local' && ready })();
    return resumed;
  };
  assert.deepEqual(await run('offline'), [{ mode: 'offline' }]);
  assert.deepEqual(await run('chatgpt'), []);
  assert.deepEqual(await run('chatgpt', { signedIn: true }), [{ mode: 'chatgpt' }]);
  assert.deepEqual(await run('claude', { signedIn: true }), [{ mode: 'claude' }]);
  assert.deepEqual(await run('openai', { ready: true }), [], 'OpenAI still needs the key typed');
  assert.deepEqual(await run('llama-local'), [], 'not ready: waits');
  assert.deepEqual(await run('llama-local', { ready: true }), [{ mode: 'llama-local' }]);
  assert.deepEqual(await run('provider:gone-id', { ready: true }), [], 'a missing provider never resumes');
});

test('chat.js wiring: provider-settings is created by the chat; restore, sync, update, Connect resume and Plugins fallbacks are wired', () => {
  assert.match(appText, /^import \{ initProviderSettings \} from "\.\/provider-settings\.js";$/m);
  assert.match(appText, /var providerSettings = initProviderSettings\(\{\n\s+getSession: \(\) => sessions\.current\(\),/);
  assert.match(appText, /onConnected: \(\) => void resumeRecoveredReply\(\)/);
  assert.match(appText, /initChatControls\(\{ getSnapshot: \(\) => sessions\.current\(\)\?\.snapshot, modelLabel: \(value, modelId\) => providerSettings\?\.modelLabel\(value, modelId\) \}\)/);
  assert.match(extract('restoreModelSettings'), /if \(!choice\) return;\n\s+providerSettings\.sync\(\);\n\s+const signature/);
  assert.match(extract('restoreModelSettings'), /providerSettings\.restore\(choice\);\n\s*\}$/);
  assert.match(extract('renderAuth'), /model\.disabled = modelLocked;\n\s+providerSettings\.update\(\{ mode: mode\.value, locked: modelLocked \}\);/);
  assert.match(pageText, /initPluginSettings\(\{\n\s+agentExtensions,\n\s+agentProviders,/);
  // P3 contract kept (its test pins these lines too).
  assert.match(appText, /renderedModelSettings = signature;\n\s+modeOption\(choice\);\n\s+mode\.value = choice\.mode;/);
});

test('index.html: #provider-panels (S1a slot) then one empty hidden #provider-panel; built-in panel ids unchanged (now in their plugins); ids unique', async () => {
  const html = await readFile(join(root, 'apps/common/index.html'), 'utf8');
  assert.match(html, /<span id="mode-description" hidden><\/span><\/div>\n {8}<div id="provider-panels" class="provider-panels"><\/div>\n {8}<div id="provider-panel" class="key-settings" hidden><\/div>\n {8}<div id="thinking-settings"/);
  assert.ok(html.includes('<select id="mode"><option value="offline">Offline demo</option><option value="chatgpt">ChatGPT</option><option value="claude">Claude Code</option><option value="openai">OpenAI API key</option></select>'), '#mode keeps exactly the built-in options');
  // S1a: the built-in provider panels moved into plugins/core-providers-*/web/settings-panel.js.
  const panels = (await Promise.all(['chatgpt', 'claude', 'openai'].map((mode) => readFile(join(root, `plugins/core-providers-${mode}/web/settings-panel.js`), 'utf8')))).join('\n');
  const page = html + panels;
  assert.match(panels, /<label>Model<input id="model" type="text" value="gpt-4\.1-mini" autocapitalize="off" spellcheck="false" \/><\/label>\n<\/div>/);
  for (const id of ['mode', 'api-key', 'model', 'chatgpt-model', 'claude-model', 'thinking-effort', 'chat-settings', 'composer-model', 'resume-panel', 'chatgpt-account', 'claude-account', 'openai-settings', 'chatgpt-settings', 'claude-settings', 'thinking-settings']) {
    assert.equal([...page.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `#${id} exactly once`);
  }
  const ids = [...page.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'unique ids');
  for (const id of ['provider-model', 'provider-status', 'provider-connect']) assert.ok(!ids.includes(id), `#${id} is created by provider-settings.js only`);
  const source = await readFile(join(root, 'plugins/core-chat/web/provider-settings.js'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m, 'provider-settings.js imports nothing');
  assert.doesNotMatch(source, /edition:/, 'no edition-specific code');
});
