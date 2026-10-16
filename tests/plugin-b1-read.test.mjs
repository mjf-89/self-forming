import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createPluginFileReader, loadInstalledPlugins, pluginFiles } from '../apps/common/plugin-client.js';
import { createSkillMirror, servedSkillSource } from '../apps/common/plugin-skills.js';

// Track B part 1: reading installed plugin files through the bridge method plugins.read
// (host capability pluginRead) instead of fetch, which the 0.5.x page CSP refuses. The
// bridge is a fake that mimics PluginHost's answers; the native rules (selected/pinned
// revision, canonical web/ path, size, encodings) are in the JVM checks. Not on-device.
const HASH = 'a'.repeat(64);
const SKILL = '---\nname: notes\ndescription: Take notes. Use when notes are asked for.\n---\n\n# Notes\nÜber\n';
const manifest = (options = {}) => ({
  id: 'notes', name: 'Notes', version: '0.1.0', hash: HASH, enabled: true, state: 'installed',
  web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [], uses: [], ...options
});

function fakeBridge(files = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'plugins.list') return { api: 1, plugins: [manifest()] };
      if (method !== 'plugins.read') throw new Error(`unexpected ${method}`);
      const bytes = files[`${params.id}@${params.hash}/${params.path}`];
      if (bytes === undefined) throw Object.assign(new Error('No such readable file in the plugin revision'), { code: 'NOT_FOUND' });
      const buffer = Buffer.from(bytes);
      const text = (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return undefined; } })();
      if (params.encoding !== 'base64' && text !== undefined) return { path: params.path, size: buffer.length, encoding: 'text', text };
      return { path: params.path, size: buffer.length, encoding: 'base64', data: buffer.toString('base64') };
    }
  };
}
async function load(bridge, capabilities) {
  const runtime = createPluginRuntime();
  let context;
  await loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities }, eventPort: null, importModule: async () => ({ setup(ctx) { context = ctx; } }) });
  await runtime.start();
  return { runtime, context };
}
function withFetch(fetch, block) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  return Promise.resolve().then(block).finally(() => { globalThis.fetch = saved; });
}

test('pluginRead hosts: skills are read through plugins.read (pinned id/hash, bytes), never fetch', async () => {
  const bridge = fakeBridge({
    [`notes@${HASH}/web/skills/notes/SKILL.md`]: SKILL,
    [`notes@${HASH}/web/skills/notes/assets/logo.bin`]: new Uint8Array([0, 255, 254, 10])
  });
  const { runtime } = await load(bridge, { plugins: true, pluginRead: true });
  assert.ok(pluginFiles(), 'the page reader is available after loading on a pluginRead host');
  await withFetch(async () => assert.fail('fetch must not be used'), async () => {
    const source = servedSkillSource();
    assert.equal(new TextDecoder().decode(await source.read('notes', HASH, 'web/skills/notes/SKILL.md')), SKILL);
    assert.deepEqual([...await source.read('notes', HASH, 'web/skills/notes/assets/logo.bin')], [0, 255, 254, 10]);
    await assert.rejects(source.read('notes', HASH, 'web/skills/notes/missing.md'), /Could not read web\/skills\/notes\/missing\.md of notes: No such readable file/);
    await assert.rejects(source.read('notes', HASH, '../plugin.json'), /Invalid plugin file/);
  });
  const reads = bridge.calls.filter(([method]) => method === 'plugins.read');
  assert.deepEqual(reads[0], ['plugins.read', { id: 'notes', hash: HASH, path: 'web/skills/notes/SKILL.md', encoding: 'base64' }]);
  assert.equal(reads.length, 3);
  await runtime.close();
});

