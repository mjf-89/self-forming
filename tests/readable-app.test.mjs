import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReadableApp } from '../scripts/readable-app.mjs';

async function fixture(t) {
  const temporary = resolve(tmpdir());
  const root = await mkdtemp(resolve(temporary, 'pi-readable-app-'));
  t.after(async () => {
    assert.ok(!relative(temporary, root).startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(resolve(root, 'apps/fixture'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}\n');
  return root;
}

test('readable modules preserve shared native and upstream instances without bundling dependencies', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'apps/fixture/app.ts'), `
import { bridge } from '../../packages/native-host/src/bridge.ts';
import { identity } from '@earendil-works/pi-durable';
import { session } from './session.ts';
export function inspectSharedInstances(): unknown[] { return [bridge, identity, ...session()]; }
`);
  await writeFile(resolve(root, 'apps/fixture/session.ts'), `
import { bridge } from '../../packages/native-host/src/index.ts';
import { identity } from '@earendil-works/pi-durable';
export function session() { return [bridge, identity]; }
`);
  // Added application modules are discovered rather than maintained in an entrypoint list.
  await writeFile(resolve(root, 'apps/fixture/new-feature.ts'), 'export const readableName: string = "new feature";\n');
  const { result, scripts } = await buildReadableApp(root, [{ specifier: '@earendil-works/pi-durable', file: 'pi-durable.js' }], 'apps/fixture');
  assert.deepEqual(scripts, ['app.js', 'new-feature.js', 'session.js']);
  assert.ok(Object.keys(result.metafile.inputs).every(path => path.startsWith('apps/fixture/')));
  assert.ok(Object.values(result.metafile.outputs).flatMap(output => output.imports).every(item => item.external));
  const app = await readFile(resolve(root, 'dist/app/app.js'), 'utf8');
  assert.match(app, /function inspectSharedInstances\(\)/);
  assert.match(app, /\.\/native-host\.js/);
  assert.match(app, /\.\/library\/pi-durable\.js/);
  assert.match(app, /\.\/session\.js/);
  assert.doesNotMatch(app, /from ["'][^"']*\.ts["']/);
  assert.ok(app.split('\n').length > 8);
  await mkdir(resolve(root, 'dist/app/library'), { recursive: true });
  await writeFile(resolve(root, 'dist/app/native-host.js'), 'export const bridge = {};\n');
  await writeFile(resolve(root, 'dist/app/library/pi-durable.js'), 'export const identity = {};\n');
  const { inspectSharedInstances } = await import(pathToFileURL(resolve(root, 'dist/app/app.js')).href);
  const [bridge, upstream, sameBridge, sameUpstream] = inspectSharedInstances();
  assert.equal(bridge, sameBridge);
  assert.equal(upstream, sameUpstream);
});

test('readable packaging rejects imports requiring an unshipped package or missing app module', async t => {
  const root = await fixture(t);
  for (const specifier of ['unshipped-package', './missing.ts']) {
    await writeFile(resolve(root, 'apps/fixture/app.ts'), `import { value } from '${specifier}'; export { value };\n`);
    await assert.rejects(buildReadableApp(root, [], 'apps/fixture'), /Application import has no shipped browser module/);
  }
});

test('editable source names cannot overwrite the fixed native adapters or session facade', async t => {
  const root = await fixture(t);
  await writeFile(resolve(root, 'apps/fixture/native-host.ts'), 'export const overwrite = true;\n');
  await assert.rejects(buildReadableApp(root, [], 'apps/fixture'), /Reserved application module name/);
});
