import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'apps/common');
const output = resolve(root, 'dist/app');
const manifest = JSON.parse(await readFile(resolve(output, 'app-manifest.json'), 'utf8'));
const names = (await readdir(source)).filter(name => /\.(js|css|html)$/.test(name));
for (const name of names) {
  assert.ok(manifest.editableFiles.includes(name), `Not editable/shipped: ${name}`);
  assert.ok(!manifest.immutableFiles.includes(name), `Wrongly immutable: ${name}`);
  assert.ok((await stat(resolve(output, name))).isFile(), `Missing output: ${name}`);
  const text = await readFile(resolve(output, name), 'utf8');
  if (/\.(html|css)$/.test(name)) assert.equal(text, await readFile(resolve(source, name), 'utf8'), `Asset differs: ${name}`);
  const references = name.endsWith('.html') ? [...text.matchAll(/(?:src|href)=["'](\.\/[^"']+)["']/g)].map(m => m[1])
    : name.endsWith('.js') ? [...text.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+)["']/g)].map(m => m[1]) : [];
  for (const reference of references) assert.ok((await stat(resolve(output, reference))).isFile(), `Missing dependency of ${name}: ${reference}`);
}
for (const id of await readdir(resolve(root, 'plugins'))) {
  const entry = `builtin/${id}/web/index.js`;
  assert.ok(manifest.editableFiles.includes(entry), `Built-in plugin not shipped: ${entry}`);
  assert.ok((await stat(resolve(output, entry))).isFile(), `Missing output: ${entry}`);
}
for (const forbidden of ['.pi-secrets', 'vault.key', 'node_modules', 'github-cli-local']) {
  assert.ok(!manifest.editableFiles.some(name => name.includes(forbidden)), `Private/runtime file included: ${forbidden}`);
}
const html = await readFile(resolve(output, 'index.html'), 'utf8');
for (const id of ['chat-screen','welcome','settings-dialog','provider-panels']) assert.ok(html.includes(`id="${id}"`), `Missing customized feature: ${id}`);
// S1a: the sign-in panels are contributed by the provider plugins.
for (const [mode, id] of [['chatgpt', 'chatgpt-login'], ['claude', 'claude-login']]) assert.ok((await readFile(resolve(output, `builtin/core-providers-${mode}/web/settings-panel.js`), 'utf8')).includes(`id="${id}"`), `Missing customized feature: ${id}`);
assert.ok(manifest.immutableFiles.includes('native-host.js'));
console.log(`Verified customized fresh-install assets: ${names.length} editable files, local dependencies, and fixed-host boundary.`);
