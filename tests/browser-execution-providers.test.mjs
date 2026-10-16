// E1: the browser edition's two execution@1 providers (exec-linux, exec-js) through the REAL
// plugin runtime and its provider selection, over the real browser host (one page VFS backend,
// one VM), plus ONE conformance table run against both environments (every ExecutionEnv
// method), Android unchanged, and the bundled recovery opener. ONE VM per process (the Linux
// rows come last); slow (emulation). Run alone:
//   timeout 280 node --test tests/browser-execution-providers.test.mjs > log 2>&1
// The Linux rows need the repository image (apps/browser/vendor/v86, PI_V86_VENDOR overrides);
// PI_V86_SKIP=1 skips them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';
import { createBrowserHost } from '../apps/browser/browser-host.js';

class WebWorker {
  constructor(url) {
    this.worker = new NodeWorker(`
      const {parentPort, workerData} = require('node:worker_threads');
      globalThis.self = globalThis;
      globalThis.addEventListener = () => {};
      globalThis.postMessage = m => parentPort.postMessage(m);
      const queue = [];
      parentPort.on('message', data => globalThis.onmessage ? globalThis.onmessage({data}) : queue.push(data));
      import(workerData.url).then(() => { for (const data of queue) globalThis.onmessage({data}); });
    `, { eval: true, workerData: { url: String(url) } });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { void this.worker.terminate(); }
}
globalThis.Worker = WebWorker;
globalThis.crypto ??= webcrypto;
const records = new Map();
globalThis.localStorage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, String(v)), removeItem: k => records.delete(k) };

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(here, '../apps/browser/vendor/v86');
const IMAGE = path.join(VENDOR, 'image');
const linuxAssets = existsSync(path.join(IMAGE, 'alpine-state.bin.gz')) ? {
  libv86Url: pathToFileURL(path.join(VENDOR, 'libv86.mjs')).href, wasmPath: path.join(VENDOR, 'v86.wasm'),
  biosUrl: path.join(VENDOR, 'seabios.bin'), vgaBiosUrl: path.join(VENDOR, 'vgabios.bin'),
  basefsUrl: path.join(IMAGE, 'alpine-fs.json'), baseUrl: path.join(IMAGE, 'flat') + '/', stateGzPath: path.join(IMAGE, 'alpine-state.bin.gz'),
} : null;
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const vmSkip = skip || (process.env.PI_V86_SKIP === '1' ? 'PI_V86_SKIP=1' : linuxAssets ? false : `no v86 image in ${VENDOR}`);

let app, page;
test.before(async () => {
  if (!available) return;
  app = await assembleApp();
  const { createNativeBridge } = await app.load('native-host.js');
  const { createPluginRuntime } = await app.load('plugin-runtime.js');
  const { createBuiltinPlugins } = await app.load('plugin-builtins.js');
  const chord = await app.load('library/chord/context.js');
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const network = { fetch: () => Promise.reject(new Error('offline test')), fetchTor: () => Promise.reject(new Error('offline test')), connect: () => Promise.reject(new Error('offline test')) };
  const host = await createBrowserHost({ vfs, network, linuxAssets });
  const bridge = createNativeBridge(host.transport);
  const hostInfo = await bridge.call('host.info');
  const runtime = createPluginRuntime({ storage: globalThis.localStorage });
  for (const definition of createBuiltinPlugins({ execution: { bridge, hostInfo, owner: 'providers-test', browserBackend: host.execution }, sessions: null })) runtime.register(definition);
  await runtime.start();
  page = { vfs, host, bridge, hostInfo, runtime, context: chord.BACKGROUND_CONTEXT, createBuiltinPlugins, createPluginRuntime };
});
test.after(async () => { await page?.runtime.close(); page?.host.dispose(); await app?.remove(); });

const LINUX = { id: 'bash', language: 'bash', name: 'Linux (Bash)' };
const JS = { id: 'javascript', language: 'javascript', name: 'JavaScript' };

