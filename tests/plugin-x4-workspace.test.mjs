import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// Step X4: the text workspace lives in core-execution (plugins/core-execution/web/workspace.js,
// hand-ported from packages/native-host/src/workspace.ts) and is offered as workspace@1. The same
// calls run against the ported workspace and the createNativeWorkspace of the fixed native-host.js
// with a fake bridge; bridge calls, results and errors must be identical. No device.
const available = existsSync(new URL('../dist/app/native-host.js', import.meta.url));
const skip = available ? false : 'dist/app/native-host.js is not present';

let app, ported, original, execution, openSessions;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  ported = await app.load('builtin/core-execution/web/workspace.js');
  original = await app.load('native-host.js');
  execution = await app.load('builtin/core-execution/web/index.js');
  openSessions = await app.load('builtin/core-agent/web/open-sessions.js');
});
after(async () => { await app?.remove(); });

function fakeBridge(files = new Map()) {
  const calls = [];
  return {
    calls, files,
    async call(method, params = {}) {
      calls.push([method, structuredClone(params)]);
      if (method === 'workspace.write') { files.set(params.path, params.text); return null; }
      if (method === 'workspace.read') return params.path === 'weird' ? { text: 5 } : params.path === 'huge' ? { text: 'x'.repeat(1024 * 1024 + 1) } : params.path === 'broken' ? null : { text: files.get(params.path) };
      if (method === 'workspace.list') { if (params.path === 'denied') throw new Error('denied'); return [{ name: 'note.txt', path: 'note.txt', directory: false, size: 5 }]; }
      throw new Error(`unexpected ${method}`);
    }
  };
}
const outcome = async (promise) => { try { return { ok: await promise }; } catch (e) { return { error: e.constructor.name, message: e.message }; } };

async function scenarios(createNativeWorkspace) {
  const bridge = fakeBridge();
  const w = createNativeWorkspace(bridge);
  const out = [];
  out.push(['keys', Object.keys(w).sort()]);
  out.push(['write', await outcome(w.write('note.txt', 'hello'))]);
  out.push(['read', await outcome(w.read('note.txt'))]);
  out.push(['list default', await outcome(w.list())]);
  out.push(['list dir', await outcome(w.list('sub/dir'))]);
  out.push(['list host error', await outcome(w.list('denied'))]);
  for (const path of ['../secret', 'a/../b', '/absolute', 'C:/secret', 'c:rel', 'folder\\secret', 'nul\0path', 5, undefined, null]) {
    out.push([`read ${JSON.stringify(path)}`, await outcome(w.read(path))]);
    out.push([`write ${JSON.stringify(path)}`, await outcome(w.write(path, 'x'))]);
    out.push([`list ${JSON.stringify(path)}`, await outcome(w.list(path))]);
  }
  out.push(['write non-text', await outcome(w.write('a.txt', 5))]);
  out.push(['write multibyte at the limit', await outcome(w.write('limit.txt', '😀'.repeat(262144)))]);
  out.push(['write over the limit', await outcome(w.write('large', '😀'.repeat(262145)))]);
  out.push(['read invalid text', await outcome(w.read('weird'))]);
  out.push(['read null', await outcome(w.read('broken'))]);
  out.push(['read over the limit', await outcome(w.read('huge'))]);
  out.push(['calls', bridge.calls.map(([m, p]) => [m, JSON.stringify(p).slice(0, 80)])]);
  return out;
}

test('ported workspace and the compiled one behave identically', { skip }, async () => {
  const left = await scenarios(ported.createNativeWorkspace);
  const right = await scenarios(original.createNativeWorkspace);
  assert.deepEqual(left, right);
  assert.deepEqual(left.find(([l]) => l === 'keys')[1], ['list', 'read', 'write']);
  assert.equal(left.find(([l]) => l === 'write over the limit')[1].message, 'Workspace text exceeds the 1 MiB limit');
});

