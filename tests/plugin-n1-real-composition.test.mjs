import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, until } from './plugin-agent-support.mjs';
import { El, all, installDom } from './plugin-p4-support.mjs';

// N1 on the phone (0.6.3): Settings → Network listed only "Native network" although core-net-native and
// core-net-page were both active. REAL composition: plugin-bootstrap.js startPluginComposition (fake Android
// bridge + hostInfo), the real settings.js initSettings (bundled panels in their slots, as on the phone) and
// settings-sections.js, against a mocked DOM. Not on-device verification.
Object.defineProperty(El.prototype, 'parentNode', { configurable: true, get() { return this.parent; } });
El.prototype.open = false;
Object.defineProperty(El.prototype, 'nextSibling', { configurable: true, get() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; } });
// A <head> with the two page sheets, enough for plugin-styles.js (links are El 'link' nodes).
function mockHead() {
  const head = new El('head');
  head.querySelectorAll = () => head.children.filter((c) => c.tag === 'link');
  Object.defineProperty(head, 'lastChild', { get: () => head.children.at(-1) ?? null });
  head.insertBefore = (el, ref) => {
    el.parent?.removeChild(el);
    el.parent = head;
    const at = ref ? head.children.indexOf(ref) : -1;
    if (at < 0) head.children.push(el); else head.children.splice(at, 0, el);
  };
  for (const href of ['./app.css', './builtin-styles.css']) { const link = new El('link'); link.setAttribute('href', href); head.insertBefore(link, null); }
  return head;
}
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
      else el.setAttribute(name, value);
    }
    top.append(el);
    if (!selfClosing && !VOID.has(el.tag)) stack.push(el);
  }
}
const IDS = { 'settings-dialog': 'dialog', 'agent-settings': 'details', 'settings-content': 'div', 'chat-settings': 'button', 'settings-close': 'button', 'provider-panels': 'div', 'secrets-panel': 'div', 'plugins-panel': 'div', 'execution-panel': 'div', 'providers-panel': 'div' };
function dom() {
  const d = installDom(Object.fromEntries(Object.entries(IDS).filter(([id]) => !['provider-panels', 'secrets-panel', 'plugins-panel', 'execution-panel', 'providers-panel'].includes(id))), (fixed) => {
    // As index.html: the slots sit inside #settings-content.
    for (const id of ['provider-panels', 'secrets-panel', 'plugins-panel', 'execution-panel', 'providers-panel']) {
      if (IDS[id]) { const slot = Object.assign(new El('div'), { id, className: 'settings-slot' }); fixed['settings-content'].append(slot); }
    }
  });
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    if (tag !== 'template') return create(tag);
    const content = Object.assign(new El('#fragment'), { nodeType: 11 });
    return { content, set innerHTML(html) { parseInto(content, html); } };
  };
  return d;
}
const byId = (id) => globalThis.document.getElementById(id);
const memory = () => {
  const data = new Map();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};

let app, bootstrap, settingsModule, sectionsModule;
before(async () => {
  app = await assembleApp();
  bootstrap = await app.load('plugin-bootstrap.js');
  settingsModule = await app.load('settings.js');
  sectionsModule = await app.load('settings-sections.js');
});
after(async () => { await app?.remove(); });

