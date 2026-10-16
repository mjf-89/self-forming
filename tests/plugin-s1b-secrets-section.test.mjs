import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { assembleApp, until } from './plugin-agent-support.mjs';
import { all, El, installDom } from './plugin-p4-support.mjs';

// Step S1b of docs/plugins-ui-editions.md: the essential built-in core-secrets owns the
// Settings → Secrets screen (settings.sections, slot "secrets"). Real plugin runtime,
// plugin-builtins.js, settings-sections.js and plugins/core-secrets/web against a mocked DOM
// and a fake bridge with clearly dummy values. NOT visual or on-device verification; the
// native SecretStore/SecretBroker are not exercised here.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
Object.defineProperty(El.prototype, 'parentNode', { configurable: true, get() { return this.parent; } });
El.prototype.checked = false; // so the screen's el() helper sets it as a property
El.prototype.open = false;
const selector = (sel) => {
  const match = /^input\[data-key(?:=([A-Za-z]+))?\]$/.exec(sel);
  if (!match) throw new Error(`mock querySelector: unsupported ${sel}`);
  return (node) => node.tag === 'input' && node.dataset.key !== undefined && (!match[1] || node.dataset.key === match[1]);
};
El.prototype.querySelectorAll = function (sel) { return all(this).slice(1).filter(selector(sel)); };
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] ?? null; };

const VOID = new Set(['input', 'br', 'img']);
function parseInto(fragment, html) {
  const stack = [fragment];
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/gi)) {
    const [, closing, tag, attrs, selfClosing, text] = match;
    const top = stack.at(-1);
    if (text !== undefined) { if (text.trim()) top.append(text); continue; }
    if (closing) { stack.pop(); continue; }
    const el = new El(tag.toLowerCase());
    for (const [, name, value = ''] of (attrs ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (name === 'id') el.id = value;
      else if (name === 'class') el.className = value;
      else if (name === 'hidden') el.hidden = true;
      else if (name === 'type') { el.type = value; el.setAttribute(name, value); }
      else el.setAttribute(name, value);
    }
    top.append(el);
    if (!selfClosing && !VOID.has(el.tag)) stack.push(el);
  }
}
function dom() {
  const d = installDom({ 'settings-content': 'div', 'provider-panels': 'div', 'secrets-panel': 'div', 'chat-settings': 'button' });
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
const IDS = ['secrets-unavailable', 'secrets-settings', 'secrets-error', 'secrets-lock', 'secrets-lock-text', 'secrets-unlock', 'secrets-list', 'secrets-form', 'secrets-name', 'secrets-value', 'secrets-new-toggles', 'secrets-save'];
const DUMMY = 'dummy-not-a-real-value-123';

let app, entry, registry, builtins, runtimeModule, sectionsModule;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  registry = await app.load('builtin-plugins.js');
  entry = registry.builtinPlugin('core-secrets').entry;
  builtins = await app.load('plugin-builtins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  sectionsModule = await app.load('settings-sections.js');
});
after(async () => { await app?.remove(); });

test('package: essential self-forming-core built-in with its Kotlin half in native/ (X5); screen moved out of apps/common and index.html (same ids)', async () => {
  const json = JSON.parse(await readFile(join(root, 'plugins/core-secrets/plugin.json'), 'utf8'));
  assert.deepEqual([json.id, json.essential, json.bundle, json.builtin, json.provides], ['core-secrets', true, 'self-forming-core', true, []]);
  assert.deepEqual(registry.builtinPlugin('core-secrets').manifest, json);
  assert.deepEqual((await readdir(join(root, 'plugins/core-secrets'))).sort(), ['native', 'plugin.json', 'web']);
  await assert.rejects(access(join(root, 'apps/common/secrets-settings.js')), 'moved, not copied');
  const html = await readFile(join(root, 'apps/common/index.html'), 'utf8');
  for (const id of IDS) assert.ok(!html.includes(`id="${id}"`), `#${id} left index.html`);
  assert.ok(html.includes('<div id="secrets-panel" class="settings-slot"></div>'));
  const ids = [...entry.section.markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, IDS, 'same ids, same order');
  assert.equal(entry.section.slot, 'secrets');
  assert.equal(entry.section.slotId, 'secrets-panel');
  assert.ok(Object.isFrozen(entry.section));
  const css = await readFile(join(root, 'apps/common/app.css'), 'utf8');
  assert.match(css, /\.provider-panels, \.settings-slot, \.settings-slotted \{ display: contents; \}/);
});

