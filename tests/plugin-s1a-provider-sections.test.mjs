import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { assembleApp, until } from './plugin-agent-support.mjs';
import { all, El, installDom } from './plugin-p4-support.mjs';

// Step S1a of docs/plugins-ui-editions.md: the built-in providers own their Settings panels.
// Real plugin runtime, plugin-builtins.js createCoreProviderPlugins, settings-sections.js and
// provider-panels.js against a mocked DOM (a tiny HTML parser stands in for <template>).
// Rows' lazy load() is stubbed: no pi-ai needed. NOT visual or on-device verification.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
Object.defineProperty(El.prototype, 'parentNode', { configurable: true, get() { return this.parent; } });

const VOID = new Set(['input', 'br', 'img']);
function parseInto(fragment, html) {
  const stack = [fragment];
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*?)(\/?)>|([^<]+)/gi)) {
    const [, closing, tag, attrs, selfClosing, text] = match;
    const top = stack.at(-1);
    if (text !== undefined) { if (text.trim()) top.append(text); continue; }
    if (closing) { stack.pop(); continue; }
    const el = new El(tag.toLowerCase());
    for (const [, name, value = ''] of (attrs ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (name === 'id') el.id = value;
      else if (name === 'class') el.className = value;
      else if (name === 'hidden') el.hidden = true;
      else if (name === 'disabled') el.disabled = true;
      else if (name === 'type') { el.type = value; el.setAttribute(name, value); }
      else el.setAttribute(name, value);
    }
    top.append(el);
    if (!selfClosing && !VOID.has(el.tag)) stack.push(el);
  }
}
function dom(extra = {}) {
  const d = installDom({ 'settings-content': 'div', 'provider-panels': 'div', ...extra });
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    if (tag !== 'template') return create(tag);
    const content = Object.assign(new El('#fragment'), { nodeType: 11 });
    return { content, set innerHTML(html) { parseInto(content, html); } };
  };
  return d;
}
const byId = (id) => globalThis.document.getElementById(id);
const slotted = (slot) => slot.children.filter((c) => c instanceof El && c.className === 'settings-slotted');
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// The ids index.html shipped before S1a, per provider (move, don't rename).
const IDS = {
  chatgpt: ['chatgpt-account', 'chatgpt-login', 'chatgpt-logout', 'chatgpt-switch', 'chatgpt-cancel', 'auth-status', 'chatgpt-open', 'chatgpt-settings', 'chatgpt-model', 'refresh-models', 'chatgpt-note'],
  claude: ['claude-account', 'claude-login', 'claude-logout', 'claude-cancel', 'claude-auth-status', 'claude-open', 'claude-code-form', 'claude-code', 'claude-code-submit', 'claude-settings', 'claude-model'],
  openai: ['openai-settings', 'api-key', 'model']
};

let app, coreProviders, builtins, runtimeModule, sectionsModule, panelsModule;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  coreProviders = await app.load('core-providers.js');
  builtins = await app.load('plugin-builtins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  sectionsModule = await app.load('settings-sections.js');
  panelsModule = await app.load('provider-panels.js');
});
after(async () => { await app?.remove(); });

const stubRows = (fail = false) => coreProviders.CORE_PROVIDER_ROWS.map((entry) => ({ ...entry, load: async () => { if (fail) throw new Error('row load failed'); return { providerRow: Object.freeze({ mode: entry.mode }) }; } }));

test('rows: chatgpt, claude and openai carry a provider-slot section with the old ids; offline has none; index.html no longer has them', async () => {
  const rows = coreProviders.CORE_PROVIDER_ROWS;
  assert.deepEqual(rows.map((row) => [row.mode, Boolean(row.section)]), [['offline', false], ['claude', true], ['chatgpt', true], ['openai', true]]);
  const html = await readFile(join(root, 'apps/common/index.html'), 'utf8');
  for (const row of rows.filter((r) => r.section)) {
    assert.equal(row.section.slot, 'provider');
    assert.equal(row.section.mode, row.mode);
    assert.ok(Object.isFrozen(row.section));
    const ids = [...row.section.markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, IDS[row.mode], `${row.mode}: same ids, same order`);
    for (const id of ids) assert.ok(!html.includes(`id="${id}"`), `#${id} left index.html`);
  }
  assert.ok(html.includes('<div id="provider-panels" class="provider-panels"></div>'));
  assert.ok(html.includes('<select id="mode">') && html.includes('id="provider-panel"'), '#mode and the P4 generic panel stay static');
});

