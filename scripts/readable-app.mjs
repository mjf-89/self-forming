import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

/** Package editable modules without bundling the fixed host or upstream libraries.
 * Production uses apps/on-device. Tests can supply a separate fixture directory.
 */
export async function buildReadableApp(root, browserEntryPoints, source = 'apps/on-device') {
  const sourceDirectory = resolve(root, source);
  const nativeDirectory = resolve(root, 'packages/native-host/src');
  const entries = await readdir(sourceDirectory);
  for (const name of ['native-host.ts', 'native-host.js', 'app-session.ts']) {
    if (entries.includes(name)) throw new Error(`Reserved application module name: ${name}`);
  }
  if (entries.includes('app-session.js')) {
    const facade = await readFile(resolve(sourceDirectory, 'app-session.js'), 'utf8');
    if (!/^export \* from ['"]\.\/session\.js['"];?\s*$/.test(facade))
      throw new Error('Reserved application module name: app-session.js');
  }
  const names = entries.filter(name => /\.(ts|js)$/.test(name) && !name.endsWith('.d.ts') && name !== 'app-session.js').sort();
  const appFiles = new Map(names.map(name => [resolve(sourceDirectory, name), name.replace(/\.ts$/, '.js')]));
  if (new Set(appFiles.values()).size !== names.length) throw new Error('Duplicate application module output name');
  const upstream = new Map(browserEntryPoints.map(entry => [entry.specifier, `./library/${entry.file}`]));
  const shippedLibraries = new Set(upstream.values());
  const result = await build({
    absWorkingDir: root,
    entryPoints: names.map(name => ({ in: resolve(sourceDirectory, name), out: name.replace(/\.(ts|js)$/, '') })),
    outdir: 'dist/app', bundle: true, platform: 'browser', format: 'esm', splitting: false,
    minify: false, sourcemap: false, target: ['chrome120', 'safari17'], legalComments: 'inline', metafile: true,
    plugins: [{ name: 'readable-app-modules', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return;
        const library = upstream.get(args.path);
        if (library) return { path: library, external: true };
        if (args.path === './native-host.js' || shippedLibraries.has(args.path)) return { path: args.path, external: true };
        if (args.path.startsWith('.')) {
          const target = resolve(dirname(args.importer), args.path);
          const app = appFiles.get(target);
          if (app) return { path: `./${app}`, external: true };
          const native = relative(nativeDirectory, target).replaceAll('\\', '/');
          if (!native.startsWith('../') && !native.startsWith('/') && native.endsWith('.ts'))
            return { path: './native-host.js', external: true };
        }
        return { errors: [{ text: `Application import has no shipped browser module: ${args.path}` }] };
      });
    } }],
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!appFiles.has(resolve(root, input))) throw new Error(`Editable app bundled a dependency: ${input}`);
  }
  return { result, scripts: [...appFiles.values()] };
}
