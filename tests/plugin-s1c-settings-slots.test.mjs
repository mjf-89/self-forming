import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { assembleApp, until } from './plugin-agent-support.mjs';
import { all, El, installDom } from './plugin-p4-support.mjs';

// Step S1c of docs/plugins-ui-editions.md: core-execution owns Settings → Background work and
// core-plugin-management owns Settings → Plugins (settings.sections slots "execution" and
// "plugins"); the bundled copies in app.js keep both working when composition fails. Real
// runtime + settings-sections.js against a mocked DOM. NOT visual or on-device verification.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
Object.defineProperty(El.prototype, 'parentNode', { configurable: true, get() { return this.parent; } });
El.prototype.open = false;
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
  const d = installDom({ 'settings-content': 'div', 'plugins-panel': 'div', 'execution-panel': 'div', 'chat-settings': 'button' });
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
const EXEC_IDS = ['execution-settings', 'execution-status', 'execution-refresh', 'execution-battery', 'execution-stop'];
const PLUGIN_IDS = ['plugin-settings', 'plugin-group-conversation', 'plugin-conversation-title', 'plugin-list', 'plugin-group-builtin', 'plugin-builtin-count', 'plugin-builtin', 'plugin-group-installed', 'plugin-installed-title', 'plugin-installed', 'plugin-status'];

let app, registry, exec, plug, builtins, runtimeModule, sectionsModule;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  registry = await app.load('builtin-plugins.js');
  exec = registry.builtinPlugin('core-execution').entry;
  plug = registry.builtinPlugin('core-plugin-management').entry;
  builtins = await app.load('plugin-builtins.js');
  runtimeModule = await app.load('plugin-runtime.js');
  sectionsModule = await app.load('settings-sections.js');
});
after(async () => { await app?.remove(); });

test('package: modules moved into the plugin web folders; markup left index.html for empty slots, same ids', async () => {
  for (const name of ['execution-settings.js', 'plugin-settings.js']) await assert.rejects(access(join(root, 'apps/common', name)), `${name} moved, not copied`);
  await access(join(root, 'plugins/core-execution/web/execution-settings.js'));
  await access(join(root, 'plugins/core-plugin-management/web/plugin-settings.js'));
  const html = await readFile(join(root, 'apps/common/index.html'), 'utf8');
  for (const id of [...EXEC_IDS, ...PLUGIN_IDS]) assert.ok(!html.includes(`id="${id}"`), `#${id} left index.html`);
  assert.ok(html.includes('<div id="plugins-panel" class="settings-slot"></div>'));
  assert.ok(html.includes('<div id="execution-panel" class="settings-slot"></div>'));
  const ids = (markup) => [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(exec.section.markup), EXEC_IDS);
  assert.deepEqual(ids(plug.section.markup), PLUGIN_IDS);
  assert.deepEqual([exec.section.slot, exec.section.slotId, plug.section.slot, plug.section.slotId], ['execution', 'execution-panel', 'plugins', 'plugins-panel']);
  // The registry must not reach plugin-settings.js (it imports the registry: import cycle).
  assert.ok(!(await readFile(join(root, 'plugins/core-plugin-management/web/index.js'), 'utf8')).match(/^import[^\n]*plugin-settings\.js/m));
});

test('wiring: app.js mounts both bundled copies before initPluginSettings; settings.js gives the slots', async () => {
  const appText = await readFile(join(root, 'apps/common/app.js'), 'utf8');
  assert.ok(!appText.includes('./execution-settings.js') && !appText.includes('"./plugin-settings.js"'));
  const mounts = [appText.indexOf('coreExecution.mountBundled();'), appText.indexOf('builtinPlugin("core-plugin-management").entry.mountBundled();')];
  assert.ok(mounts.every((at) => at > 0 && at < appText.indexOf('initPluginSettings({')));
  assert.ok(appText.indexOf('coreExecution.initExecutionSettings(bridge)') > appText.indexOf('globalThis.__piHostInfo = hostInfo;'));
  const settingsText = await readFile(join(root, 'apps/common/settings.js'), 'utf8');
  assert.match(settingsText, /plugins: \(\) => \$\("plugins-panel"\)/);
  assert.match(settingsText, /execution: \(\) => \$\("execution-panel"\)/);
});

