import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const nodeOnlyDurableExports = ['./env/node', './storage/jsonl/node', './storage/sqlite/node'];

// Pi Durable is discovered in full. Peer selection is application policy, not
// a copy of their export maps: do not pull every provider or Chord's Node host in.
const packagePolicy = [
  { name: '@earendil-works/pi-durable', exclude: ['./package.json', ...nodeOnlyDurableExports] },
  { name: '@earendil-works/pi-ai', include: ['.', './providers/faux', './providers/openai.models', './api/openai-responses', './providers/anthropic.models', './api/anthropic-messages'] },
  { name: '@earendil-works/chord', include: ['./context'] },
];

function subpathExports(exports, name) {
  if (typeof exports === 'string' || Array.isArray(exports)) return { '.': exports };
  if (!exports || typeof exports !== 'object') throw new Error(`Unsupported exports metadata: ${name}`);
  const keys = Object.keys(exports);
  if (!keys.length) throw new Error(`Empty exports metadata: ${name}`);
  const subpaths = keys.filter(key => key.startsWith('.'));
  if (!subpaths.length) return { '.': exports }; // Root conditional export.
  if (subpaths.length !== keys.length) throw new Error(`Mixed conditions and subpaths: ${name}`);
  return exports;
}

export function generateEntryPoints(configs) {
  const entries = [];
  const outputs = new Set();
  for (const { metadata, include, exclude = [] } of configs) {
    const { name, exports } = metadata;
    if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid package name: ${name}`);
    }
    const exported = subpathExports(exports, name);
    const basename = name.split('/').at(-1);
    for (const subpath of include ?? Object.keys(exported)) {
      if (exclude.includes(subpath) || (!include && exported[subpath] === null)) continue;
      if (subpath.includes('*')) throw new Error(`Select concrete subpaths for wildcard export ${name}:${subpath}`);
      if (subpath !== '.' && (!subpath.startsWith('./') || subpath.slice(2).split('/').some(
        part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..',
      ))) throw new Error(`Invalid export subpath: ${name}:${subpath}`);
      const suffix = subpath === '.' ? '' : subpath.slice(1);
      const file = `${basename}${suffix}.js`;
      if (outputs.has(file.toLowerCase())) throw new Error(`Duplicate browser output: ${file}`);
      outputs.add(file.toLowerCase());
      entries.push({ specifier: `${name}${suffix}`, file });
    }
  }
  return entries.sort((a, b) => a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0);
}

export async function discoverBrowserEntryPoints(root) {
  const configs = await Promise.all(packagePolicy.map(async policy => {
    const metadata = JSON.parse(await readFile(resolve(root, 'node_modules', policy.name, 'package.json'), 'utf8'));
    if (metadata.name !== policy.name) throw new Error(`Unexpected installed package: ${metadata.name}`);
    return { ...policy, metadata };
  }));
  return generateEntryPoints(configs);
}

export function forwardingSource(specifier, runtimeExports) {
  const source = JSON.stringify(specifier);
  return `export * from ${source};\n${runtimeExports.includes('default') ? `export { default } from ${source};\n` : ''}`;
}
