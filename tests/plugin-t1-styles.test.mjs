import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createPluginStyles, safeStyleHref, styleUrl } from '../apps/common/plugin-styles.js';

// Mocked DOM: only what plugin-styles.js touches. Not on-device verification.
function mockDocument() {
  const head = { children: [], get firstChild() { return this.children[0] ?? null; }, get lastChild() { return this.children.at(-1) ?? null; },
    querySelectorAll() { return this.children.filter((c) => c.tag === 'link'); },
    insertBefore(el, ref) { const i = this.children.indexOf(el); if (i >= 0) this.children.splice(i, 1); el.parentNode = this;
      const at = ref ? this.children.indexOf(ref) : -1; if (at < 0) this.children.push(el); else this.children.splice(at, 0, el); } };
  const make = (tag) => { const el = { tag, attrs: {}, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k] ?? null; },
    get nextSibling() { const c = this.parentNode?.children; return c?.[c.indexOf(this) + 1] ?? null; },
    remove() { const c = this.parentNode?.children; if (c) c.splice(c.indexOf(this), 1); this.parentNode = null; } };
    return el; };
  const app = make('link'); app.attrs.href = './app.css'; head.insertBefore(app, null);
  return { head, createElement: make, hrefs: () => head.children.map((c) => c.attrs.href) };
}
const plugin = (id, setup) => ({ id, version: '1.0.0', setup });

test('adds links after app.css in contribution order and removes them with the scope', async () => {
  const doc = mockDocument();
  const runtime = createPluginRuntime({});
  runtime.register(plugin('plug-a', (ctx) => { ctx.contribute('styles', 'z', { href: 'z.css' }, 2); ctx.contribute('styles', 'x', { href: 'css/x.css' }, 1); }));
  runtime.register(plugin('plug-b', (ctx) => { ctx.contribute('styles', 'main', { href: 'b.css' }, 3); }));
  await runtime.start();
  const styles = createPluginStyles({ runtime, document: doc, installed: () => [{ id: 'plug-b', hash: 'a'.repeat(64) }] });
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin/plug-a/web/css/x.css', './builtin/plug-a/web/z.css', `/assets/web/plugins/plug-b/${'a'.repeat(64)}/b.css`]);
  assert.ok(doc.head.children.slice(1).every((l) => l.rel === 'stylesheet'));
  await runtime.stop('plug-a');
  assert.deepEqual(doc.hrefs(), ['./app.css', `/assets/web/plugins/plug-b/${'a'.repeat(64)}/b.css`]);
  styles.close();
  assert.deepEqual(doc.hrefs(), ['./app.css']);
});

test('refuses non-relative and parent-escaping hrefs', async () => {
  for (const bad of ['/x.css', '//evil/x.css', 'https://e/x.css', 'data:text/css,a', '../x.css', 'a/../../x.css', '%2e%2e/x.css', 'a%2f..%2fx.css', 'a\\b.css', 'x.css?y', '', 5, null])
    assert.throws(() => safeStyleHref(bad), TypeError, String(bad));
  assert.equal(safeStyleHref('theme/dark.css'), 'theme/dark.css');
  assert.throws(() => styleUrl({ id: '../x' }, 'a.css'));
  const doc = mockDocument(); const errors = [];
  const runtime = createPluginRuntime({});
  runtime.register(plugin('evil', (ctx) => { ctx.contribute('styles', 'a', { href: '../../secret.css' }); ctx.contribute('styles', 'b', { href: 'ok.css' }, 1); }));
  await runtime.start();
  createPluginStyles({ runtime, document: doc, onError: (e) => errors.push(e) });
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin/evil/web/ok.css']);
  assert.ok(errors.length >= 1);
});

test('T2: bundled built-in stylesheets get no second link; links go after app.css and builtin-styles.css', async () => {
  const doc = mockDocument();
  const bundledSheet = doc.createElement('link'); bundledSheet.attrs.href = './builtin-styles.css'; doc.head.insertBefore(bundledSheet, null);
  const runtime = createPluginRuntime({});
  runtime.register(plugin('core-x', (ctx) => { ctx.contribute('styles', 'core-x/x.css', { href: 'x.css' }); }));
  runtime.register(plugin('plug-b', (ctx) => { ctx.contribute('styles', 'plug-b/b.css', { href: 'b.css' }); }));
  await runtime.start();
  const hash = 'b'.repeat(64);
  const styles = createPluginStyles({ runtime, document: doc, installed: () => [{ id: 'plug-b', hash }], bundled: (id, href) => id === 'core-x' && href === 'x.css' || id === 'plug-b' });
  // core-x is bundled; plug-b is an installed package (has a hash), so it is linked even though `bundled` says yes.
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css', `/assets/web/plugins/plug-b/${hash}/b.css`]);
  styles.close();
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css']);
});

test('N1: looks are look@1 providers; only the resolved one is linked, switching swaps the link at once, the href is mirrored for look-early.js', async () => {
  const doc = mockDocument();
  const store = new Map();
  doc.defaultView = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  const bundledSheet = doc.createElement('link'); bundledSheet.attrs.href = './builtin-styles.css'; doc.head.insertBefore(bundledSheet, null);
  // An early link made by look-early.js for the saved choice.
  const early = doc.createElement('link'); early.attrs.href = './builtin/look-b/web/look.css'; early.attrs['data-early-look'] = ''; doc.head.insertBefore(early, null);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  store.set('self-forming.provider.look@1', 'look-b');
  const runtime = createPluginRuntime({ storage });
  const look = (id, isDefault) => ({ id, version: '1.0.0', name: `Look ${id}`, provides: [{ id: 'look', version: 1, ...isDefault ? { default: true } : {} }],
    setup(ctx) { ctx.provide('look', 1, { name: id, styles: ['look.css'] }); ctx.contribute('styles', `${id}/look.css`, { href: 'look.css' }, 100); } });
  runtime.register(look('look-a', true));
  runtime.register(look('look-b', false));
  await runtime.start();
  const bundled = (id) => id === 'look-a'; // the default's sheet is in builtin-styles.css
  const styles = createPluginStyles({ runtime, document: doc, bundled });
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css', './builtin/look-b/web/look.css']);
  assert.equal(doc.head.children.at(-1), early, 'the early link is adopted, not duplicated');
  assert.equal(early.getAttribute('data-early-look'), null);
  assert.equal(store.get('self-forming.look.href'), './builtin/look-b/web/look.css');
  runtime.selection.choose('look', 1, 'look-a');
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css'], 'the default look is the bundled sheet: no link');
  assert.equal(store.has('self-forming.look.href'), false);
  runtime.selection.choose('look', 1, 'look-b');
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css', './builtin/look-b/web/look.css']);
  assert.equal(store.get('self-forming.look.href'), './builtin/look-b/web/look.css');
  // A stale early link nobody adopts is removed at the next sync.
  const stale = doc.createElement('link'); stale.attrs.href = './builtin/look-zz/web/look.css'; stale.attrs['data-early-look'] = ''; doc.head.insertBefore(stale, null);
  styles.sync();
  assert.deepEqual(doc.hrefs(), ['./app.css', './builtin-styles.css', './builtin/look-b/web/look.css']);
  styles.close();
});
