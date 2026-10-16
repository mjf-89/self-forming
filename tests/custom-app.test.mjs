import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildReadableApp } from '../scripts/readable-app.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'pi-custom-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'apps/common'), { recursive: true });
  await mkdir(resolve(root, 'apps/unused'), { recursive: true });
  await writeFile(resolve(root, 'apps/unused/app.ts'), 'throw new Error("Unused app must not be packaged");');
  return root;
}

test('default packaging uses customized JS and keeps native/library modules external', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'apps/common/app.js'), `import { native } from './native-host.js';
import { core } from './library/pi-durable.js';
import { feature } from './feature.js';
export const customized = [native, core, feature];`);
  await writeFile(resolve(root, 'apps/common/feature.js'), 'export const feature = "customized-home";');
  await writeFile(resolve(root, 'apps/common/app-session.js'), "export * from './session.js';\n");
  const { scripts, result } = await buildReadableApp(root, [{ specifier: '@earendil-works/pi-durable', file: 'pi-durable.js' }]);
  assert.deepEqual(scripts, ['app.js', 'feature.js']);
  assert.ok(Object.keys(result.metafile.inputs).every(name => name.startsWith('apps/common/')));
  const app = await readFile(resolve(root, 'dist/app/app.js'), 'utf8');
  assert.match(app, /\.\/native-host\.js/);
  assert.match(app, /\.\/library\/pi-durable\.js/);
  assert.match(app, /customized/);
  assert.doesNotMatch(app, /Unused app/);
});

test('custom sources cannot override host or import an unshipped library', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'apps/common/native-host.js'), 'export const malicious = true;');
  await assert.rejects(buildReadableApp(root, []), /Reserved application module name/);
  await rm(resolve(root, 'apps/common/native-host.js'));
  await writeFile(resolve(root, 'apps/common/app.js'), "import './library/not-shipped.js';");
  await assert.rejects(buildReadableApp(root, []), /Application import has no shipped browser module/);
});

test('custom sources reject output collisions and a modified compatibility facade', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'apps/common/app.js'), 'export const value = 1;');
  await writeFile(resolve(root, 'apps/common/app.ts'), 'export const value = 2;');
  await assert.rejects(buildReadableApp(root, []), /Duplicate application module output name/);
  await rm(resolve(root, 'apps/common/app.ts'));
  await writeFile(resolve(root, 'apps/common/app-session.js'), 'export const replacement = true;');
  await assert.rejects(buildReadableApp(root, []), /Reserved application module name/);
});