test('the skill mirror copies {files} skills from the snapshot through plugins.read', async () => {
  const bridge = fakeBridge({
    [`notes@${HASH}/web/skills/notes/SKILL.md`]: SKILL,
    [`notes@${HASH}/web/skills/notes/scripts/run.sh`]: '#!/bin/sh\necho notes\n'
  });
  const { runtime } = await load(bridge, { plugins: true, pluginRead: true });
  const dir = await mkdtemp(join(tmpdir(), 'plugin-b1-read-'));
  try {
    const env = {
      cwd: dir,
      exec(command, { cwd = dir, onOutput } = {}) {
        return new Promise((resolve) => {
          const child = spawn('bash', ['-c', command], { cwd });
          child.stdout.on('data', (data) => onOutput?.(String(data)));
          child.stderr.on('data', (data) => onOutput?.(String(data)));
          child.on('close', (exitCode) => resolve({ ok: true, value: { exitCode } }));
        });
      },
      async writeFile(path, data) { await writeFile(path, data); return { ok: true, value: undefined }; },
      async readTextFile(path) { try { return { ok: true, value: await readFile(path, 'utf8') }; } catch (error) { return { ok: false, error }; } }
    };
    const mirror = createSkillMirror({ env, source: servedSkillSource() });
    const result = await withFetch(async () => assert.fail('fetch must not be used'),
      () => mirror.sync([{ pluginId: 'notes', hash: HASH, name: 'notes', files: ['SKILL.md', 'scripts/run.sh'] }]));
    assert.deepEqual(result.failed, []);
    assert.equal(await readFile(join(dir, '.skills/notes/notes/SKILL.md'), 'utf8'), SKILL);
    assert.equal(await readFile(join(dir, '.skills/notes/notes/scripts/run.sh'), 'utf8'), '#!/bin/sh\necho notes\n');
    assert.equal(mirror.location('notes', HASH, 'notes'), join(dir, '.skills/notes/notes/SKILL.md'));
  } finally {
    await new Promise((resolve) => spawn('chmod', ['-R', 'u+w', dir]).on('close', resolve));
    await rm(dir, { recursive: true, force: true });
    await runtime.close();
  }
});

test('ctx.native.readFile reads this revision only and needs the capability', async () => {
  const bridge = fakeBridge({ [`notes@${HASH}/web/data/list.json`]: '{"a":1}' });
  const { runtime, context } = await load(bridge, { plugins: true, pluginRead: true });
  assert.deepEqual(await context.native.readFile('web/data/list.json'), { path: 'web/data/list.json', size: 7, encoding: 'text', text: '{"a":1}' });
  assert.equal((await context.native.readFile('web/data/list.json', { encoding: 'base64' })).data, Buffer.from('{"a":1}').toString('base64'));
  assert.deepEqual(bridge.calls.at(-1), ['plugins.read', { id: 'notes', hash: HASH, path: 'web/data/list.json', encoding: 'base64' }]);
  await assert.rejects(context.native.readFile('plugin.json'), /beneath web\//);
  await runtime.close();
  await assert.rejects(context.native.readFile('web/data/list.json'), /scope is closed/);

  const old = await load(fakeBridge(), { plugins: true });
  await assert.rejects(old.context.native.readFile('web/data/list.json'), /0\.6\.0/);
  await old.runtime.close();
});

test('hosts without pluginRead keep the served-URL fetch (browser edition, 0.5.x Android)', async () => {
  const bridge = fakeBridge();
  const { runtime } = await load(bridge, { plugins: true, nativePlugins: false });
  assert.equal(pluginFiles(), null, 'a later page load on an older host clears the reader');
  const urls = [];
  await withFetch(async (url) => { urls.push(url); return new Response('hi'); }, async () => {
    assert.equal(new TextDecoder().decode(await servedSkillSource().read('notes', HASH, 'web/skills/notes/SKILL.md')), 'hi');
  });
  assert.deepEqual(urls, [`/assets/web/plugins/notes/${HASH}/web/skills/notes/SKILL.md`]);
  assert.equal(bridge.calls.some(([method]) => method === 'plugins.read'), false);
  await runtime.close();
});

test('explicit sources win: files reader or fetch option', async () => {
  const reads = [];
  const files = { async read(id, hash, path) { reads.push(path); return new TextEncoder().encode('from files'); } };
  assert.equal(new TextDecoder().decode(await servedSkillSource({ files }).read('notes', HASH, 'web/a.md')), 'from files');
  assert.deepEqual(reads, ['web/a.md']);
  const reader = createPluginFileReader(fakeBridge({ [`notes@${HASH}/web/a.md`]: 'x' }));
  assert.equal(new TextDecoder().decode(await reader.read('notes', HASH, 'web/a.md')), 'x');
  await assert.rejects(reader.read('notes', HASH, 'plugin.json'), /beneath web\//);
  await assert.rejects(reader.read('Notes', HASH, 'web/a.md'), /Invalid plugin id/);
  await assert.rejects(createPluginFileReader({ async call() { return { encoding: 'text' }; } }).read('notes', HASH, 'web/a.md'), /Invalid plugins.read response/);
  assert.throws(() => createPluginFileReader(), /bridge/);
});