test('bundled fallback: mountBundledProviderPanels puts every panel into #provider-panels once (ids reachable, hidden as before)', () => {
  const d = dom();
  try {
    const slot = d.fixed['provider-panels'];
    assert.equal(panelsModule.mountBundledProviderPanels({ rows: coreProviders.CORE_PROVIDER_ROWS }), 5);
    for (const id of Object.values(IDS).flat()) assert.ok(byId(id), `#${id} present`);
    assert.deepEqual(slot.children.map((c) => c.id), ['claude-account', 'claude-settings', 'chatgpt-account', 'chatgpt-settings', 'openai-settings']);
    assert.ok(slot.children.every((c) => c.hidden), 'panels start hidden (app.js shows the selected one)');
    assert.equal(byId('model').getAttribute('value'), 'gpt-4.1-mini');
    assert.equal(panelsModule.mountBundledProviderPanels({ rows: coreProviders.CORE_PROVIDER_ROWS }), 0, 'idempotent');
    assert.equal(slot.children.length, 5);
  } finally { d.restore(); }
});

async function composed({ fail = false, slot = true } = {}) {
  const d = dom();
  const panelSlot = d.fixed['provider-panels'];
  panelsModule.mountBundledProviderPanels({ rows: coreProviders.CORE_PROVIDER_ROWS });
  // app.js-style wiring on the bundled nodes, before composition.
  const clicks = [];
  byId('chatgpt-login').addEventListener('click', () => clicks.push('chatgpt-login'));
  byId('claude-code-form').addEventListener('submit', () => clicks.push('claude-submit'));
  const refs = Object.fromEntries(Object.values(IDS).flat().map((id) => [id, byId(id)]));
  const errors = [];
  const sections = sectionsModule.createSettingsSections({ container: d.fixed['settings-content'], slots: slot ? { provider: () => byId('provider-panels') } : {}, onError: (cause, details) => errors.push([details.phase, details.key, cause.message]) });
  const runtime = runtimeModule.createPluginRuntime({ onError() {} });
  for (const definition of builtins.createCoreProviderPlugins({ rows: stubRows(fail) })) runtime.register(definition);
  await sections.connect({ runtime });
  await runtime.start();
  await settle();
  return { d, panelSlot, clicks, refs, errors, sections, runtime };
}

test('composition: each provider plugin mounts the SAME nodes into its slotted section (order claude, chatgpt, openai); listeners and values survive; stop / recompose moves them back and forth', async () => {
  const c = await composed();
  try {
    await until(() => slotted(c.panelSlot).length === 3, 'three provider sections');
    assert.deepEqual(slotted(c.panelSlot).map((w) => [w.dataset.plugin, w.dataset.section, w.dataset.slot]), [
      ['core-providers-claude', 'provider-claude', 'provider'], ['core-providers-chatgpt', 'provider-chatgpt', 'provider'], ['core-providers-openai', 'provider-openai', 'provider']
    ]);
    assert.equal(c.panelSlot.children.length, 3, 'no bare bundled copies left behind');
    assert.ok(!c.d.fixed['settings-content'].children.some((x) => x instanceof El && x.dataset.section), 'no heading section at the end of Settings');
    for (const [id, node] of Object.entries(c.refs)) assert.equal(byId(id), node, `#${id}: same element app.js holds`);
    const chatgpt = slotted(c.panelSlot)[1];
    assert.deepEqual(chatgpt.children.map((x) => x.id), ['chatgpt-account', 'chatgpt-settings']);
    c.refs['api-key'].value = 'dummy-not-a-key';
    await c.refs['chatgpt-login'].click();
    await c.refs['claude-code-form'].dispatch('submit');
    assert.deepEqual(c.clicks, ['chatgpt-login', 'claude-submit']);

    await c.runtime.stop('core-providers-chatgpt');
    await settle();
    assert.deepEqual(slotted(c.panelSlot).map((w) => w.dataset.section), ['provider-claude', 'provider-openai']);
    assert.ok(c.panelSlot.children.includes(c.refs['chatgpt-account']) && c.panelSlot.children.includes(c.refs['chatgpt-settings']), 'back in the bundled slot');
    assert.equal(byId('chatgpt-login'), c.refs['chatgpt-login']);
    await c.refs['chatgpt-login'].click();
    assert.equal(c.clicks.at(-1), 'chatgpt-login', 'sign-in listener still wired');

    // A runtime starts once: a fresh composition (as after a page-owned recompose) mounts them again.
    const next = runtimeModule.createPluginRuntime({ onError() {} });
    for (const definition of builtins.createCoreProviderPlugins({ rows: stubRows() })) next.register(definition);
    await c.sections.connect({ runtime: next });
    await next.start();
    await settle();
    await until(() => slotted(c.panelSlot).length === 3, 'chatgpt section back');
    assert.equal(c.panelSlot.children.length, 3);
    assert.equal(byId('chatgpt-account').parent.dataset.section, 'provider-chatgpt');
    assert.equal(byId('api-key').value, 'dummy-not-a-key', 'input value kept across moves');

    await c.sections.dispose();
    assert.deepEqual(c.panelSlot.children.map((x) => x.id).sort(), ['chatgpt-account', 'chatgpt-settings', 'claude-account', 'claude-settings', 'openai-settings'], 'disposing Settings sections returns every panel to the slot');
    assert.deepEqual(c.errors, []);
    await next.close();
  } finally { await c.runtime.close(); c.d.restore(); }
});

