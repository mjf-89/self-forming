import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE, root } from './plugin-p5-support.mjs';

// Step P5: the openai-compatible package is a valid web-only M1 package (scripts/plugin.sh
// check), declares what the plan fixes (id, reload "page", the endpoints service), keeps
// the MIT attribution of the ported pi-ai code and imports nothing but its own files
// (no bundled pi-ai, no app modules). Static checks only.
test('scripts/plugin.sh check accepts the package', () => {
  const result = spawnSync('bash', [join(root, 'scripts/plugin.sh'), 'check', PACKAGE], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^Valid M1 package: [a-f0-9]{64}$/m);
});

test('manifest: id openai-compatible, web-only, reload page, provides openai-compatible.endpoints@1', async () => {
  const manifest = JSON.parse(await readFile(join(PACKAGE, 'plugin.json'), 'utf8'));
  assert.equal(manifest.id, 'openai-compatible');
  assert.equal(manifest.api, 1);
  assert.equal(manifest.reload, 'page');
  assert.deepEqual(manifest.web, { entry: 'web/index.js' });
  assert.equal(manifest.native, undefined);
  assert.deepEqual(manifest.provides, [{ id: 'openai-compatible.endpoints', version: 1 }]);
  assert.deepEqual(manifest.requires, []);
});

test('web modules import only their siblings; the port carries the MIT notice; no keys or logging', async () => {
  const files = (await readdir(join(PACKAGE, 'web'))).filter((name) => name.endsWith('.js'));
  assert.deepEqual(files.sort(), ['endpoints.js', 'index.js', 'openai-completions.js', 'provider.js', 'tool.js']);
  for (const name of files) {
    const source = await readFile(join(PACKAGE, 'web', name), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.match(specifier, /^\.\/[a-z-]+\.js$/, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(/, `${name}: no dynamic imports`);
    assert.doesNotMatch(source, /console\.(log|info|debug|warn|error)/, `${name}: no logging`);
    assert.doesNotMatch(source, /\bsk-[A-Za-z0-9]{20,}/, `${name}: no key-like literals`);
  }
  const port = await readFile(join(PACKAGE, 'web/openai-completions.js'), 'utf8');
  assert.match(port, /pi-ai v1\.0\.4, packages\/ai\/src\/api\/openai-completions\.ts/);
  assert.match(port, /MIT License/);
  assert.match(port, /Copyright \(c\) 2025 Mario Zechner/);
  assert.match(port, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