test('runtime selection: two execution@1 providers, Linux default, JS selectable; core-execution keeps workspace@1', { skip }, async () => {
  const { runtime, host } = page;
  const providers = runtime.selection.providers('execution', 1);
  assert.deepEqual(providers.map((p) => [p.id, p.default, p.available]), [['exec-linux', true, true], ['exec-js', false, true]]);
  assert.ok(runtime.selection.services().some((s) => s.id === 'execution' && s.version === 1), 'Settings → Providers shows an execution row');
  assert.equal(runtime.list().find((r) => r.id === 'core-execution').state, 'active');
  assert.ok(runtime.service('workspace', 1), 'core-execution still provides workspace@1');
  assert.equal(runtime.service('execution', 1).shell, 'bash');
  const linuxEnv = await runtime.service('execution', 1).open(void 0, { owner: 'providers-test' });
  assert.deepEqual({ ...linuxEnv.shell }, LINUX);
  assert.equal(runtime.selection.choose('execution', 1, 'exec-js'), true);
  assert.equal(localStorage.getItem('self-forming.provider.execution@1'), 'exec-js');
  assert.equal(runtime.service('execution', 1).shell, 'javascript');
  const jsEnv = await runtime.service('execution', 1).open(void 0, { owner: 'providers-test' });
  assert.deepEqual({ ...jsEnv.shell }, JS);
  runtime.selection.choose('execution', 1, null);
  assert.equal(runtime.service('execution', 1).shell, 'bash');
  // One backend, one shell of each kind (the Linux one owns the page's single VM).
  assert.deepEqual(host.execution.shells().map((s) => s.id), ['javascript', 'bash']);
  // A page without Linux: JS is the default, the Linux provider is not available.
  const noLinuxInfo = { ...page.hostInfo, capabilities: { ...page.hostInfo.capabilities, linuxShell: false } };
  const other = page.createPluginRuntime({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  for (const definition of page.createBuiltinPlugins({ execution: { bridge: page.bridge, hostInfo: noLinuxInfo, browserBackend: host.execution }, sessions: null })) other.register(definition);
  await other.start();
  assert.deepEqual(other.selection.providers('execution', 1).map((p) => [p.id, p.default, p.available]), [['exec-js', true, true], ['exec-linux', false, false]]);
  assert.equal(other.service('execution', 1).shell, 'javascript');
  await other.close();
});

test('Android unchanged: core-execution provides execution@1, no exec-* providers, no shell in bridge calls', { skip }, async () => {
  const calls = [];
  const bridge = {
    call: async (method, params) => { calls.push([method, params]); if (method === 'env.info') return { id: 'android', cwd: '/w', home: '/w', backgroundExecution: true }; if (method === 'env.exec') return { exitCode: 0 }; return null; },
    subscribe: () => () => {}, onClose: () => () => {}
  };
  const hostInfo = { platform: 'android', capabilities: { executionEnv: true, backgroundExecution: true } };
  const runtime = page.createPluginRuntime({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  for (const definition of page.createBuiltinPlugins({ execution: { bridge, hostInfo, owner: 'o' }, sessions: null })) runtime.register(definition);
  await runtime.start();
  assert.deepEqual(runtime.selection.providers('execution', 1).map((p) => p.id), ['core-execution']);
  assert.ok(!runtime.list().some((r) => r.id.startsWith('exec-')));
  const env = await runtime.service('execution', 1).open();
  assert.equal('shell' in env, false);
  assert.ok((await env.exec('true', undefined, page.context)).ok);
  assert.deepEqual(calls.find(([m]) => m === 'env.info'), ['env.info', undefined]);
  assert.equal('shell' in calls.find(([m]) => m === 'env.exec')[1], false);
  await runtime.close();
});

test('bundled recovery opener: same page backend and VFS, shell from the saved choice', { skip }, async () => {
  const coreExecution = await app.load('builtin/core-execution/web/index.js');
  const env = await coreExecution.createExecution({ bridge: page.bridge, hostInfo: page.hostInfo, owner: 'recovery', shell: 'javascript' }).open();
  assert.equal(env.shell.id, 'javascript');
  assert.ok((await env.writeFile('recovery.txt', 'same vfs', page.context)).ok);
  assert.equal(new TextDecoder().decode(await page.vfs.read('/workspace/recovery.txt')), 'same vfs');
  const appSource = readFileSync(new URL('../apps/common/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /self-forming\.provider\.execution@1/);
  assert.match(appSource, /shell: bundledBrowserShell\(hostInfo\)/);
});

// ---------------------------------------------------------------- one conformance table, both envs
const shellKits = {
  javascript: {
    out: (text) => `void process.stdout.write(${JSON.stringify(text)})`,
    both: (o, e) => `process.stdout.write(${JSON.stringify(o)}); void process.stderr.write(${JSON.stringify(e)})`,
    exit: (n) => `process.exit(${n})`,
    pwd: 'void process.stdout.write(process.cwd())',
    env: (name) => `void process.stdout.write(process.env[${JSON.stringify(name)}])`,
    write: (file, text) => `await fs.writeFile(${JSON.stringify(file)}, ${JSON.stringify(text)})`,
    sleep: 'await sleep(600000)',
    argv: async (env, ctx, args) => {
      assert.ok((await env.writeFile('argv.js', 'void process.stdout.write(JSON.stringify(process.argv.slice(2)))', ctx)).ok);
      return { command: ['node', 'argv.js', ...args], expected: JSON.stringify(args) };
    },
    noProgram: ['ls', '-l'],
  },
  bash: {
    out: (text) => `printf %s '${text.replace(/'/g, `'\\''`)}'`,
    both: (o, e) => `printf %s '${o}'; printf %s '${e}' >&2`,
    exit: (n) => `exit ${n}`,
    pwd: 'printf %s "$PWD"',
    env: (name) => `printf %s "$${name}"`,
    write: (file, text) => `printf %s '${text}' > '${file}'`,
    sleep: 'sleep 600',
    argv: async (_env, _ctx, args) => ({ command: ['printf', '[%s]', ...args], expected: args.map((a) => `[${a}]`).join('') }),
    noProgram: ['definitely-not-a-program'],
  },
};
async function exec(env, ctx, command, options = {}) {
  let stdout = '', stderr = '';
  const result = await env.exec(command, { ...options, onOutput: (text, _c, info) => { if (info.stream === 'stderr') stderr += text; else stdout += text; } }, ctx);
  return { result, stdout, stderr };
}
const code = (result) => result.ok ? 'ok' : result.error.code;
const value = (result) => { assert.ok(result.ok, result.ok ? '' : `${result.error.code}: ${result.error.message}`); return result.value; };

/** Every ExecutionEnv method; rows get (env, ctx, kit, dir) where dir is a fresh directory name. */
const TABLE = [
  ['id/cwd and absolutePath/joinPath/canonicalPath', async (env, ctx, _k, dir) => {
    assert.equal(typeof env.id, 'string'); assert.equal(env.cwd, '/workspace');
    assert.equal(value(await env.absolutePath(`${dir}/a`, ctx)), `/workspace/${dir}/a`);
    assert.equal(value(await env.joinPath(['/workspace', dir, 'b'], ctx)), `/workspace/${dir}/b`);
    assert.equal(code(await env.canonicalPath(`${dir}/missing`, ctx)), 'not_found');
  }],
  ['createDir/exists/fileInfo/listDir/openDirReader', async (env, ctx, _k, dir) => {
    value(await env.createDir(`${dir}/sub/deep`, { recursive: true }, ctx));
    assert.equal(value(await env.exists(`${dir}/sub/deep`, ctx)), true);
    value(await env.writeFile(`${dir}/sub/f.txt`, 'abc', ctx));
    const info = value(await env.fileInfo(`${dir}/sub/f.txt`, ctx));
    assert.deepEqual([info.name, info.kind, info.size], ['f.txt', 'file', 3]);
    assert.deepEqual(value(await env.listDir(`${dir}/sub`, ctx)).map((e) => [e.name, e.kind]), [['deep', 'directory'], ['f.txt', 'file']]);
    const reader = value(await env.openDirReader(`${dir}/sub`, ctx));
    const page1 = value(await reader.next(1, ctx));
    assert.equal(page1.entries.length, 1);
    await reader.close(ctx);
    assert.equal(value(await env.canonicalPath(`${dir}/sub/f.txt`, ctx)), `/workspace/${dir}/sub/f.txt`);
  }],
  ['writeFile/appendFile/readTextFile/readBinaryFile/readTextLines/openTextLineReader', async (env, ctx, _k, dir) => {
    value(await env.writeFile(`${dir}/t.txt`, 'one\ntwo\n', ctx));
    value(await env.appendFile(`${dir}/t.txt`, new TextEncoder().encode('three 雪'), ctx));
    assert.equal(value(await env.readTextFile(`${dir}/t.txt`, ctx)), 'one\ntwo\nthree 雪');
    assert.equal(value(await env.readBinaryFile(`${dir}/t.txt`, ctx)).length, 'one\ntwo\nthree '.length + 3);
    assert.deepEqual(value(await env.readTextLines(`${dir}/t.txt`, { maxLines: 2 }, ctx)), ['one', 'two']);
    const lines = value(await env.openTextLineReader(`${dir}/t.txt`, ctx));
    assert.deepEqual(value(await lines.readLine(ctx)), { text: 'one', terminated: true });
    await lines.close(ctx);
    assert.equal(code(await env.readTextFile(`${dir}/missing.txt`, ctx)), 'not_found');
  }],
  ['openBinaryReader info/read/scanLines, truncateFile, flushFile', async (env, ctx, _k, dir) => {
    value(await env.writeFile(`${dir}/b.bin`, 'hello world\nline2\n', ctx));
    const reader = value(await env.openBinaryReader(`${dir}/b.bin`, undefined, ctx));
    assert.equal(value(await reader.info(ctx)).size, 18);
    assert.equal(new TextDecoder().decode(value(await reader.read(6, 5, ctx))), 'world');
    assert.equal(value(await reader.scanLines({ startLine: 2 }, ctx)).newlines, 2);
    await reader.close(ctx);
    value(await env.truncateFile(`${dir}/b.bin`, 5, ctx));
    value(await env.flushFile(`${dir}/b.bin`, ctx));
    assert.equal(value(await env.readTextFile(`${dir}/b.bin`, ctx)), 'hello');
    assert.equal(code(await env.truncateFile(`${dir}/b.bin`, -1, ctx)), 'invalid');
  }],
  ['renameFile/remove/createTempDir/createTempFile', async (env, ctx, _k, dir) => {
    value(await env.writeFile(`${dir}/r1.txt`, 'r', ctx));
    value(await env.renameFile(`${dir}/r1.txt`, `${dir}/r2.txt`, ctx));
    assert.equal(value(await env.exists(`${dir}/r1.txt`, ctx)), false);
    assert.equal(value(await env.readTextFile(`${dir}/r2.txt`, ctx)), 'r');
    value(await env.remove(`${dir}/r2.txt`, undefined, ctx));
    assert.equal(value(await env.exists(`${dir}/r2.txt`, ctx)), false);
    assert.equal(code(await env.remove(`${dir}/r2.txt`, undefined, ctx)), 'not_found');
    value(await env.remove(`${dir}/r2.txt`, { force: true }, ctx));
    const temp = value(await env.createTempDir('pfx-', ctx));
    assert.match(temp, /^\/tmp\/pfx-/);
    const file = value(await env.createTempFile({ prefix: 'f-', suffix: '.txt' }, ctx));
    assert.match(file, /^\/tmp\/f-.*\.txt$/);
  }],
  ['watch reports a change and stops when closed', async (env, ctx, _k, dir) => {
    value(await env.createDir(dir, undefined, ctx));
    const changes = [];
    const watcher = value(await env.watch([{ path: dir, recursive: true }], (change) => changes.push(change), ctx));
    value(await env.writeFile(`${dir}/w.txt`, 'w', ctx));
    for (let i = 0; i < 100 && !changes.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(changes.some((c) => c.paths?.some((p) => p.endsWith('/w.txt'))), JSON.stringify(changes));
    await watcher.close(ctx);
  }],
  ['exec: a string runs through the shell; separate streams; exit code', async (env, ctx, kit) => {
    let r = await exec(env, ctx, kit.out('hi 雪'));
    assert.equal(value(r.result).exitCode, 0); assert.equal(r.stdout, 'hi 雪'); assert.equal(r.stderr.replace(/^Starting Linux.*\n/, ''), '');
    r = await exec(env, ctx, kit.both('to-out', 'to-err'));
    assert.equal(r.stdout, 'to-out'); assert.equal(r.stderr, 'to-err');
    assert.equal(value((await exec(env, ctx, kit.exit(3))).result).exitCode, 3);
  }],
  ['exec: argv reaches the program unparsed; missing programs and empty argv are spawn errors', async (env, ctx, kit) => {
    const { command, expected } = await kit.argv(env, ctx, ['', 'two words', "q'\"$(x) *", 'line\nbreak', '雪🙂']);
    const r = await exec(env, ctx, command);
    assert.equal(value(r.result).exitCode, 0); assert.equal(r.stdout, expected);
    assert.equal(code((await exec(env, ctx, kit.noProgram)).result), 'spawn_error');
    assert.equal(code((await exec(env, ctx, [])).result), 'spawn_error');
  }],
  ['exec: cwd and env options; the shell sees the FileSystem files', async (env, ctx, kit, dir) => {
    value(await env.createDir(`${dir}/c`, undefined, ctx));
    assert.equal((await exec(env, ctx, kit.pwd, { cwd: `${dir}/c` })).stdout, `/workspace/${dir}/c`);
    assert.equal((await exec(env, ctx, kit.env('E1_VALUE'), { env: { E1_VALUE: 'x y 雪' } })).stdout, 'x y 雪');
    value((await exec(env, ctx, kit.write(`${dir}/from-shell.txt`, 'shell-made'))).result);
    assert.equal(value(await env.readTextFile(`${dir}/from-shell.txt`, ctx)), 'shell-made');
  }],
  ['exec: timeout and abort are distinct; Shell cleanup', async (env, ctx, kit) => {
    const timedOut = (await exec(env, ctx, kit.sleep, { timeout: 1 })).result;
    assert.equal(code(timedOut), 'timeout', timedOut.ok ? '' : timedOut.error.message);
    const controller = new AbortController();
    const pending = exec(env, { ...ctx, abortSignal: controller.signal }, kit.sleep);
    setTimeout(() => controller.abort(), 1500);
    const abortedRun = (await pending).result;
    assert.equal(code(abortedRun), 'aborted', abortedRun.ok ? '' : abortedRun.error.message);
    assert.equal(value((await exec(env, ctx, kit.out('after'))).result).exitCode, 0);
    await env.cleanup(ctx);
  }],
];

for (const [label, shell, rowSkip] of [['JavaScript (exec-js)', 'exec-js', () => skip], ['Linux (exec-linux)', 'exec-linux', () => vmSkip]]) {
  test(`conformance table: ${label}`, { skip: rowSkip(), timeout: 230000 }, async (t) => {
    page.runtime.selection.choose('execution', 1, shell);
    const env = await page.runtime.service('execution', 1).open(void 0, { owner: `conformance-${shell}` });
    const kit = shellKits[env.shell.id];
    assert.ok(kit, env.shell.id);
    let n = 0;
    for (const [name, run] of TABLE) {
      const started = Date.now();
      await t.test(name, () => run(env, page.context, kit, `${shell}-${++n}`));
      t.diagnostic(`${name}: ${Date.now() - started} ms`);
    }
    page.runtime.selection.choose('execution', 1, null);
  });
}
