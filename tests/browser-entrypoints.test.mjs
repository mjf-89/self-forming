import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardingSource, generateEntryPoints } from '../scripts/browser-entrypoints.mjs';

const target = name => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
const metadata = (exports, name = '@earendil-works/pi-durable') => ({ name, exports });
const filesBySpecifier = entries => Object.fromEntries(entries.map(entry => [entry.specifier, entry.file]));
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

test('entry discovery includes a newly added concrete upstream export without a forwarding file', () => {
  const original = { '.': target('index'), './env': target('env/index') };
  const before = generateEntryPoints([{ metadata: metadata(original) }]);
  const after = generateEntryPoints([{ metadata: metadata({ ...original, './new-feature': target('new-feature/index') }) }]);
  assert.deepEqual(filesBySpecifier(before), {
    '@earendil-works/pi-durable': 'pi-durable.js',
    '@earendil-works/pi-durable/env': 'pi-durable/env.js',
  });
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(filesBySpecifier(after), {
    ...filesBySpecifier(before),
    '@earendil-works/pi-durable/new-feature': 'pi-durable/new-feature.js',
  });
});

test('entry discovery respects explicit Node adapter and package metadata exclusions', () => {
  const entries = generateEntryPoints([{
    metadata: metadata({
      '.': target('index'),
      './env': target('env/index'),
      './env/node': target('env/node'),
      './storage/jsonl': target('storage/jsonl/index'),
      './storage/jsonl/node': target('storage/jsonl/node'),
      './storage/sqlite': target('storage/sqlite/index'),
      './storage/sqlite/node': target('storage/sqlite/node'),
      './package.json': './package.json',
    }),
    exclude: ['./env/node', './storage/jsonl/node', './storage/sqlite/node', './package.json'],
  }]);
  assert.deepEqual(filesBySpecifier(entries), {
    '@earendil-works/pi-durable': 'pi-durable.js',
    '@earendil-works/pi-durable/env': 'pi-durable/env.js',
    '@earendil-works/pi-durable/storage/jsonl': 'pi-durable/storage/jsonl.js',
    '@earendil-works/pi-durable/storage/sqlite': 'pi-durable/storage/sqlite.js',
  });
});

test('selected peer entrypoints work with the current Pi AI wildcard export map', () => {
  const entries = generateEntryPoints([{
    metadata: metadata({
      '.': target('index'),
      './providers/*': target('providers/*'),
      './api/*': target('api/*'),
      './utils/*': target('utils/*'),
    }, '@earendil-works/pi-ai'),
    include: ['.', './providers/faux', './providers/openai.models', './api/openai-responses'],
  }]);
  assert.deepEqual(filesBySpecifier(entries), {
    '@earendil-works/pi-ai': 'pi-ai.js',
    '@earendil-works/pi-ai/providers/faux': 'pi-ai/providers/faux.js',
    '@earendil-works/pi-ai/providers/openai.models': 'pi-ai/providers/openai.models.js',
    '@earendil-works/pi-ai/api/openai-responses': 'pi-ai/api/openai-responses.js',
  });
});

test('automatic discovery rejects wildcard families rather than silently omitting them', () => {
  assert.throws(() => generateEntryPoints([{
    metadata: metadata({ '.': target('index'), './future/*': target('future/*') }),
  }]));
});

test('root export string, condition object and fallback array normalize to the root entry', () => {
  for (const exports of [
    './dist/index.js',
    { browser: './dist/browser.js', import: './dist/index.js', default: './dist/index.js' },
    ['./dist/index.js', './dist/fallback.js'],
  ]) {
    assert.deepEqual(generateEntryPoints([{ metadata: metadata(exports) }]), [
      { specifier: '@earendil-works/pi-durable', file: 'pi-durable.js' },
    ]);
  }
});

test('entry paths reject traversal and browser URL ambiguity before generating files', () => {
  for (const subpath of [
    './../outside', './nested/../../outside', './nested//empty', './nested\\outside',
    './query?value', './fragment#value', './',
  ]) {
    assert.throws(() => generateEntryPoints([{
      metadata: metadata({ '.': target('index'), [subpath]: target('other') }),
    }]), `accepted unsafe subpath ${JSON.stringify(subpath)}`);
  }
  assert.throws(() => generateEntryPoints([{
    metadata: metadata({ '.': target('index') }), include: ['../outside'],
  }]));
});

test('output collisions fail across scopes and case-insensitive filesystems', () => {
  assert.throws(() => generateEntryPoints([
    { metadata: metadata({ '.': target('index') }, '@first/shared') },
    { metadata: metadata({ '.': target('index') }, '@second/shared') },
  ]));
  assert.throws(() => generateEntryPoints([{
    metadata: metadata({ './Tools': target('upper'), './tools': target('lower') }),
  }]));
});

test('unsupported package metadata fails instead of producing an incomplete API', () => {
  for (const exports of [undefined, null, false, 42]) {
    assert.throws(() => generateEntryPoints([{ metadata: metadata(exports) }]));
  }
  assert.throws(() => generateEntryPoints([{ metadata: { exports: { '.': target('index') } } }]));
  assert.throws(() => generateEntryPoints([{
    metadata: metadata({ '.': target('index'), import: './dist/index.js' }),
  }]));
});

test('forwarding preserves named and default exports as live bindings in a real module', async () => {
  const specifier = moduleUrl(`
    export let count = 0;
    export function increment() { count++; }
    const identity = { purpose: 'default export fixture' };
    export default identity;
  `);
  const upstream = await import(specifier);
  const forwarded = await import(moduleUrl(forwardingSource(specifier, Object.keys(upstream))));
  assert.deepEqual(Object.keys(forwarded).sort(), Object.keys(upstream).sort());
  assert.equal(forwarded.default, upstream.default);
  assert.equal(forwarded.increment, upstream.increment);
  assert.equal(forwarded.count, 0);
  upstream.increment();
  assert.equal(forwarded.count, 1);
});

test('forwarding a named-only module does not invent a default export', async () => {
  const specifier = moduleUrl('export const namedOnly = 19;');
  const upstream = await import(specifier);
  const forwarded = await import(moduleUrl(forwardingSource(specifier, Object.keys(upstream))));
  assert.deepEqual(Object.keys(forwarded), ['namedOnly']);
  assert.equal(forwarded.namedOnly, 19);
});
