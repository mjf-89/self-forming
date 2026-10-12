import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeNotices } from './notices.mjs';
import { discoverBrowserEntryPoints, forwardingSource, nodeOnlyDurableExports } from './browser-entrypoints.mjs';
import { buildReadableApp } from './readable-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const dist = resolve(root, 'dist');
if (relative(root, dist) !== 'dist') throw new Error('Invalid build directory');
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'browser'), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const browserEntryPoints = await discoverBrowserEntryPoints(root);
// Resolve upstream namespaces independently before generating forwarding source.
// This also rejects selected peer subpaths that upstream no longer exports.
// Sequential: concurrent dynamic imports of interdependent modules can deadlock under Bun.
const runtimeExports = {};
for (const entry of browserEntryPoints) runtimeExports[entry.specifier] = Object.keys(await import(entry.specifier)).sort();

const browserOptions = {
  bundle: true, platform: 'browser', format: 'esm', splitting: true,
  // Fold out the optional upstream Bun fallback; do not provide a Node shim.
  define: { process: 'undefined' },
  target: ['chrome120', 'safari17'], minify: true, sourcemap: true,
  legalComments: 'external', metafile: true,
};
const result = await build({
  ...browserOptions,
  entryPoints: browserEntryPoints.map(entry => ({ in: `upstream:${entry.specifier}`, out: entry.file.replace(/\.js$/, '') })),
  outdir: 'dist/browser', chunkNames: 'chunks/[name]-[hash]',
  plugins: [{ name: 'generated-upstream-entries', setup(builder) {
    builder.onResolve({ filter: /^upstream:/ }, args => {
      const specifier = args.path.slice('upstream:'.length);
      if (!Object.hasOwn(runtimeExports, specifier)) throw new Error(`Unknown generated entry: ${specifier}`);
      return { path: specifier, namespace: 'upstream-entry' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'upstream-entry' }, args => ({
      contents: forwardingSource(args.path, runtimeExports[args.path]),
      resolveDir: root, loader: 'js',
    }));
  } }],
});
const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll('\\', '/'));
for (const path of inputs) {
  if (/\/pi-durable\/dist\/(env\/node|storage\/(sqlite|jsonl)\/node)\.js$/.test(path)) {
    throw new Error(`Browser library contains Node adapter: ${path}`);
  }
  if (path.startsWith('apps/') || path.startsWith('packages/native-host/')) {
    throw new Error(`Upstream browser distribution contains application code: ${path}`);
  }
}
const externalImports = Object.values(result.metafile.outputs).flatMap(out => out.imports.filter(item => item.external));
if (externalImports.length) throw new Error(`Unbundled dependency: ${JSON.stringify(externalImports)}`);
for (const entry of browserEntryPoints) {
  const output = result.metafile.outputs[`dist/browser/${entry.file}`];
  assert.deepEqual(output.exports.toSorted(), runtimeExports[entry.specifier], `Export mismatch: ${entry.specifier}`);
}
const entryPoints = Object.fromEntries(browserEntryPoints.map(entry => [entry.specifier, entry.file]));
await writeFile('dist/browser/import-map.json', JSON.stringify({
  imports: Object.fromEntries(browserEntryPoints.map(entry => [entry.specifier, `./${entry.file}`])),
}, null, 2) + '\n');
await writeFile('dist/browser/build-inputs.json', JSON.stringify(inputs, null, 2) + '\n');
await writeNotices(root, inputs, 'dist/browser/THIRD_PARTY_NOTICES.md');
await cp('LICENSE', 'dist/browser/LICENSE');
await cp('packages/browser/README.md', 'dist/browser/README.md');
await cp('packages/browser/example.html', 'dist/browser/example.html');
await cp('packages/browser/example.js', 'dist/browser/example.js');
const files = {};
for (const name of (await readdir('dist/browser', { recursive: true })).sort()) {
  if (!(await stat(resolve('dist/browser', name))).isFile()) continue;
  const bytes = await readFile(resolve('dist/browser', name));
  files[name.replaceAll('\\', '/')] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile('dist/browser/manifest.json', JSON.stringify({
  name: 'self-forming-browser', version: pkg.version,
  upstream: Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => name.startsWith('@earendil-works/'))),
  entry: 'pi-durable.js', format: 'esm', entryPoints, runtimeExports, files,
  excludedNodeEntryPoints: nodeOnlyDurableExports.map(path => `@earendil-works/pi-durable${path.slice(1)}`),
  targets: ['Chromium 120+', 'Safari/WebKit 17+'],
  note: 'Entry modules preserve upstream APIs. Keep shared chunks with them. Native host adapters and app behavior are distributed separately in the application.',
}, null, 2) + '\n');
await cp('dist/browser', 'dist/app/library', { recursive: true });

// Native adapters and their dependencies are a fixed host module. Every editable
// application module imports this same instance, preserving bridge ownership.
const specifierEntries = new Map(browserEntryPoints.map(entry => [entry.specifier, entry]));
const hostResult = await build({
  ...browserOptions,
  entryPoints: { 'native-host': 'packages/native-host/src/index.ts' },
  outdir: 'dist/app', splitting: false, sourcemap: false,
  plugins: [{ name: 'upstream-browser-modules', setup(builder) {
    builder.onResolve({ filter: /^@earendil-works\// }, args => {
      const entry = specifierEntries.get(args.path);
      if (entry) return { path: `./library/${entry.file}`, external: true };
      throw new Error(`App imports an upstream module outside the browser distribution: ${args.path}`);
    });
  } }],
});
for (const path of Object.keys(hostResult.metafile.inputs)) {
  if (path.replaceAll('\\', '/').includes('/@earendil-works/')) throw new Error(`Native host rebundled upstream module: ${path}`);
}
const { result: appResult, scripts } = await buildReadableApp(root, browserEntryPoints);
await writeNotices(root, [...Object.keys(hostResult.metafile.inputs), ...Object.keys(appResult.metafile.inputs)], 'dist/app/THIRD_PARTY_NOTICES.md');
// Keep the existing embedding/test entrypoint without copying the session implementation.
await writeFile('dist/app/app-session.js', "export * from './session.js';\n");
// The customized app is now the default for browser and Android packaging.
const appAssets = (await readdir('apps/on-device')).filter(name => /\.(html|css)$/.test(name)).sort();
for (const name of appAssets) await cp(`apps/on-device/${name}`, `dist/app/${name}`);
await cp('apps/on-device/fonts', 'dist/app/fonts', { recursive: true }); // bundled SIL OFL fonts, fixed assets
await writeFile('dist/app/app-source-README.md', await readFile('scripts/app-source-README.md', 'utf8'));
const editableFiles = [...appAssets, ...scripts, 'app-session.js'].sort();
const editable = new Set(editableFiles);
const immutableFiles = ['app-manifest.json'];
for (const name of await readdir('dist/app', { recursive: true })) {
  const path = name.replaceAll('\\', '/');
  if ((await stat(resolve('dist/app', name))).isFile() && !editable.has(path)) immutableFiles.push(path);
}
await writeFile('dist/app/app-manifest.json', JSON.stringify({ format: 1, hostVersion: pkg.version,
  editableFiles, immutableFiles: immutableFiles.sort() }, null, 2) + '\n');
await import('./verify-custom-app.mjs');
console.log(`Built ${browserEntryPoints.length} upstream entry modules with exact exports, fixed native adapters and ${scripts.length} readable application modules.`);
