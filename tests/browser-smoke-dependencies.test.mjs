// Offline assembled-layout regression; no remote endpoint or visual browser required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const explicit = process.env.PI_BROWSER_TEST_DIST;
if (explicit !== undefined) {
  assert.ok(explicit.startsWith('file:///') && explicit.endsWith('/'),
    'PI_BROWSER_TEST_DIST must name an assembled file:///.../ directory (trailing slash required)');
}
const dist = new URL(explicit ?? '../dist/browser/', import.meta.url);
// Literal relative static imports/re-exports and dynamic imports, including side-effect imports.
const imports = text => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g)].map(m => m[1]);

test('the assembled smoke page and its local module dependency closure resolve', () => {
  const seen = new Set();
  function visit(url) {
    assert.ok(url.href.startsWith(dist.href), `dependency escapes output: ${url}`);
    assert.ok(statSync(url).isFile(), `missing dependency: ${url}`);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const text = readFileSync(url, 'utf8');
    for (const specifier of imports(text)) visit(new URL(specifier, url));
  }
  for (const page of ['network-smoke.html']) {
    const url = new URL(page, dist);
    const html = readFileSync(url, 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length, `${page}: no inline scripts`);
    let count = 0;
    for (const [, script] of scripts) for (const specifier of imports(script)) {
      count++;
      visit(new URL(specifier, url));
    }
    assert.ok(count, `${page}: no relative module imports checked`);
  }
  assert.ok(seen.has(new URL('builtin/core-git/web/browser-git.js', dist).href));
});

test('assembled owning git@1 service loads Git.version without filesystem or network access', async () => {
  let files = 0, requests = 0;
  const noFiles = Object.fromEntries(['readFile', 'writeFile', 'stat', 'readdir', 'mkdir', 'rm'].map(name => [name, async () => { files++; throw new Error('smoke must not access filesystem'); }]));
  const { createGitService } = await import(new URL('builtin/core-git/web/index.js', dist));
  const service = createGitService({ fs: noFiles, fetch: async () => { requests++; throw new Error('smoke must not access network'); } });
  assert.match(await service.call({ operation: 'version', signal: new AbortController().signal }), /^\d+\.\d+/);
  assert.equal(files, 0);
  assert.equal(requests, 0);
});
