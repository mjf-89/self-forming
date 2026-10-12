import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packer = fileURLToPath(new URL('../scripts/pack-source.sh', import.meta.url));
const archive = 'apps/android/app/build/generated/selfSource/self-source/source.zip';
const shellPath = path => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;

async function run(root, command, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: root, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, output }));
  });
}

async function fixture(t) {
  const temporary = resolve(tmpdir());
  const root = await mkdtemp(resolve(temporary, 'self-forming-pack-'));
  t.after(async () => {
    assert.ok(!relative(temporary, root).startsWith('..'));
    await rm(root, { recursive: true, force: true });
  });
  const write = async (name, contents = 'fixture\n') => {
    await mkdir(dirname(resolve(root, name)), { recursive: true });
    await writeFile(resolve(root, name), contents);
  };
  await write('scripts/pack-source.sh');
  await copyFile(packer, resolve(root, 'scripts/pack-source.sh'));
  // Capture the exact jar member argument list. No JDK, archive download, or signing keys are needed.
  await write('test-bin/jar', `#!/bin/sh
set -eu
out= list=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) shift; out=$1 ;;
    @*) list=\${1#@} ;;
  esac
  shift
done
[ -n "$out" ] && [ -n "$list" ]
cp "$list" "$out"
`);
  await chmod(resolve(root, 'test-bin/jar'), 0o755);
  const pack = async () => run(root, 'export PATH="$PACK_TEST_BIN:$PATH"; bash scripts/pack-source.sh',
    { PACK_TEST_BIN: shellPath(resolve(root, 'test-bin')) });
  const members = async () => (await readFile(resolve(root, archive), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, write, pack, members };
}

test('source packer selects tracked and new source without Git metadata, ignored data or private build state', async t => {
  const saved = await fixture(t);
  assert.equal((await run(saved.root, 'git -c init.templateDir= init -q')).code, 0);
  await saved.write('.gitignore', 'apps/on-device/ignored.js\n.signing/\n');
  await saved.write('package.json', '{}');
  await saved.write('apps/on-device/tracked.js');
  await saved.write('apps/on-device/.env', 'NOT_A_REAL_SECRET');
  await saved.write('apps/on-device/credentials.json', 'NOT_A_REAL_SECRET');
  await saved.write('apps/android/local.properties', 'NOT_A_REAL_SECRET');
  await saved.write('apps/android/app/build/generated/previous-source.zip');
  await saved.write('apps/on-device/backups/session.json');
  // Even force-tracked credentials and generated archives must be excluded.
  assert.equal((await run(saved.root, 'git add -f .')).code, 0);
  await saved.write('apps/on-device/new module.js');
  await saved.write('apps/on-device/ignored.js');
  await saved.write('.git/old-history.bundle', 'FORBIDDEN_OLD_HISTORY');
  await saved.write('.signing/self-forming.p12', 'FAKE_TEST_KEY');
  await saved.write('.signing/password', 'FAKE_TEST_PASSWORD');
  await saved.write('.signing/lineage.bin', 'FAKE_TEST_LINEAGE');
  await saved.write('.signing/other-private-key.p12', 'DO_NOT_SHIP');
  await saved.write('.signing/github-token.json', 'DO_NOT_SHIP');
  const result = await saved.pack();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await saved.members()).sort(), [
    '.gitignore', '.signing/lineage.bin', '.signing/password', '.signing/self-forming.p12',
    'apps/on-device/new module.js', 'apps/on-device/tracked.js', 'package.json', 'scripts/pack-source.sh'
  ].sort());
});

test('unpacked source builds without Git history and cannot absorb private files or its own generated archive', async t => {
  const saved = await fixture(t);
  await saved.write('README.md');
  await saved.write('runtime-source.env');
  await saved.write('.github/workflows/build.yml');
  await saved.write('apps/on-device/app.js');
  await saved.write('apps/on-device/fonts/face.ttf');
  await saved.write('apps/android/app/src/main/AndroidManifest.xml');
  await saved.write('apps/android/signing-certificate.pem', 'PUBLIC_CERTIFICATE_FIXTURE');
  await saved.write('apps/android/signing-certificate.sha256', 'PUBLIC_FINGERPRINT_FIXTURE');
  await saved.write('apps/android/unrelated-private.pem', 'DO_NOT_SHIP');
  await saved.write('scripts/verify-release.py', '# source fixture\n');
  await saved.write('third-party/upstream.LICENSE');
  await saved.write('apps/on-device/private/data.json');
  await saved.write('apps/on-device/.config/auth.json');
  await saved.write('apps/on-device/session.sqlite');
  await saved.write('apps/on-device/original-source.zip');
  await saved.write('apps/on-device/server.log');
  await saved.write('apps/on-device/cache/auth.json');
  await saved.write('apps/on-device/oauth-session.json', 'NOT_A_REAL_SECRET');
  await saved.write('apps/on-device/saved-token-state.json', 'NOT_A_REAL_SECRET');
  await saved.write('dist/source.zip');
  await saved.write('original-source.zip');
  await saved.write('credentials.json');
  await saved.write('github-token.env');
  await saved.write('other-repo/main.js');
  const first = await saved.pack();
  assert.equal(first.code, 0, first.output);
  const selected = (await saved.members()).sort();
  assert.deepEqual(selected, [
    '.github/workflows/build.yml', 'README.md', 'runtime-source.env', 'apps/on-device/app.js',
    'apps/on-device/fonts/face.ttf', 'apps/android/app/src/main/AndroidManifest.xml',
    'apps/android/signing-certificate.pem', 'apps/android/signing-certificate.sha256',
    'scripts/pack-source.sh', 'scripts/verify-release.py', 'third-party/upstream.LICENSE'
  ].sort());
  const second = await saved.pack();
  assert.equal(second.code, 0, second.output);
  assert.deepEqual((await saved.members()).sort(), selected);
});

test('partial self-update signing material fails closed without creating an archive', async t => {
  const saved = await fixture(t);
  await saved.write('.signing/password', 'FAKE_TEST_PASSWORD');
  const result = await saved.pack();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Incomplete or linked self-update signing identity/);
  await assert.rejects(readFile(resolve(saved.root, archive)), { code: 'ENOENT' });
});

test('source symlinks cannot smuggle a file outside the project into the APK', async t => {
  const saved = await fixture(t);
  await saved.write('README.md');
  await saved.write('outside-state/data.json', 'DO_NOT_SHIP');
  await mkdir(resolve(saved.root, 'apps'), { recursive: true });
  // Directory junctions exercise the same traversal boundary without Windows symlink privileges.
  await symlink(resolve(saved.root, 'outside-state'), resolve(saved.root, 'apps/linked'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const result = await saved.pack();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await saved.members()).sort(), ['README.md', 'scripts/pack-source.sh']);
});