test('failed composition (row load rejects): panels stay reachable by id in the slot', async () => {
  const c = await composed({ fail: true });
  try {
    await settle();
    for (const [id, node] of Object.entries(c.refs)) assert.equal(byId(id), node, `#${id} still in the page`);
    assert.ok(all(c.panelSlot).includes(c.refs['openai-settings']));
  } finally { await c.runtime.close(); c.d.restore(); }
});

test('no slot element: the section falls back to an ordinary contributed section (panels still mounted, still reachable)', async () => {
  const c = await composed({ slot: false });
  try {
    const sections = c.d.fixed['settings-content'].children.filter((x) => x instanceof El && x.dataset.section);
    assert.deepEqual(sections.map((s) => s.dataset.section), ['provider-claude', 'provider-chatgpt', 'provider-openai']);
    assert.equal(all(sections[2]).find((n) => n.tag === 'h3').textContent, 'OpenAI API key');
    for (const [id, node] of Object.entries(c.refs)) assert.equal(byId(id), node);
  } finally { await c.runtime.close(); c.d.restore(); }
});

test('wiring: app.js mounts the bundled panels before any element lookup; settings.js gives the provider slot; CSS keeps the wrappers layout-neutral', async () => {
  const appText = await readFile(join(root, 'apps/common/app.js'), 'utf8');
  const mountAt = appText.indexOf('mountBundledProviderPanels({ rows: CORE_PROVIDER_ROWS });');
  assert.ok(mountAt > 0);
  // C7: the element lookups moved into the chat (core-chat), mounted only after this, in start().
  assert.ok(mountAt < appText.indexOf('async function start()'));
  const chatText = await readFile(join(root, 'plugins/core-chat/web/chat.js'), 'utf8');
  assert.ok(chatText.includes('var key = element("api-key");') && chatText.includes('var login = element("chatgpt-login");'));
  assert.ok(!appText.includes('element("api-key")') && !appText.includes('element("chatgpt-login")'));
  const settingsText = await readFile(join(root, 'apps/common/settings.js'), 'utf8');
  assert.match(settingsText, /slots: \{ provider: \(\) => \$\("provider-panels"\)[,}]/);
  const css = await readFile(join(root, 'apps/common/app.css'), 'utf8');
  assert.match(css, /\.provider-panels, \.settings-slot, \.settings-slotted \{ display: contents; \}/);
  for (const mode of ['chatgpt', 'claude', 'openai']) {
    const index = await readFile(join(root, `plugins/core-providers-${mode}/web/index.js`), 'utf8');
    assert.match(index, /import \{ section \} from "\.\/settings-panel\.js";/);
    assert.doesNotMatch(index, /library\//, 'no library import at evaluation');
  }
});
