// Test support: the effective style of a stylesheet set, without a browser (not a visual check).
// effectiveStyle(css, {readImport}) -> Map "media | selector | property" -> value, where
//  - selector lists are split (".a, .b { x }" gives one key per selector),
//  - the last declaration of the same key wins (an earlier !important is kept against a later plain one),
//  - @import url(...) is replaced by the imported sheet (readImport(url) -> text), which is how the browser orders it,
//  - every var(--token[, fallback]) is replaced by the winning :root token value.
// Different selectors are never compared (no specificity model); the test pairs this with the golden values of HEAD.

const clean = (text) => text.replace(/\s+/g, ' ').trim();

function stripComments(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\/\*|\*\//.test(text.replace(/"[^"\n]*"|'[^'\n]*'/g, ''))) throw new Error('unterminated or stray comment marker in the stylesheet');
  return text;
}

function splitTop(text, separator) { // split on a character outside quotes and parentheses
  const parts = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseBlocks(css) { // top-level items: {prelude, body|null}
  const items = []; let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i += 1;
    if (i >= css.length) break;
    let j = i, depth = 0, quote = '';
    for (; j < css.length; j += 1) {
      const c = css[j];
      if (quote) { if (c === '\\') j += 1; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (depth === 0 && (c === '{' || c === ';')) break;
    }
    const prelude = css.slice(i, j).trim();
    if (css[j] === ';' || j >= css.length) { items.push({ prelude, body: null }); i = j + 1; continue; }
    let level = 1, k = j + 1; quote = '';
    for (; k < css.length && level > 0; k += 1) {
      const c = css[k];
      if (quote) { if (c === '\\') k += 1; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') level += 1;
      else if (c === '}') level -= 1;
    }
    if (level !== 0) throw new Error(`unbalanced braces near: ${prelude.slice(0, 60)}`);
    items.push({ prelude, body: css.slice(j + 1, k - 1) });
    i = k;
  }
  return items;
}

export function effectiveStyle(css, { readImport = () => { throw new Error('no @import reader'); } } = {}) {
  const table = new Map(); // key -> {value, important}
  const put = (media, selector, property, raw) => {
    let value = clean(raw), important = false;
    if (/!important$/i.test(value)) { important = true; value = clean(value.replace(/!important$/i, '')); }
    const key = `${media} | ${selector} | ${property}`;
    const old = table.get(key);
    if (old?.important && !important) return;
    table.set(key, { value, important });
  };
  const walk = (text, media) => {
    for (const { prelude, body } of parseBlocks(stripComments(text))) {
      if (/^@import\b/i.test(prelude)) {
        const url = /^@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/i.exec(prelude)?.[1];
        if (!url) throw new Error(`cannot read ${prelude}`);
        walk(readImport(url), media);
      } else if (/^@media\b/i.test(prelude)) walk(body, `${media}${media ? ' and ' : ''}${clean(prelude)}`);
      else if (/^@keyframes\b/i.test(prelude)) put(media, clean(prelude), 'frames', body);
      else if (prelude.startsWith('@')) { if (body !== null) put(media, clean(prelude), 'at-rule', body); }
      else if (body !== null) {
        const declarations = splitTop(body, ';').map((part) => part.trim()).filter(Boolean).map((part) => {
          const at = part.indexOf(':');
          return [part.slice(0, at).trim(), part.slice(at + 1)];
        });
        for (const selector of splitTop(prelude, ',').map(clean)) for (const [property, value] of declarations) put(media, selector, property, value);
      }
    }
  };
  walk(css, '');
  const tokens = new Map();
  // Custom properties: any selector's (e.g. --send on .composer-panel), :root's win.
  for (const [key, { value }] of table) { const [, selector, property] = key.split(' | '); if (selector !== ':root' && property.startsWith('--')) tokens.set(property, value); }
  for (const [key, { value }] of table) { const [media, selector, property] = key.split(' | '); if (media === '' && selector === ':root' && property.startsWith('--')) tokens.set(property, value); }
  const resolve = (value, depth = 0) => {
    if (depth > 12) throw new Error(`var() cycle in ${value}`);
    let out = '', i = 0;
    while (i < value.length) {
      const at = value.indexOf('var(', i);
      if (at < 0) { out += value.slice(i); break; }
      out += value.slice(i, at);
      let level = 1, j = at + 4;
      for (; j < value.length && level > 0; j += 1) { if (value[j] === '(') level += 1; else if (value[j] === ')') level -= 1; }
      const inner = value.slice(at + 4, j - 1);
      const comma = splitTop(inner, ',');
      const name = comma[0].trim();
      const fallback = comma.length > 1 ? comma.slice(1).join(',').trim() : undefined;
      const found = tokens.get(name) ?? fallback;
      if (found === undefined) throw new Error(`undefined token ${name}`);
      out += resolve(found, depth + 1);
      i = j;
    }
    return clean(out);
  };
  const result = new Map();
  for (const [key, { value }] of table) result.set(key, resolve(value));
  return result;
}

/** The sheets of a source tree in browser order: app.css, then builtin-styles.css (when it exists) with its
 *  @import url(./builtin/<id>/web/x.css), served from plugins/<id>/web/x.css. Returns {text, readImport}. */
export async function loadSheets(root, { read, exists }) {
  let text = await read(`${root}/apps/common/app.css`);
  const generated = `${root}/apps/common/builtin-styles.css`;
  if (await exists(generated)) text += `\n${await read(generated)}`;
  const readImport = (url) => {
    const match = /^\.\/builtin\/([^/]+)\/web\/(.+)$/.exec(url);
    if (!match) throw new Error(`unexpected @import ${url}`);
    return read(`${root}/plugins/${match[1]}/web/${match[2]}`);
  };
  return { text, readImport };
}

/** Plain-object form for JSON golden files. */
export const toObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