test('real composition: Settings lists BOTH net.fetch@1 providers in one selector, choosing persists self-forming.net.route', async () => {
  const d = dom();
  const storage = memory();
  const head = globalThis.document.head = mockHead();
  const lookLinks = () => head.children.filter((c) => c.getAttribute('data-plugin-style')?.startsWith('look-')).map((c) => c.getAttribute('href'));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  const errors = [];
  let composition;
  try {
    const { sections } = settingsModule.initSettings();
    const dummy = { id: 'net-dummy', version: '1.0.0', name: 'Dummy route', hint: 'test only', provides: [{ id: 'net.fetch', version: 1 }], setup(ctx) {
      ctx.provide('net.fetch', 1, Object.assign(() => 'dummy', { available: () => true }));
      ctx.contribute('settings.sections', 'dummy-options', { title: 'Dummy options', slot: 'provider:net.fetch@1', mount(el) { const p = globalThis.document.createElement('p'); p.id = 'dummy-option'; el.append(p); return () => p.remove(); } });
    } };
    const bridge = { closed: false, onClose: () => () => {}, call: async (method) => { if (method === 'plugins.list') return { api: 1, plugins: [] }; throw new Error(`unexpected ${method}`); } };
    const hostInfo = { platform: 'android', capabilities: { executionEnv: true, plugins: true } };
    composition = await bootstrap.startPluginComposition({ bridge, hostInfo, openExecution: () => ({}), loadDevTools: async () => ({ createDevPlugins: () => [dummy] }), onError: (error, details) => errors.push([details?.phase, error.message]) });
    const { runtime } = composition;
    const active = Object.fromEntries(runtime.list().map((r) => [r.id, r.state]));
    assert.equal(active['core-net-native'], 'active');
    assert.equal(active['core-net-page'], 'active');
    assert.equal(active['net-tor'], 'active');
    assert.equal(active['net-tailscale'], 'active');
    await sections.connect({ runtime });
    await until(() => (byId('net-route')?.options.length ?? 0) > 1, `the selector lists the providers ${JSON.stringify([runtime.list().filter((r) => r.state !== 'active').map((r) => [r.id, r.reason]), runtime.selection.services(), errors])}`);
    const select = byId('net-route'), line = byId('net-route-status');
    assert.deepEqual(select.options.map((o) => o.value), ['core-net-native', 'core-net-page', 'net-dummy', 'net-tailscale', 'net-tor']);
    assert.deepEqual(select.options.map((o) => o.textContent), ['Native network', 'Page fetch (WebView) — many APIs block it (CORS)', 'Dummy route — test only', 'Tailscale exit node — through your own exit node; needs sign-in; downloads ~38 MB; experimental', 'Tor (Snowflake) — slow to start, experimental; not anonymity; runs a Snowflake proxy']);
    assert.equal(select.disabled, false);
    assert.equal(select.value, 'core-net-native');
    assert.equal(line.textContent, 'Using Native network.');
    assert.equal(line.getAttribute('role'), 'status');
    // It is in the document (not in a detached wrapper), in the Providers section; no Network section exists.
    assert.ok(all(byId('settings-content')).includes(select), 'attached to Settings');
    assert.equal(byId('net-settings'), null, 'no Network section any more');
    // Provider options: the dummy provider's own section sits in the slot under the selector, shown only while selected.
    const option = byId('dummy-option');
    assert.ok(option, 'the dummy provider section mounted');
    const slot = [...all(byId('providers-panel'))].find((n) => n.className === 'provider-slot' && all(n.parent).includes(select));
    assert.ok(slot && all(slot).includes(option), 'inside the net.fetch@1 slot of the Providers section');
    const wrapper = slot.children.find((c) => c.dataset?.plugin === 'net-dummy');
    assert.equal(wrapper.hidden, true, 'hidden while another provider is selected');
    select.value = 'net-dummy';
    await select.dispatch('change');
    assert.equal(storage.getItem('self-forming.net.route'), 'net-dummy');
    assert.equal(wrapper.hidden, false, 'shown while selected');
    select.value = 'core-net-native';
    await select.dispatch('change');
    assert.equal(wrapper.hidden, true);
    assert.equal(storage.getItem('self-forming.net.route'), null);
    select.value = 'core-net-page';
    await select.dispatch('change');
    assert.equal(storage.getItem('self-forming.net.route'), 'core-net-page');
    assert.equal(runtime.selection.choice('net.fetch', 1), 'core-net-page');
    assert.equal(select.value, 'core-net-page');
    // Looks are look@1 providers: with several present (the private tree) Settings → Providers shows a Look row, the default
    // look's sheet is the bundled one (no link), choosing the other swaps the <link> at once and persists per the generic key.
    const looks = runtime.list().filter((r) => r.id.startsWith('look-')).map((r) => r.id).sort();
    if (looks.length > 1) {
      assert.deepEqual(looks, ['look-private', 'look-public']);
      const row = byId('provider-look-1-select');
      assert.ok(row, 'a Look row');
      assert.ok(all(byId('settings-content')).includes(row), 'attached to Settings');
      assert.deepEqual(row.options.map((o) => o.textContent), ['Look: dark', 'Look: light']);
      assert.equal(row.value, 'look-private');
      assert.equal(row.disabled, false);
      assert.equal(byId('provider-look-1-status').textContent, 'Using Look: dark.');
      assert.deepEqual(lookLinks(), [], 'the default look is the bundled sheet: no link');
      row.value = 'look-public';
      await row.dispatch('change');
      assert.equal(storage.getItem('self-forming.provider.look@1'), 'look-public');
      assert.deepEqual(lookLinks(), ['./builtin/look-public/web/look.css'], 'the chosen look is linked at once');
      assert.equal(byId('provider-look-1-status').textContent, 'Using Look: light.');
      row.value = 'look-private';
      await row.dispatch('change');
      assert.equal(storage.getItem('self-forming.provider.look@1'), null);
      assert.deepEqual(lookLinks(), [], 'back to the bundled default: the link is gone');
      assert.equal(runtime.selection.resolve('look', 1).provider, 'look-private');
    } else {
      assert.deepEqual(looks, ['look-public']);
      assert.equal(byId('provider-look-1-select'), null, 'a single look is the default and has no selector');
      assert.deepEqual(lookLinks(), [], 'the only look is the bundled sheet');
    }
    assert.deepEqual(errors, []);
    await sections.dispose();
  } finally { await composition?.runtime.close(); delete globalThis.localStorage; d.restore(); }
});
