import test from 'node:test';
import { heavy } from "./heavy.mjs";
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { create, createGitService } from '../plugins/core-git/web/index.js';
import { createBrowserExecution } from '../plugins/core-execution/web/browser/browser-execution.js';
import { createJavaScriptShell } from '../plugins/exec-js/web/browser/js-shell.js';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';

// Real console module in a separate thread, with only the browser Worker envelope adapted.
class BrowserWorker {
  constructor(url) {
    this.worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
      globalThis.self = globalThis;
      self.addEventListener = () => {};
      globalThis.postMessage = data => parentPort.postMessage(data);
      import(${JSON.stringify(url.href)}).then(() => parentPort.on('message', data => self.onmessage({data})));`, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message }));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { void this.worker.terminate(); }
}
const offline = () => { throw new Error('Unexpected network'); };
const identity = { name: 'Generated test identity', email: 'test@example.invalid' };

async function fixture(t) {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  let service;
  let output = '';
  const backend = createBrowserExecution({ vfs, git: () => service, network: { fetch: offline }, shells: { javascript: createJavaScriptShell() },
    emit: event => { if (event.event === 'env.output') output += Buffer.from(event.data, 'base64').toString(); } });
  service = createGitService({ fs: backend.filesystem, fetch: offline });
  t.after(() => backend.dispose());
  return { vfs, backend, service, output: () => output, setService: value => { service = value; } };
}

test('Git lives only in its owner; worker has no implementation URL/import', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const name of ['git', 'buffer-global', 'network-ui', 'snowflake', 'preconnect']) {
    assert.equal(existsSync(new URL(`../apps/browser/browser-${name}.js`, import.meta.url)), false);
  }
  const worker = source('../plugins/exec-js/web/browser/browser-console-worker.js');
  assert.doesNotMatch(worker, /gitModuleUrl|createBrowserGit|import\(git/);
  assert.match(worker, /type: "git"/);
});

test('composition registers the shared browser service; fallback reuses it after scope close', async t => {
  const { service } = await fixture(t);
  const runtime = createPluginRuntime({ storage: null });
  runtime.register({ id: 'core-git', version: '1.0.0', provides: [{ id: 'git', version: 1 }], ...create({ service, hostInfo: { platform: 'browser' } }) });
  await runtime.start();
  const value = runtime.service('git', 1);
  assert.equal(await value.call({ operation: 'version' }), '1.44.2');
  await runtime.close();
  assert.equal(await service.call({ operation: 'version' }), '1.44.2');
  assert.throws(() => value.call({ operation: 'version' }), /stopped/);
  const android = createPluginRuntime({ storage: null });
  android.register({ id: 'core-git', version: '1.0.0', provides: [{ id: 'git', version: 1 }], ...create({ service, hostInfo: { platform: 'android' } }) });
  await android.start();
  assert.equal(android.service('git', 1), null);
  await android.close();
});

test('real worker -> git@1 -> shared filesystem, callbacks, cwd, binary results and explicit identity', async t => {
  const prior = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  t.after(() => { globalThis.Worker = prior; });
  const f = await fixture(t);
  const result = await f.backend.methods['env.exec']({ shell: 'javascript', id: 'git', owner: 'test', timeout: 15, command: `
    process.chdir('/workspace/repo');
    await git.init({defaultBranch:'main'});
    await fs.writeFile('binary', new Uint8Array([0, 128, 255]));
    await git.add({filepath:'binary'});
    try { await git.commit({message:'must not use implicit config'}); throw new Error('missing identity accepted'); }
    catch (e) { if(e.code !== 'AuthorRequired') throw e; }
    const oid = await git.commit({message:'test', onAuthor: async info => {
      if(info.dir !== '/workspace/repo') throw new Error('cwd lost');
      return ${JSON.stringify(identity)};
    }});
    const blob = await git.readBlob({oid, filepath:'binary'});
    if (!(blob.blob instanceof Uint8Array) || blob.blob[2] !== 255) throw new Error('binary lost');
    console.log('git-rpc-ok', (await git.log())[0].commit.author.email);
  ` });
  assert.equal(result.exitCode, 0, f.output());
  assert.match(f.output(), /git-rpc-ok test@example.invalid/);
  assert.deepEqual([...await f.vfs.read('/workspace/repo/binary')], [0, 128, 255]);
});

test('worker cancellation aborts service lifetime and pending callback; no direct fetch escape', async t => {
  const prior = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  t.after(() => { globalThis.Worker = prior; });
  const f = await fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let signal;
  f.setService({ async call(input) {
    signal = input.signal;
    entered();
    await input.options.onAuth('https://example.invalid', {});
  } });
  const run = f.backend.methods['env.exec']({ shell: 'javascript', id: 'cancel', owner: 'test', timeout: 10,
    command: `await git.fetch({onAuth: () => new Promise(() => {})})` });
  await started;
  const rejected = assert.rejects(run, /aborted/i);
  f.backend.methods['env.exec.cancel']({ id: 'cancel' });
  await rejected;
  assert.equal(signal.aborted, true);
});

test('service rejects unknown operations, respects cancellation and loads lazily', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.call({ operation: 'constructor' }), { code: 'InvalidGitOperation' });
  const controller = new AbortController();
  controller.abort(new Error('test abort'));
  await assert.rejects(service.call({ operation: 'init', signal: controller.signal }), /test abort/);
  let loads = 0;
  const lazy = createGitService({ load: () => { loads++; throw new Error('test load failure'); } });
  assert.equal(loads, 0);
  await assert.rejects(lazy.call({ operation: 'version' }), /test load failure/);
  await assert.rejects(lazy.call({ operation: 'version' }), /test load failure/);
  assert.equal(loads, 2);
});

test('worker auth/progress callbacks stay per-call and callback failures retain error codes', async t => {
  const prior = globalThis.Worker;
  globalThis.Worker = BrowserWorker;
  t.after(() => { globalThis.Worker = prior; });
  const f = await fixture(t);
  f.setService({ async call({ options }) {
    await options.onProgress({ phase: 'test-progress' });
    const auth = await options.onAuth('https://example.invalid', {});
    assert.deepEqual(auth, { username: 'synthetic-test-user', password: 'synthetic-not-a-secret' });
    await options.onAuthFailure('https://example.invalid', {});
  } });
  const result = await f.backend.methods['env.exec']({ shell: 'javascript', id: 'callbacks', owner: 'test', timeout: 10, command: `
    let progress = false;
    try {
      await git.fetch({
        onProgress: info => { progress = info.phase === 'test-progress'; },
        onAuth: () => ({username:'synthetic-test-user',password:'synthetic-not-a-secret'}),
        onAuthFailure: () => { throw Object.assign(new Error('test refusal'), {code:'TestRefusal'}); }
      });
      throw new Error('unexpected success');
    } catch (e) { if(e.code !== 'TestRefusal' || !progress) throw e; }
    console.log('callbacks-ok');
  ` });
  assert.equal(result.exitCode, 0, f.output());
  assert.match(f.output(), /callbacks-ok/);
});

// Renderer tests exercise the explicit existing slots, not a second chat DOM.
import { El } from './plugin-p4-support.mjs';
import { mountBrowserNetwork, createNetworkDiagnostics } from '../plugins/net-tailscale/web/browser-network-ui.js';
import { mountTorProgress } from '../plugins/net-tor/web/browser-progress.js';
import { mountSnowflakeSettings } from '../plugins/net-tor/web/browser-snowflake.js';
import { mountPreconnect } from '../plugins/core-agent/web/browser-preconnect.js';
import { createBrowserActivity } from '../plugins/core-chat/web/browser-activity.js';
import { createController } from '../plugins/core-git/web/index.js';
import { assembleApp } from './plugin-agent-support.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function dom() {
  class Node extends El {
    prepend(child) { this.append(child); this.children.unshift(this.children.pop()); }
    after(child) { this.parent?.append(child); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener); }
    get classList() {
      const set = new Set(this.className.split(' ').filter(Boolean));
      const save = () => { this.className = [...set].join(' '); };
      return { add: value => { set.add(value); save(); }, remove: value => { set.delete(value); save(); },
        toggle: (value, on) => { if (on) set.add(value); else set.delete(value); save(); } };
    }
  }
  const doc = new Node('document');
  doc.createElement = tag => Object.assign(new Node(tag), { ownerDocument: doc });
  doc.head = doc.createElement('head'); doc.body = doc.createElement('body');
  const anchor = doc.createElement('div'), notices = doc.createElement('div');
  doc.body.append(anchor, notices);
  return { doc, anchor, notices };
}

test('network owner views retain placement, progress, failure/timing and Snowflake status and release late subscriptions', async () => {
  const { doc, anchor, notices } = dom();
  const diagnostics = createNetworkDiagnostics();
  const listeners = new Set();
  let stopped = 0, resolveOff;
  const network = { ...diagnostics, getStatus: async () => ({ status: 'ready' }),
    subscribe(fn) { listeners.add(fn); return new Promise(resolve => { resolveOff = () => resolve(() => { stopped++; listeners.delete(fn); }); }); } };
  // Separate sources allow testing independent late attachment cleanup.
  const progressListeners = new Set();
  const progress = { getStatus: async () => ({}), subscribe(fn) { progressListeners.add(fn); return () => { stopped++; progressListeners.delete(fn); }; } };
  const stopDiagnostics = mountBrowserNetwork(network, { anchor, document: doc });
  const stopProgress = mountTorProgress(progress, { anchor: notices, document: doc });
  const box = notices.children[0];
  for (const fn of progressListeners) fn({ torState: 'initializing', progress: { phase: 'bridge', done: 2, total: 4, since: Date.now() } });
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /Tor.*2\/4/);
  assert.equal(box.children[1].children[0].style.width, '50%');
  for (const fn of progressListeners) fn({ torState: 'ready', lastStartMs: 3000 });
  assert.match(box.textContent, /connected in 0:03/);
  const row = doc.body.children[2];
  for (const fn of listeners) fn({ status: 'Tor ready', recentTorRequests: [{ origin: 'https://example.invalid', reused: true, firstByteMs: 2000 }] });
  diagnostics.report({ url: 'https://example.invalid/path?discard-query' }, new Error('synthetic failure'));
  assert.match(row.textContent, /reused connection.*first byte after 2.0 s/);
  assert.match(row.textContent, /synthetic failure/);
  assert.doesNotMatch(row.textContent, /discard-query/);
  let showProxy, offProxy = 0;
  const stopSnowflake = mountSnowflakeSettings({ subscribe(fn) { showProxy = fn; return () => offProxy++; } }, { anchor, document: doc });
  const proxyRow = doc.body.children.at(-1);
  showProxy({ active: true, state: 'running', clients: 1, helped: 2, bytes: 1048576 });
  assert.equal(proxyRow.hidden, false);
  assert.match(proxyRow.textContent, /1 connected now.*2 people helped.*1.0 MB/);
  showProxy({ active: false, state: 'stopped', helped: 2, bytes: 0 });
  assert.equal(proxyRow.hidden, true);
  stopDiagnostics(); stopProgress(); stopSnowflake();
  resolveOff(); await tick();
  assert.equal(stopped, 2); assert.equal(offProxy, 1);
  assert.equal(doc.head.children.length, 0); assert.equal(notices.children.length, 0);
  assert.equal(doc.body.children.length, 2);
  diagnostics.dispose();
});

test('preconnect policy uses supplied metadata/events, 20s throttle, direct hints only, scoped cleanup', async () => {
  let time = 0, activity, visibility, status, cleanups = 0;
  let provider = { id: 'custom', preconnectOrigins: ['https://custom.example', 'https://u:p@invalid.example', 'https://invalid.example/path'] };
  const warmed = [], hints = [];
  const stop = mountPreconnect({
    getProvider: () => provider, now: () => time,
    network: { preconnect: async origin => { warmed.push(origin); return { route: origin.includes('direct') ? 'direct' : 'tor' }; },
      subscribe(fn) { status = fn; return () => cleanups++; } },
    subscribeActivity(fn) { activity = fn; return () => cleanups++; },
    subscribeVisibility(fn) { visibility = fn; return () => cleanups++; },
    hintBrowser(origin) { hints.push(origin); return () => cleanups++; }
  });
  activity({ type: 'activity' }); await tick();
  assert.deepEqual(warmed, ['https://custom.example']); assert.deepEqual(hints, []);
  activity({ type: 'activity' }); time = 19999; activity({ type: 'activity' }); await tick();
  assert.equal(warmed.length, 1);
  time = 20000; activity({ type: 'activity' }); await tick(); assert.equal(warmed.length, 2);
  status({ mode: 'tor', torState: 'initializing' }); await tick();
  status({ mode: 'tor', torState: 'ready' }); await tick();
  assert.equal(warmed.length, 4);
  visibility(false); await tick(); assert.equal(warmed.length, 4);
  visibility(true); await tick(); assert.equal(warmed.length, 5);
  provider = { id: 'direct', preconnectOrigins: ['https://direct.example'] };
  activity({ type: 'provider' }); await tick();
  assert.deepEqual(hints, ['https://direct.example']);
  activity({ type: 'provider' }); await tick(); assert.equal(hints.length, 1);
  stop(); activity({ type: 'provider' }); visibility(true); await tick();
  assert.equal(cleanups, 4);
  assert.equal(warmed.length, 7);
});

test('core-chat alone owns composer activity and supplies dynamic metadata without reading message content', () => {
  const { doc } = dom();
  const mode = { value: 'custom' };
  doc.getElementById = id => id === 'mode' ? mode : undefined;
  const activity = createBrowserActivity({ document: doc, getMetadata: () => ({ preconnectOrigins: ['https://one.example'] }) });
  const events = []; activity.subscribe(event => events.push(event.type));
  for (const fn of doc.listeners.input) fn({ target: { id: 'other' } });
  for (const fn of doc.listeners.input) fn({ target: { id: 'prompt', get value() { throw new Error('Do not read prompt'); } } });
  for (const fn of doc.listeners.change) fn({ target: { id: 'mode' } });
  assert.deepEqual(events, ['activity', 'provider']);
  assert.equal(activity.getProvider().id, 'custom');
  activity.setMetadata(() => ({ preconnectOrigins: ['https://two.example'] }));
  assert.deepEqual(activity.getProvider().preconnectOrigins, ['https://two.example']);
  activity.dispose(); assert.equal(doc.listeners.input.length, 0);
});

test('real declared git@1 execution consumer selects alternative implementation and same-VFS recovery, no stopped fallback', async t => {
  const priorWorker = globalThis.Worker; globalThis.Worker = BrowserWorker;
  t.after(() => { globalThis.Worker = priorWorker; });
  let output = "";
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  let controller;
  const backend = createBrowserExecution({ vfs, git: () => controller.resolve(), shells: { javascript: createJavaScriptShell() }, emit(event) { if(event.event === 'env.output') output += Buffer.from(event.data, 'base64').toString(); } });
  controller = createController({ fs: backend.filesystem, fetch: offline });
  t.after(() => backend.dispose());
  const data = new Map();
  const runtime = createPluginRuntime({ storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } });
  const assembly = await assembleApp({ withLibrary: false }); t.after(() => assembly.remove());
  const executionEntry = await assembly.load('builtin/core-execution/web/index.js');
  const manifest = id => JSON.parse(readFileSync(new URL(`../plugins/${id}/plugin.json`, import.meta.url), 'utf8'));
  // E1: in the browser core-execution provides workspace@1 only (execution@1: exec-js/exec-linux).
  runtime.register({ ...manifest('core-execution'), provides: [{ id: 'workspace', version: 1 }], ...executionEntry.create({ browserBackend: backend, browserGit: controller }) });
  runtime.register({ ...manifest('core-git'), provides: [{ id: 'git', version: 1, default: true }], ...create({ service: controller.service, hostInfo: { platform: 'browser' } }) });
  runtime.register({ id: 'alternate-git', version: '1', provides: [{ id: 'git', version: 1 }], setup(ctx) { ctx.provide('git', 1, { call: async () => 'alternative-git' }); } });
  controller.bind(runtime); await runtime.start();
  assert.equal(runtime.list().find(row => row.id === 'core-execution').state, 'active');
  assert.notEqual(controller.resolve(), controller.service);
  runtime.selection.choose('git', 1, 'alternate-git');
  assert.equal(await controller.resolve().call({ operation: 'version' }), 'alternative-git');
  const result = await backend.methods['env.exec']({ shell: 'javascript', id: 'selected', owner: 'test', timeout: 10, command: 'console.log(await git.version())' });
  assert.equal(result.exitCode, 0, output); assert.match(output, /alternative-git/);
  await runtime.stop('alternate-git');
  assert.notEqual(controller.resolve(), controller.service); // ordinary default, not bundled escape
  runtime.selection.choose('git', 1, 'core-git');
  await runtime.stop('core-git');
  assert.equal(controller.resolve(), null);
  controller.bind(null);
  await controller.resolve().call({ operation: 'init', cwd: '/workspace/recovery' });
  assert.equal(vfs.exists('/workspace/recovery/.git'), true);
  await runtime.close();
  const failed = createPluginRuntime({ storage: null });
  failed.register({ ...manifest('core-git'), setup() { throw new Error('synthetic Git setup failure'); } });
  controller.bind(failed); await failed.start();
  assert.equal(failed.list()[0].state, 'failed');
  assert.equal(controller.resolve(), controller.service);
  assert.equal(await controller.resolve().call({ operation: 'currentBranch', cwd: '/workspace/recovery' }), 'master');
  await failed.close();
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('nonlive browser assembly consumes real Git definitions and fixed vendor assets; deleted hosts stay gone', { timeout: 90000, skip: heavy }, async t => {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const out = await mkdtemp(resolve(root, '../plugin-b5-build-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  execFileSync('sh', ['scripts/build-browser.sh', out], { cwd: root, stdio: 'pipe' });
  await writeFile(`${out}/package.json`, '{"type":"module"}');
  const load = name => import(pathToFileURL(`${out}/${name}`).href);
  const { createBrowserHost } = await load('browser-host.js');
  const { Vfs, MemoryBackend } = await load('builtin/core-execution/web/browser/browser-vfs.js');
  const { createBuiltinPlugins } = await load('plugin-builtins.js');
  const { createPluginRuntime } = await load('plugin-runtime.js');
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const savedStorage = globalThis.localStorage;
  const records = new Map();
  globalThis.localStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
  t.after(() => { if (savedStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedStorage; });
  const host = await createBrowserHost({ vfs, network: { fetch: offline } });
  t.after(() => host.dispose());
  const runtime = createPluginRuntime({ storage: null });
  const info = { platform: 'browser', capabilities: { executionEnv: true } };
  for (const definition of createBuiltinPlugins({ sessions: null, chat: null,
    execution: { hostInfo: info, browserBackend: host.execution, browserGit: host.git },
    git: { service: host.git.service, hostInfo: info }, net: { browser: true } })) runtime.register(definition);
  host.git.bind(runtime); await runtime.start(); t.after(() => runtime.close());
  assert.equal(runtime.list().find(row => row.id === 'core-git').state, 'active');
  assert.notEqual(host.git.resolve(), host.git.service);
  const git = runtime.service('git', 1);
  assert.equal(await git.call({ operation: 'version' }), '1.44.2');
  await git.call({ operation: 'init', cwd: '/workspace/composed' });
  host.execution.methods['workspace.write']({ path: 'composed/shared', text: 'same binary VFS' });
  await git.call({ operation: 'add', cwd: '/workspace/composed', options: { filepath: 'shared' } });
  await git.call({ operation: 'commit', cwd: '/workspace/composed', options: { message: 'composed', author: identity } });
  assert.equal((await git.call({ operation: 'log', cwd: '/workspace/composed' }))[0].commit.author.email, identity.email);
  host.git.bind(null);
  assert.equal((await host.git.resolve().call({ operation: 'log', cwd: '/workspace/composed' })).length, 1);
  const manifest = JSON.parse(await readFile(`${out}/app-manifest.json`, 'utf8'));
  const { FIXED } = await import('../apps/browser/browser-revisions.js');
  for (const file of ['index.js', 'browser-git.js', 'browser-buffer-global.js']) {
    const name = `builtin/core-git/web/${file}`;
    assert.ok(manifest.editableFiles.includes(name)); assert.ok(!FIXED.test(name));
  }
  assert.ok(!manifest.editableFiles.some(name => name.startsWith('vendor/')));
  for (const name of ['git', 'buffer-global', 'network-ui', 'snowflake', 'preconnect'])
    assert.equal(existsSync(`${out}/browser-${name}.js`), false);
  const main = await readFile(`${out}/browser-main.js`, 'utf8');
  assert.match(main, /builtin\/net-tor\/web\/browser-progress.js/);
  assert.match(main, /builtin\/core-agent\/web\/browser-preconnect.js/);
  assert.doesNotMatch(main, /core-providers.js|builtin-plugins.js/);
});

test('composed Git HTTP follows declared dynamic net.fetch and never falls through an unavailable external route', async t => {
  const { service } = await fixture(t);
  const records = new Map(), requests = [];
  const runtime = createPluginRuntime({ storage: { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) } });
  const oid = '1'.repeat(40);
  const pkt = text => (new TextEncoder().encode(text).length + 4).toString(16).padStart(4, '0') + text;
  const advertisement = pkt('# service=git-upload-pack\n') + '0000' + pkt(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`) + pkt(`${oid} refs/heads/main\n`) + '0000';
  let available = true;
  for (const id of ['net-default', 'net-alternate']) runtime.register({ id, version: '1', provides: [{ id: 'net.fetch', version: 1, ...(id === 'net-default' ? { default: true } : {}) }], setup(ctx) {
    ctx.provide('net.fetch', 1, Object.assign(async (url, init) => {
      requests.push(id); assert.match(url, /info\/refs/); assert.equal(init.credentials, 'omit');
      return new Response(advertisement, { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' } });
    }, { available: () => available }));
  } });
  runtime.register({ id: 'core-git', version: '1', provides: [{ id: 'git', version: 1 }], uses: [{ id: 'net.fetch', version: 1 }], ...create({ service, hostInfo: { platform: 'browser' } }) });
  await runtime.start(); t.after(() => runtime.close());
  const remote = () => runtime.service('git', 1).call({ operation: 'getRemoteInfo', options: { url: 'https://example.invalid/repo.git' } });
  assert.equal((await remote()).refs.heads.main, oid);
  runtime.selection.choose('net.fetch', 1, 'net-alternate');
  assert.equal((await remote()).refs.heads.main, oid);
  assert.deepEqual(requests, ['net-default', 'net-alternate']);
  available = false;
  await assert.rejects(remote(), /Selected network is unavailable/);
  assert.equal(requests.length, 2);
});

test('preconnect teardown does not hint or warm subsequent origins after an in-flight result', async () => {
  let event, complete, hints = 0, unsubscribed = 0;
  const requests = [];
  const stop = mountPreconnect({
    network: { preconnect(origin) { requests.push(origin); return new Promise(resolve => { complete = resolve; }); } },
    getProvider: () => ({ id: 'multiple', preconnectOrigins: ['https://one.example', 'https://two.example'] }),
    subscribeActivity(fn) { event = fn; return Promise.resolve(() => unsubscribed++); },
    hintBrowser() { hints++; }
  });
  event({ type: 'provider' }); stop(); complete({ route: 'direct' }); await tick();
  assert.equal(requests.length, 1); assert.equal(hints, 0); assert.equal(unsubscribed, 1);
});
