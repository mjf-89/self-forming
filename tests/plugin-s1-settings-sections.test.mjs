import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, El, installDom } from './plugin-p4-support.mjs';

// Step S1 of docs/plugins-ui-editions.md: the settings.sections contribution kind.
// Real plugin runtime + settings-sections.js against a mocked DOM. NOT visual verification.
const { createPluginRuntime } = await import(new URL('../apps/common/plugin-runtime.js', import.meta.url));
const { createSettingsSections, SETTINGS_SECTIONS } = await import(new URL('../apps/common/settings-sections.js', import.meta.url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const wrappers = (container) => container.children.filter((c) => c instanceof El && c.dataset.section);
const names = (container) => wrappers(container).map((w) => w.dataset.section);

function page() {
  const dom = installDom({ 'settings-content': 'div' });
  const container = dom.fixed['settings-content'];
  const static1 = new El('details'); static1.id = 'agent-settings';
  container.append(static1);
  const errors = [];
  const sections = createSettingsSections({ container, onError: (cause, d) => errors.push([d.phase, d.key, String(cause.message ?? cause)]) });
  const runtime = createPluginRuntime({ onError() {} });
  return { dom, container, static1, errors, sections, runtime };
}
function plugin(id, setup) { return { id, version: '1.0.0', setup }; }

test('renders contributed sections in order after the static ones; dispose and removal on scope close', async () => {
  const p = page();
  try {
    const log = [];
    p.runtime.register(plugin('late', (ctx) => { ctx.contribute(SETTINGS_SECTIONS, 'b', { title: 'B', mount: (el) => { log.push('mount b'); return () => log.push('dispose b'); } }, 20); }));
    p.runtime.register(plugin('early', (ctx) => {
      ctx.contribute(SETTINGS_SECTIONS, 'a', { title: 'A', mount: (el, c) => { el.textContent = 'hello'; log.push(`mount a ${c.id}/${c.key}`); } }, 10);
    }));
    await p.sections.connect({ runtime: p.runtime });
    await p.runtime.start();
    await settle();
    assert.deepEqual(names(p.container), ['a', 'b']);
    assert.equal(p.container.children[0], p.static1, 'static section untouched and first');
    const a = wrappers(p.container)[0];
    assert.equal(all(a).find((n) => n.tag === 'h3').textContent, 'A');
    assert.ok(all(a).some((n) => n.textContent === 'hello'));
    assert.deepEqual(log.sort(), ['mount a early/a', 'mount b']);
    await p.runtime.stop('late');
    await settle();
    assert.deepEqual(names(p.container), ['a']);
    assert.ok(log.includes('dispose b'));
    assert.equal(p.sections.count(), 1);
    await p.sections.dispose();
    assert.deepEqual(names(p.container), []);
    assert.equal(p.container.children[0], p.static1);
  } finally { await p.runtime.close(); p.dom.restore(); }
});

test('live add after start; errors (sync throw, async reject, bad value, dispose throw) stay contained', async () => {
  const p = page();
  try {
    let add;
    p.runtime.register(plugin('good', (ctx) => { ctx.contribute(SETTINGS_SECTIONS, 'ok', { title: 'OK', mount() {} }, 5); add = ctx; }));
    p.runtime.register(plugin('bad', (ctx) => {
      ctx.contribute(SETTINGS_SECTIONS, 'throws', { title: 'T', mount() { throw new Error('boom'); } }, 1);
      ctx.contribute(SETTINGS_SECTIONS, 'rejects', { title: 'R', mount: async () => { throw new Error('later'); } }, 2);
      ctx.contribute(SETTINGS_SECTIONS, 'novalue', { title: 'N' }, 3);
      ctx.contribute(SETTINGS_SECTIONS, 'baddispose', { title: 'D', mount: () => () => { throw new Error('dispose boom'); } }, 4);
    }));
    await p.runtime.start();
    await p.sections.connect({ runtime: p.runtime });
    await settle();
    assert.deepEqual(names(p.container), ['throws', 'rejects', 'baddispose', 'ok']);
    const note = (key) => all(wrappers(p.container).find((w) => w.dataset.section === key)).find((n) => n.attrs.role === 'status');
    assert.match(note('throws').textContent, /boom/);
    assert.match(note('rejects').textContent, /later/);
    assert.equal(note('ok'), undefined);
    assert.ok(p.errors.some((e) => e[1] === 'novalue'));
    const late = add.contribute(SETTINGS_SECTIONS, 'extra', { title: 'X', mount() {} }, 0);
    await settle();
    assert.deepEqual(names(p.container), ['extra', 'throws', 'rejects', 'baddispose', 'ok']);
    late();
    await p.runtime.stop('bad');
    await settle();
    assert.deepEqual(names(p.container), ['ok']);
    assert.ok(p.errors.some((e) => e[0] === 'dispose'));
  } finally { await p.runtime.close(); p.dom.restore(); }
});

test('without a runtime nothing happens; async dispose after removal during mount still runs', async () => {
  const p = page();
  try {
    await p.sections.connect({});
    assert.deepEqual(names(p.container), []);
    let release, disposed = false;
    p.runtime.register(plugin('slow', (ctx) => { ctx.contribute(SETTINGS_SECTIONS, 's', { title: 'S', mount: () => new Promise((r) => { release = () => r(() => { disposed = true; }); }) }); }));
    await p.runtime.start();
    await p.sections.connect({ runtime: p.runtime });
    await settle();
    assert.deepEqual(names(p.container), ['s']);
    await p.runtime.stop('slow');
    await settle();
    assert.deepEqual(names(p.container), []);
    release(); await settle();
    assert.equal(disposed, true);
  } finally { await p.runtime.close(); p.dom.restore(); }
});

test('resolveSlot answers slot names that are not fixed (provider options); unknown names still make an ordinary section', async () => {
  const dom = installDom({ 'settings-content': 'div' });
  const container = dom.fixed['settings-content'];
  const host = new El('div'), seen = [];
  const sections = createSettingsSections({ container, resolveSlot: (name) => { seen.push(name); return name === 'provider:svc@1' ? host : null; } });
  const runtime = createPluginRuntime({ onError() {} });
  runtime.register(plugin('pp', (ctx) => {
    ctx.contribute(SETTINGS_SECTIONS, 'in', { title: 'In', slot: 'provider:svc@1', mount() {} }, 1);
    ctx.contribute(SETTINGS_SECTIONS, 'out', { title: 'Out', slot: 'provider:other@1', mount() {} }, 2);
  }));
  try {
    await sections.connect({ runtime });
    await runtime.start();
    await settle();
    assert.deepEqual(host.children.map((c) => c.dataset.section), ['in']);
    assert.deepEqual(names(container), ['out'], 'unresolved slot: ordinary section');
    assert.ok(seen.includes('provider:other@1'));
    await sections.dispose();
  } finally { await runtime.close(); dom.restore(); }
});