test('wiring: app.js mounts the bundled copy at load and wires it after host.info; settings.js gives the slot; bootstrap registers core-secrets', async () => {
  const appText = await readFile(join(root, 'apps/common/app.js'), 'utf8');
  assert.ok(!appText.includes('secrets-settings.js'));
  const mountAt = appText.indexOf('coreSecrets.mountBundled();');
  assert.ok(mountAt > 0 && mountAt < appText.indexOf('async function start()'));
  assert.ok(appText.indexOf('coreSecrets.initSecretsSettings(bridge);') > appText.indexOf('globalThis.__piHostInfo = hostInfo;'));
  assert.match(await readFile(join(root, 'apps/common/settings.js'), 'utf8'), /secrets: \(\) => \$\("secrets-panel"\)/);
  assert.match(await readFile(join(root, 'apps/common/plugin-bootstrap.js'), 'utf8'), /secrets: true/);
  const ids = builtins.createBuiltinPlugins({ openExecution() {}, providers: { hostInfo: {} }, secrets: true, agentTools: { hostInfo: {} } }).map((d) => d.id);
  assert.ok(ids.includes('core-secrets') && ids.indexOf('core-secrets') > ids.indexOf('core-providers-openai') && ids.indexOf('core-secrets') < ids.indexOf('core-prompt'));
  assert.ok(!builtins.createBuiltinPlugins({ openExecution() {} }).some((d) => d.id === 'core-secrets'));
  const definition = builtins.createBuiltinPlugins({ openExecution() {}, secrets: true }).find((d) => d.id === 'core-secrets');
  assert.equal(definition.essential, true);
});

async function composed() {
  const d = dom();
  const slot = d.fixed['secrets-panel'];
  assert.equal(entry.mountBundled(), 2);
  assert.equal(entry.mountBundled(), 0, 'idempotent');
  const refs = Object.fromEntries(IDS.map((id) => [id, byId(id)]));
  const errors = [];
  const sections = sectionsModule.createSettingsSections({ container: d.fixed['settings-content'], slots: { provider: () => byId('provider-panels'), secrets: () => byId('secrets-panel') }, onError: (cause, details) => errors.push([details.phase, details.key, cause.message]) });
  const runtime = runtimeModule.createPluginRuntime({ onError() {} });
  for (const definition of builtins.createBuiltinPlugins({ openExecution() {}, secrets: true })) runtime.register(definition);
  await sections.connect({ runtime });
  await runtime.start();
  await settle();
  return { d, slot, refs, errors, sections, runtime };
}

test('composition: core-secrets mounts the SAME nodes into a slotted section in #secrets-panel; stop moves them back; dispose too', async () => {
  const c = await composed();
  try {
    await until(() => slotted(c.slot).length === 1, 'secrets section');
    const wrapper = slotted(c.slot)[0];
    assert.deepEqual([wrapper.dataset.plugin, wrapper.dataset.section, wrapper.dataset.slot], ['core-secrets', 'secrets', 'secrets']);
    assert.deepEqual(wrapper.children.map((x) => x.id), ['secrets-unavailable', 'secrets-settings']);
    assert.equal(c.slot.children.length, 1, 'no bare bundled copy left behind');
    assert.ok(!c.d.fixed['settings-content'].children.some((x) => x instanceof El && x.dataset.plugin === 'core-secrets'), 'no heading section at the end of Settings');
    for (const [id, node] of Object.entries(c.refs)) assert.equal(byId(id), node, `#${id}: same element`);
    await c.runtime.stop('core-secrets');
    await settle();
    assert.deepEqual(c.slot.children.map((x) => x.id), ['secrets-unavailable', 'secrets-settings'], 'back in the bundled place');
    await c.sections.dispose();
    assert.deepEqual(c.errors, []);
  } finally { await c.runtime.close(); c.d.restore(); }
});