test('composition: both plugins mount the SAME nodes into slotted sections; stop moves them back', async () => {
  const d = dom();
  try {
    assert.equal(exec.mountBundled(), 1);
    assert.equal(plug.mountBundled(), 1);
    assert.equal(exec.mountBundled() + plug.mountBundled(), 0, 'idempotent');
    const refs = Object.fromEntries([...EXEC_IDS, ...PLUGIN_IDS].map((id) => [id, byId(id)]));
    const errors = [];
    const sections = sectionsModule.createSettingsSections({ container: d.fixed['settings-content'], slots: { plugins: () => byId('plugins-panel'), execution: () => byId('execution-panel') }, onError: (cause, details) => errors.push([details.phase, details.key, cause.message]) });
    const runtime = runtimeModule.createPluginRuntime({ onError() {} });
    for (const definition of builtins.createBuiltinPlugins({ openExecution() {}, agentTools: { hostInfo: {}, capabilities: { executionEnv: true, plugins: true }, loadBuilders: async () => ({}) } })) runtime.register(definition);
    await sections.connect({ runtime });
    await runtime.start();
    await until(() => slotted(d.fixed['execution-panel']).length === 1 && slotted(d.fixed['plugins-panel']).length === 1, 'both sections');
    assert.equal(slotted(d.fixed['execution-panel'])[0].dataset.plugin, 'core-execution');
    assert.equal(slotted(d.fixed['plugins-panel'])[0].dataset.plugin, 'core-plugin-management');
    assert.equal(d.fixed['plugins-panel'].children.length, 1, 'no bare bundled copy left behind');
    for (const [id, node] of Object.entries(refs)) assert.equal(byId(id), node, `#${id}: same element`);
    await runtime.stop('core-execution');
    await runtime.stop('core-plugin-management');
    await settle();
    assert.deepEqual(d.fixed['execution-panel'].children.map((x) => x.id), ['execution-settings']);
    assert.deepEqual(d.fixed['plugins-panel'].children.map((x) => x.id), ['plugin-settings'], 'back in the bundled place');
    await sections.dispose();
    assert.deepEqual(errors, []);
    await runtime.close();
  } finally { d.restore(); }
});

test('failed composition: bundled copies stay in their slots; Plugins screen and Background work still wire up', async () => {
  const d = dom();
  try {
    exec.mountBundled(); plug.mountBundled();
    const sections = sectionsModule.createSettingsSections({ container: d.fixed['settings-content'], slots: { plugins: () => byId('plugins-panel'), execution: () => byId('execution-panel') } });
    await sections.connect({ runtime: null });
    assert.deepEqual(d.fixed['plugins-panel'].children.map((x) => x.id), ['plugin-settings']);
    const settings = (await app.load('builtin/core-plugin-management/web/plugin-settings.js')).initPluginSettings({ getSession: () => ({ snapshot: { conversation: { id: 1 } }, plugins: () => [] }) });
    assert.equal(typeof settings.update, 'function');
    const calls = [];
    exec.initExecutionSettings({ call: async (method) => { calls.push(method); return { commands: 2, backgroundCommands: 1 }; } });
    await settle();
    assert.equal(byId('execution-settings').hidden, false);
    assert.deepEqual(calls, ['env.service.info']);
    assert.equal(byId('execution-status')._text, '2 running commands \xB7 1 continuing in the background.');
    assert.equal(byId('execution-stop').disabled, false);
    assert.equal(typeof exec.executionOwner(), 'string');
  } finally { d.restore(); }
});
