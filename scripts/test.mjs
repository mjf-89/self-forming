import { readdir, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
const files = await readdir('tests');
const tests = files.filter(name => name.endsWith('.test.ts'));
await mkdir('.test-build', {recursive:true});
for (const file of tests) await build({entryPoints:[`tests/${file}`],outfile:`.test-build/${file.replace(/\.ts$/, '.mjs')}`,bundle:true,platform:'node',format:'esm',packages:'external',target:'node24'});
const child = spawn(process.execPath, ['--test', ...tests.map(file => `.test-build/${file.replace(/\.ts$/, '.mjs')}`),
  ...files.filter(name => name.endsWith('.test.mjs')).map(file => `tests/${file}`)], {stdio:'inherit'});
child.on('exit', code => { process.exitCode = code ?? 1; });