test('failed or missing composition: the bundled copy stays in #secrets-panel and works', async () => {
  const d = dom();
  try {
    entry.mountBundled();
    const sections = sectionsModule.createSettingsSections({ container: d.fixed['settings-content'], slots: { secrets: () => byId('secrets-panel') } });
    await sections.connect({ runtime: null }); // what app.js does when composition rejects
    assert.deepEqual(d.fixed['secrets-panel'].children.map((x) => x.id), ['secrets-unavailable', 'secrets-settings']);
    globalThis.__piHostInfo = { capabilities: { secrets: true } };
    const calls = [];
    entry.initSecretsSettings({ call: async (method, params) => { calls.push([method, params]); return { secrets: [] }; } });
    await settle();
    assert.equal(byId('secrets-settings').hidden, false);
    assert.deepEqual(calls, [['secrets.list', {}]]);
  } finally { delete globalThis.__piHostInfo; d.restore(); }
});

function fakeBridge(state) {
  const calls = [];
  const bridge = {
    calls,
    lockedOnce: false,
    async call(method, params = {}) {
      calls.push([method, structuredClone(params)]);
      if (method === 'secrets.list') return structuredClone(state);
      if (method === 'secrets.unlock') { state.unlockedUntil = Date.now() + 60_000; return {}; }
      if (method === 'secrets.delete') { state.secrets = state.secrets.filter((s) => s.name !== params.name); return {}; }
      if (method === 'secrets.set') {
        if (bridge.lockedOnce) { bridge.lockedOnce = false; throw Object.assign(new Error('Unlock with your fingerprint'), { code: 'LOCKED' }); }
        const { value, ...rest } = params; void value;
        state.secrets = [...state.secrets.filter((s) => s.name !== params.name), { name: rest.name, scopes: rest.scopes, redact: rest.redact, biometric: rest.biometric, askEveryTime: rest.askEveryTime }];
        return structuredClone(state);
      }
      throw new Error(`unexpected ${method}`);
    }
  };
  return bridge;
}

