import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await import('./build.mjs');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
const name = `self-forming-browser-${version}`;
const staging = resolve(root, '.release-build');
if (relative(root, staging) !== '.release-build') throw new Error('Invalid staging directory');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await cp('dist/browser', resolve(staging, name), { recursive: true });
const filename = `${name}.tar.gz`;
const artifact = resolve(root, 'artifacts', filename);
// bsdtar on Windows and tar on Linux/macOS support this same small argument set.
execFileSync('tar', ['-czf', artifact, '-C', staging, name], { stdio: 'inherit' });
const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
await writeFile(`${artifact}.sha256`, `${digest}  ${filename}\n`);
await rm(staging, { recursive: true, force: true });
console.log(`Created artifacts/${filename}\nSHA-256 ${digest}`);
