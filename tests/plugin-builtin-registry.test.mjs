// Built-in plugins as plugins/<id>/ packages (docs/plugins.md §3a): same package format as
// installed plugins (plugin.json + web/index.js), a generated static registry
// (apps/common/builtin-plugins.js, scripts/gen-builtins.sh), shipped as builtin/<id>/web/**.
// Mocked/no host; no library needed. Not on-device verification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleApp } from './plugin-agent-support.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ids = (await readdir(join(root, 'plugins'))).sort();
const manifest = async (id) => JSON.parse(await readFile(join(root, 'plugins', id, 'plugin.json'), 'utf8'));
const app = await assembleApp({ withLibrary: false }); // entries must not import the library at evaluation
test.after(() => app.remove());
const registry = await app.load('builtin-plugins.js');
const { PLUGIN_BUNDLES, bundleOf } = await app.load('plugin-bundles.js');
const { definitionShell } = await app.load('builtin-definition.js');

const EXPECTED = ['core-agent', 'core-chat', 'core-conversations', 'core-execution', 'core-git', 'core-net-native', 'core-plugin-management', 'core-prompt', 'core-providers-chatgpt', 'core-providers-claude', 'core-providers-offline',
  'core-providers-openai', 'core-net-page', 'exec-js', 'exec-linux', 'net-tor', 'net-tailscale', 'core-secrets', 'core-self-update', 'core-servers', 'core-skills', 'core-storage', 'core-subagents', 'core-tools', 'core-toolchain',
  'look-public',
  'core-workspace-tools'].sort();

test('one folder per built-in with plugin.json and web/index.js; the registry lists exactly them', async () => {
  assert.deepEqual(ids, EXPECTED);
  assert.deepEqual(registry.BUILTIN_PLUGINS.map((item) => item.manifest.id).sort(), EXPECTED);
  for (const id of ids) {
    const json = await manifest(id);
    assert.equal(json.id, id);
    assert.equal(json.builtin, true, id);
    assert.equal(json.api, 1);
    assert.equal(json.web.entry, 'web/index.js');
    await access(join(root, 'plugins', id, 'web/index.js'));
    assert.deepEqual(registry.builtinPlugin(id).manifest, json, `${id}: the registry carries the checked-in manifest`);
    // The manifest's bundle is the bundle plugin-bundles.js groups it in; essential built-ins are the agent's own.
    assert.equal(bundleOf(id)?.id, json.bundle, `${id} bundle`);
    assert.ok(PLUGIN_BUNDLES.some((bundle) => bundle.id === json.bundle));
  }
  const essential = registry.BUILTIN_PLUGINS.filter((item) => item.manifest.essential).map((item) => item.manifest.id).sort();
  assert.ok(!essential.includes('core-execution') && essential.includes('core-agent'));
  assert.ok(!registry.BUILTIN_PLUGINS.some((item) => item.manifest.bundle === 'self-forming-dev' && item.manifest.essential), 'dev tools are never essential');
});

test('the checked-in registry is what scripts/gen-builtins.sh makes (deterministic)', () => {
  const run = (...args) => spawnSync('bash', [join(root, 'scripts/gen-builtins.sh'), ...args], { cwd: root, encoding: 'utf8' });
  const check = run('--check');
  assert.equal(check.status, 0, check.stderr);
  const first = run('--stdout'), second = run('--stdout');
  assert.equal(first.stdout, second.stdout);
});

test('runtime definition shells equal the manifests', async () => {
  for (const { manifest: json } of registry.BUILTIN_PLUGINS) {
    const shell = definitionShell(json.id);
    assert.deepEqual([shell.id, shell.version, shell.reload, shell.essential === true, shell.provides, shell.requires, shell.uses],
      [json.id, json.version, json.reload, json.essential === true, json.provides, json.requires, json.uses], json.id);
  }
});

test('entries keep to the served layout: only sibling files, ../../../ shared modules, no library at evaluation', async () => {
  for (const id of ids) {
    const web = join(root, 'plugins', id, 'web');
    for (const name of await readdir(web, { recursive: true })) {
      if (!name.endsWith('.js')) continue;
      const text = await readFile(join(web, name), 'utf8');
      if (text.length > 100_000) continue; // vendored third-party bundles (third-party/README.md)
      for (const [, path] of text.matchAll(/^import [^"']*["']([^"']+)["']/gm)) {
        // Vendored libraries in web/lib/ (e.g. jose) keep their own relative layout, but only inside web/lib/.
        if (name.startsWith('lib/')) {
          const target = join(web, name, '..', path);
          assert.ok(path.startsWith('.') && target.startsWith(join(web, 'lib') + '/'), `${id}/web/${name} imports ${path} outside web/lib/`);
          continue;
        }
        // Browser Git's fixed pinned assets stay in apps/browser/vendor in source;
        // build-browser rewrites ONLY these two imports to deployed /vendor URLs.
        if (id === 'core-git' && path.startsWith('../../../apps/browser/vendor/')) {
          assert.ok(['browser-git.js', 'browser-buffer-global.js'].includes(name));
          assert.match(path, /^\.\.\/\.\.\/\.\.\/apps\/browser\/vendor\/(?:isomorphic-git\/index|buffer\/buffer)\.js$/);
          continue;
        }
        assert.match(path, /^(\.\/|\.\.\/\.\.\/\.\.\/library\/|\.\.\/\.\.\/\.\.\/[a-z-]+\.js$|\.\.\/\.\.\/core-[a-z-]+\/web\/[a-z-]+\.js$)/, `${id}/web/${name} imports ${path}`);
        // a library import may only happen in a row file loaded lazily by the entry
        if (path.includes('library/')) assert.notEqual(name, 'index.js', `${id}: the entry imports the library`);
      }
    }
  }
});

test('the served path stays clear of installed plugins (/assets/web/plugins/<id>/<hash>/)', async () => {
  const text = await readFile(join(root, 'apps/common/builtin-plugins.js'), 'utf8');
  for (const [, path] of text.matchAll(/from "([^"]+)"/g)) assert.match(path, /^\.\/builtin\/(?:core|net|look|exec)-[a-z-]+\/web\/index\.js$/);
});