test('security: no capability → hidden, no bridge call; values never rendered; new secret clears inputs; scopes default as before; fingerprint retry; deletion confirmed; nothing logged', async () => {
  const d = dom();
  const logged = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { saved[level] = console[level]; console[level] = (...args) => logged.push([level, ...args]); }
  try {
    entry.mountBundled();
    // No secrets capability: the screen stays hidden and the bridge is never asked.
    globalThis.__piHostInfo = { capabilities: {} };
    const idle = fakeBridge({ secrets: [] });
    entry.initSecretsSettings(idle);
    assert.equal(byId('secrets-settings').hidden, true);
    assert.equal(byId('secrets-unavailable').hidden, false);
    assert.deepEqual(idle.calls, []);

    // With the capability. A list response never carries values; even if one did, it is not shown.
    globalThis.__piHostInfo = { capabilities: { secrets: true } };
    const state = { secrets: [{ name: 'GH_TOKEN', value: DUMMY, scopes: { agent: false, servers: true, terminal: false }, redact: true, biometric: true, askEveryTime: false }], unlockedUntil: 0 };
    const bridge = fakeBridge(state);
    entry.initSecretsSettings(bridge);
    await settle();
    const page = () => all(d.fixed['secrets-panel']);
    const visible = () => page().map((n) => `${n._text}|${n._value}|${Object.values(n.attrs).join('|')}`).join('\n');
    assert.ok(!visible().includes(DUMMY), 'no value in the page');
    assert.match(byId('secrets-list').textContent, /GH_TOKEN/);
    const toggles = page().filter((n) => n.tag === 'input' && n.dataset.key && n.parent?.parent?.parent === byId('secrets-list').children[0]);
    assert.deepEqual(Object.fromEntries(toggles.map((t) => [t.dataset.key, t.checked])), { agent: false, servers: true, redact: true, biometric: true, askEveryTime: false });
    assert.equal(byId('secrets-lock').hidden, false);
    assert.equal(byId('secrets-lock-text').textContent, 'Fingerprint secrets: locked');
    assert.equal(byId('secrets-unlock').hidden, false);

    // New secret: defaults unchanged (My commands on, Servers off, no terminal scope from the page).
    const newToggles = byId('secrets-new-toggles').querySelectorAll('input[data-key]');
    assert.deepEqual(Object.fromEntries(newToggles.map((t) => [t.dataset.key, t.checked])), { agent: false, servers: false, redact: true, biometric: false, askEveryTime: false });
    assert.equal(newToggles.find((t) => t.dataset.key === 'askEveryTime').disabled, true, 'ask every time needs fingerprint');
    byId('secrets-name').value = 'bad name';
    byId('secrets-value').value = DUMMY;
    await byId('secrets-form').dispatch('submit');
    assert.ok(!bridge.calls.some(([m]) => m === 'secrets.set'), 'invalid name: nothing sent');
    assert.equal(byId('secrets-error').hidden, false);
    byId('secrets-name').value = 'API_TOKEN';
    byId('secrets-value').value = DUMMY;
    bridge.lockedOnce = true;
    await byId('secrets-form').dispatch('submit');
    await settle();
    const sets = bridge.calls.filter(([m]) => m === 'secrets.set');
    assert.equal(sets.length, 2, 'retried once after the fingerprint unlock');
    assert.ok(bridge.calls.some(([m]) => m === 'secrets.unlock'));
    assert.deepEqual(sets[1][1], { name: 'API_TOKEN', value: DUMMY, scopes: { agent: false, servers: false }, redact: true, biometric: false, askEveryTime: false });
    assert.ok(!('terminal' in sets[1][1].scopes), 'the page never enables the terminal scope');
    assert.equal(byId('secrets-value').value, '', 'value input cleared');
    assert.equal(byId('secrets-name').value, '');
    assert.ok(!visible().includes(DUMMY), 'still no value in the page');

    // Deletion needs an explicit confirmation.
    const names = () => byId('secrets-list').children.map((item) => item.children[0].textContent);
    assert.deepEqual(names().sort(), ['API_TOKEN', 'GH_TOKEN']);
    const deleteButton = (name) => all(byId('secrets-list').children.find((item) => item.children[0].textContent === name)).find((n) => n.tag === 'button' && n.textContent === 'Delete');
    const asked = [];
    globalThis.confirm = (text) => { asked.push(text); return false; };
    await deleteButton('GH_TOKEN').click();
    assert.ok(!bridge.calls.some(([m]) => m === 'secrets.delete'), 'declined: nothing deleted');
    globalThis.confirm = (text) => { asked.push(text); return true; };
    await deleteButton('GH_TOKEN').click();
    await settle();
    assert.deepEqual(bridge.calls.filter(([m]) => m === 'secrets.delete'), [['secrets.delete', { name: 'GH_TOKEN' }]]);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /^Delete GH_TOKEN\?/);
    assert.deepEqual(names(), ['API_TOKEN']);

    // Only the four secrets.* calls; no logging at all.
    assert.ok(bridge.calls.every(([m]) => ['secrets.list', 'secrets.set', 'secrets.delete', 'secrets.unlock'].includes(m)));
    assert.deepEqual(logged, []);
  } finally {
    for (const [level, fn] of Object.entries(saved)) console[level] = fn;
    delete globalThis.__piHostInfo; delete globalThis.confirm; d.restore();
  }
});

test('static: the screen logs nothing, calls only secrets.*, and imports no library', async () => {
  for (const name of ['secrets-settings.js', 'index.js']) {
    const text = await readFile(join(root, 'plugins/core-secrets/web', name), 'utf8');
    assert.ok(!/console\./.test(text), `${name} logs`);
    assert.ok(!/library\//.test(text), `${name} imports the library`);
    for (const [, method] of text.matchAll(/bridge\.call\("([^"]+)"/g)) assert.match(method, /^secrets\.(list|set|delete|unlock)$/);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(text), `${name} persists something`);
  }
});