test('workspace@1 from core-execution opens the workspace over the page bridge', { skip }, async () => {
  const bridge = fakeBridge();
  const provided = new Map();
  execution.create({ bridge, hostInfo: { capabilities: { executionEnv: true } } }).setup({
    signal: new AbortController().signal, contribute() {}, provide: (id, version, value) => provided.set(`${id}@${version}`, value)
  });
  assert.deepEqual([...provided.keys()].sort(), ['execution@1', 'workspace@1']);
  const workspace = provided.get('workspace@1').open();
  await workspace.write('a.txt', 'one');
  assert.equal(await workspace.read('a.txt'), 'one');
  assert.deepEqual(bridge.calls.map(([m]) => m), ['workspace.write', 'workspace.read']);
  const other = fakeBridge();
  await provided.get('workspace@1').open(other).write('b.txt', 'two');
  assert.equal(other.calls[0][0], 'workspace.write');
  const manifest = JSON.parse(await readFile(new URL('../plugins/core-execution/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.provides, [{ id: 'execution', version: 1 }, { id: 'workspace', version: 1 }]);
  // Without a bridge there is nothing to open; a stopped plugin refuses.
  const bare = new Map();
  execution.create({}).setup({ signal: new AbortController().signal, contribute() {}, provide: (id, v, value) => bare.set(id, value) });
  assert.throws(() => bare.get('workspace').open(), /native host/);
  const stop = new AbortController(); const stopped = new Map();
  execution.create({ bridge }).setup({ signal: stop.signal, contribute() {}, provide: (id, v, value) => stopped.set(id, value) });
  stop.abort();
  assert.throws(() => stopped.get('workspace').open(), /stopped/);
});

test('fallback: native-host.js createNativeWorkspace only when workspace.js cannot load', { skip }, async () => {
  const errors = [];
  const old = console.error; console.error = (...args) => errors.push(args);
  try {
    assert.equal(await execution.loadNativeWorkspace({ load: () => Promise.reject(new Error('broken')) }), original.createNativeWorkspace);
    assert.equal(await execution.loadNativeWorkspace({ load: async () => ({}) }), original.createNativeWorkspace);
    const bridge = fakeBridge();
    const bundled = execution.createWorkspace({ bridge, loaded: () => execution.loadNativeWorkspace({ load: () => Promise.reject(new Error('x')) }) });
    await bundled.write('f.txt', 'via native-host.js');
    assert.equal(bridge.files.get('f.txt'), 'via native-host.js');
  } finally { console.error = old; }
  assert.equal(await execution.loadNativeWorkspace(), ported.createNativeWorkspace);
  assert.equal(execution.createWorkspace({}), undefined);
});

test('core-agent: composed fetch resolves per request and fails closed; only absent composition uses page copies', { skip }, async () => {
  const bridge = {};
  const pageFetch = () => 'page', serviceFetch = () => 'service';
  const pageWorkspace = { page: true }, serviceWorkspace = { service: true };
  const services = { net: () => serviceFetch, workspace: () => ({ open: () => serviceWorkspace }) };
  assert.equal(await openSessions.fetchOption({ bridge, fetch: pageFetch }, services).fetch('https://example.test/'), 'service');
  assert.equal(openSessions.workspaceOption({ bridge, workspace: pageWorkspace }, services).workspace, serviceWorkspace);
  // Composition absent: the page's bundled copy. A managed getter returning null/throwing
  // is different: fail closed rather than pinning the session to that bundled fallback.
  assert.equal(openSessions.fetchOption({ bridge, fetch: pageFetch }, {}).fetch, pageFetch);
  for (const broken of [{ net: () => null, workspace: () => null }, { net: () => { throw new Error('x'); }, workspace: () => { throw new Error('x'); } }]) {
    await assert.rejects(openSessions.fetchOption({ bridge, fetch: pageFetch }, broken).fetch('https://example.test/'), /Network is unavailable/);
    assert.equal(openSessions.workspaceOption({ bridge, workspace: pageWorkspace }, broken).workspace, pageWorkspace);
  }
  assert.equal(openSessions.fetchOption({ fetch: pageFetch }, services).fetch, pageFetch, 'no bridge: page fetch');
  await assert.rejects(openSessions.fetchOption({ bridge, fetch: pageFetch }, { net: () => undefined }).fetch('https://example.test/'), /Network is unavailable/);
  assert.deepEqual(openSessions.workspaceOption({ bridge }, {}), {}, 'nothing: the session engine decides (last resort)');
  assert.equal(openSessions.workspaceOption({ workspace: pageWorkspace }, services).workspace, pageWorkspace, 'no bridge: page copy');

  assert.equal(await openSessions.fetchOption({ bridge }, { net: () => serviceFetch }).fetch('https://example.test/'), 'service'); // net is a getter; its result is itself a fetch
});
