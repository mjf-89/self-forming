// `styles` contribution kind: value {href}, relative to the contributing plugin's served web
// root. Built-ins: ./builtin/<id>/web/; installed: /assets/web/plugins/<id>/<hash>/.
// One same-origin <link rel=stylesheet> per contribution, placed after app.css (and the bundled
// builtin-styles.css, when the page links it) in contribution order; contributions disappear with
// their plugin scope, and so do the links.
// T2: the built-in plugins' stylesheets are already applied by the generated builtin-styles.css, which index.html
// links statically (first paint, and the page still looks right when composition fails). A contribution that
// `bundled(pluginId, href)` reports as part of it gets no second link; everything else (installed plugins) is linked here.
// N1: the looks are providers of look@1: a look's styles are applied only while it is the resolved provider (runtime.selection),
// so choosing another look in Settings → Providers swaps the <link> at once (no reload). builtin-styles.css carries only the DEFAULT
// look; every look defines the same tokens, so a linked look overrides it completely. The resolved non-bundled look's href is mirrored in
// localStorage (LOOK_MIRROR) for look-early.js, a classic same-origin script that links it before first paint (no inline script);
// the first sync adopts that early link instead of creating a second one.
// After each sync the page's theme-color follows the look's --paper token.
export const STYLES = 'styles';
export const LOOK_SERVICE = 'look';
export const LOOK_MIRROR = 'self-forming.look.href';
const ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** Returns the safe relative path or throws. Refuses schemes, absolute, protocol-relative,
 *  query/fragment, backslashes, control characters and any parent segment (also percent-encoded). */
export function safeStyleHref(href) {
  if (typeof href !== 'string' || !href || href.length > 512) throw new TypeError('styles href must be a nonempty string');
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { throw new TypeError('styles href is not valid'); }
  for (const text of [href, decoded]) {
    if (/[\\?#\u0000-\u001f]/.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('/')) throw new TypeError(`styles href must be relative to the plugin web root: ${href}`);
    if (text.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new TypeError(`styles href must stay inside the plugin web root: ${href}`);
  }
  return href;
}

export function styleUrl({ id, hash }, href) {
  if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('Invalid plugin id');
  const path = safeStyleHref(href);
  if (hash === undefined) return `./builtin/${id}/web/${path}`;
  if (typeof hash !== 'string' || !/^[a-f0-9]{16,128}$/i.test(hash)) throw new TypeError('Invalid plugin revision hash');
  return `${globalThis.__piBrowser?.pluginAssetBase ?? "/assets/web/plugins/"}${id}/${hash}/${path}`;
}

const PAGE_SHEET = /(^|\/)(app|builtin-styles)\.css(\?|$)/;

/** The page's <meta name="theme-color"> follows the look (--paper of :root); no look, no meta, no computed style: nothing. */
export function syncThemeColor(doc) {
  try {
    const paper = doc?.defaultView?.getComputedStyle?.(doc.documentElement)?.getPropertyValue?.('--paper')?.trim();
    if (!paper || typeof doc.head?.querySelector !== 'function') return;
    let meta = doc.head.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = doc.createElement('meta'); meta.setAttribute('name', 'theme-color'); doc.head.appendChild(meta); }
    meta.setAttribute('content', paper);
  } catch { /* cosmetic only */ }
}

const earlyLinks = (doc) => [...(doc.head.querySelectorAll?.('link[data-early-look]') ?? [])].filter((l) => l.getAttribute?.('data-early-look') != null);

/** Mirrors the resolved look's href (null: the bundled default look, nothing to link early) and drops an early link nobody adopted. */
function mirrorLook(doc, url) {
  try {
    for (const el of earlyLinks(doc)) el.remove();
    const store = doc.defaultView?.localStorage;
    if (!store) return;
    if (url) store.setItem(LOOK_MIRROR, url); else store.removeItem(LOOK_MIRROR);
  } catch { /* cosmetic only */ }
}

/** createPluginStyles({runtime, document, installed: () => [{id, hash}], bundled: (id, href) => boolean, onError}) → {sync, close} */
export function createPluginStyles({ runtime, document: doc = globalThis.document, installed = () => [], bundled = () => false, onError = () => {} }) {
  const links = new Map(); // `${providerId}\n${key}` -> {url, el}
  let off = () => {}, closed = false;
  function sync() {
    if (closed || !doc?.head) return;
    const hashes = new Map((installed() ?? []).map((p) => [p.id, p.hash]));
    const wanted = [];
    const sel = runtime.selection;
    let looks = new Set(), resolved = null;
    try {
      if (sel?.providers) { looks = new Set(sel.providers(LOOK_SERVICE, 1).map((p) => p.id)); if (looks.size) resolved = sel.resolve(LOOK_SERVICE, 1).provider; }
    } catch { looks = new Set(); }
    for (const c of runtime.contributions(STYLES)) {
      if (looks.has(c.providerId) && c.providerId !== resolved) continue; // a look that is not the resolved provider of look@1
      try {
        const url = styleUrl({ id: c.providerId, hash: hashes.get(c.providerId) }, c.value?.href);
        if (hashes.get(c.providerId) === undefined && bundled(c.providerId, c.value?.href)) continue;
        wanted.push({ id: `${c.providerId}\n${c.key}`, url });
      }
      catch (error) { try { onError(error, { phase: 'styles', plugin: c.providerId, key: c.key }); } catch {} }
    }
    const keep = new Set(wanted.map((w) => w.id));
    for (const [id, link] of [...links]) if (!keep.has(id) || link.url !== wanted.find((w) => w.id === id).url) { link.el.remove(); links.delete(id); }
    let anchor = [...(doc.head.querySelectorAll?.('link') ?? [])].filter((l) => !l.getAttribute?.('data-plugin-style') && PAGE_SHEET.test(l.getAttribute?.('href') ?? l.href ?? '')).pop() ?? null;
    for (const w of wanted) {
      let link = links.get(w.id);
      if (!link) {
        const early = earlyLinks(doc).find((l) => l.getAttribute('href') === w.url);
        const el = early ?? doc.createElement('link');
        early?.removeAttribute('data-early-look');
        el.rel = 'stylesheet';
        el.setAttribute('href', w.url);
        el.setAttribute('data-plugin-style', w.id.split('\n')[0]);
        links.set(w.id, link = { url: w.url, el });
      }
      const before = anchor ? anchor.nextSibling : null;
      if (link.el.parentNode !== doc.head || (anchor ? anchor.nextSibling !== link.el : doc.head.lastChild !== link.el)) doc.head.insertBefore(link.el, before ?? null);
      anchor = link.el;
    }
    if (resolved) mirrorLook(doc, wanted.find((w) => w.id.split('\n')[0] === resolved)?.url ?? null);
    syncThemeColor(doc);
  }
  off = runtime.subscribe(() => { try { sync(); } catch (error) { try { onError(error, { phase: 'styles' }); } catch {} } });
  sync();
  return {
    sync,
    close() { closed = true; off(); for (const { el } of links.values()) el.remove(); links.clear(); }
  };
}
