// B3 ownership boundary and real VM -> the same page filesystem as file tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';
import { createBrowserExecution } from '../plugins/core-execution/web/browser/browser-execution.js';
import { createLinuxShell } from '../plugins/exec-linux/web/browser/linux-shell.js';

// Linux commands need a bash-capable image (the dispatcher protocol); the repository vendor image
// ships bash since the toolset image; PI_V86_VENDOR overrides it.
const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = process.env.PI_V86_VENDOR || path.resolve(here, "../apps/browser/vendor/v86");
const IMAGE = path.join(VENDOR, 'image');
const linuxAssets = existsSync(path.join(IMAGE, 'alpine-state.bin.gz')) ? {
  libv86Url: pathToFileURL(path.join(VENDOR, 'libv86.mjs')).href, wasmPath: path.join(VENDOR, 'v86.wasm'),
  biosUrl: path.join(VENDOR, 'seabios.bin'), vgaBiosUrl: path.join(VENDOR, 'vgabios.bin'),
  basefsUrl: path.join(IMAGE, 'alpine-fs.json'), baseUrl: path.join(IMAGE, 'flat') + '/',
  stateGzPath: path.join(IMAGE, 'alpine-state.bin.gz'),
} : null;

const enc = text => new TextEncoder().encode(text);
const dec = bytes => new TextDecoder().decode(bytes);

test('execution owner contains implementations, host only dispatches; fixed recovery uses owner files', () => {
  const host = readFileSync(new URL('../apps/browser/browser-host.js', import.meta.url), 'utf8');
  assert.match(host, /createBrowserExecution/);
  assert.doesNotMatch(host, /new Worker|"env\.openWriter"|function execLinux|function consoleFs/);
  // E1: the shells' implementations belong to the two execution@1 providers.
  const owners = { vfs: 'core-execution', execution: 'core-execution', 'console-worker': 'exec-js', v86: 'exec-linux', 'v86-worker': 'exec-linux', assets: 'exec-linux' };
  for (const [name, owner] of Object.entries(owners)) {
    assert.equal(existsSync(new URL(`../apps/browser/browser-${name}.js`, import.meta.url)), false);
    assert.ok(existsSync(new URL(`../plugins/${owner}/web/browser/browser-${name}.js`, import.meta.url)), `${owner}: browser-${name}.js`);
    for (const other of new Set(Object.values(owners))) if (other !== owner) assert.equal(existsSync(new URL(`../plugins/${other}/web/browser/browser-${name}.js`, import.meta.url)), false, `twin of browser-${name}.js in ${other}`);
  }
});

test('owner file handles and watches operate on the injected page VFS and clean up', async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const events = [];
  const backend = createBrowserExecution({ vfs, emit: event => events.push(event) });
  const call = (name, params = {}) => backend.methods[name](params);
  try {
    call('workspace.write', { path: 'shared', text: 'from files' });
    const { id } = await call('env.openBinaryReader', { path: 'shared', owner: 'a' });
    assert.equal(Buffer.from(call('env.reader.read', { id, offset: 0, length: 99 }).data, 'base64').toString(), 'from files');
    call('env.cleanup', { owner: 'b' });
    assert.equal(call('env.reader.info', { id }).size, 10);
    call('env.cleanup', { owner: 'a' });
    assert.throws(() => call('env.reader.info', { id }), /Closed reader/);
    await call('env.watch', { id: 'watch', targets: [{ path: '/workspace', recursive: true }] });
    call('workspace.write', { path: 'next', text: 'next' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(events.some(e => e.event === 'env.watch'));
    backend.dispose(); events.length = 0;
    vfs.write('/workspace/after', enc('after'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(events.length, 0);
  } finally { backend.dispose(); }
});

test('real Alpine backend: direct argv, separate streams, timeout, file tools <-> VM workspace visibility', { skip: linuxAssets ? false : `bash-capable image not found at ${VENDOR}`, timeout: 240000 }, async () => {
  // No Worker shim: actual v86's in-process engine, same protocol/backend used by host.
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  let output = '', errors = '';
  const shells = { bash: createLinuxShell({ vfs, network: null, assets: linuxAssets }) };
  const backend = createBrowserExecution({ vfs, shells, emit: e => {
    if (e.event !== 'env.output') return;
    if (e.stream === 'stderr') errors += Buffer.from(e.data, 'base64').toString(); else output += Buffer.from(e.data, 'base64').toString();
  } });
  const call = (name, params = {}) => backend.methods[name](params);
  let id = 0;
  const run = (command, timeout = 60) => call('env.exec', { command, id: `linux-${++id}`, owner: 'vm-test', shell: 'bash', timeout });
  try {
    call('workspace.write', { path: 'input', text: 'file-tool-input' });
    assert.equal((await run('cat input; printf vm-output > output; printf to-stderr >&2')).exitCode, 0);
    assert.equal(output, 'file-tool-input');
    assert.ok(errors.endsWith('to-stderr'), errors); // may be preceded by the first-use 'Starting Linux' note
    assert.equal((await call('workspace.read', { path: 'output' })).text, 'vm-output');
    output = '';
    const literals = ['', 'two words', "single'quote", '"double"', '$HOME', '$(touch injected)', '; touch injected', '*', '\\', '\nline'];
    assert.equal((await run(['/usr/bin/printf', '<%s>\\n', ...literals])).exitCode, 0);
    const expected = literals.map(arg => `<${arg}>\n`).join('');
    assert.equal(output, expected, 'argv executed directly; exact bytes, no framing');
    assert.equal(vfs.exists('/workspace/injected'), false);
    assert.equal(dec(await vfs.read('/workspace/input')), 'file-tool-input');
    await assert.rejects(run(['no-such-program']), e => e.code === 'spawn_error' && /command not found/.test(e.message));
    await assert.rejects(run('sleep 100', 2), e => e.code === 'timeout');
    output = '';
    assert.equal((await run(['printf', 'after-timeout'])).exitCode, 0);
    assert.equal(output, 'after-timeout');
    await assert.rejects(call('env.exec', { id: 'bad', shell: 'bash', command: 'true', cwd: '/workspace-other' }), /does not exist|inside \/workspace/);
    // Live /workspace (no copies): a file-tool edit and removal are seen by the next command; a guest
    // removal is gone from the files when the command returns; /scratch is a VM-local cwd.
    call('workspace.write', { path: 'input', text: 'edited-by-file-tool' });
    output = '';
    assert.equal((await run('cat input; rm output')).exitCode, 0);
    assert.equal(output, 'edited-by-file-tool');
    assert.equal(vfs.exists('/workspace/output'), false);
    vfs.remove('/workspace/input');
    output = '';
    assert.equal((await run('test -e input || printf gone')).exitCode, 0);
    assert.equal(output, 'gone');
    output = '';
    assert.equal((await call('env.exec', { id: 'scratch', owner: 'vm-test', shell: 'bash', command: 'pwd > p.txt && cat p.txt', cwd: '/scratch', timeout: 60 })).exitCode, 0);
    assert.equal(output, '/scratch\n');
    assert.equal(vfs.exists('/workspace/p.txt') || vfs.exists('/scratch/p.txt'), false);
  } finally { backend.dispose(); }
});
