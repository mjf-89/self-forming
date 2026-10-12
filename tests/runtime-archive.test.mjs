import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const source = resolve('.');
const sha = data => createHash('sha256').update(data).digest('hex');
const prerequisites = spawnSync('bash', ['-c', 'for tool in jq unzip tar gzip sha256sum stat sort; do command -v "$tool" >/dev/null || exit 1; done; tar --version | head -n1 | grep -q "GNU tar"'], { encoding: 'utf8', windowsHide: true });
const skip = prerequisites.status === 0 ? false : 'Runtime archive fixtures need Bash, jq, unzip, GNU tar, gzip and coreutils';

// Tiny uncompressed ZIP writer avoids a zip CLI or another test dependency. Only synthetic bytes are archived.
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path), data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('runtime scripts have valid Bash syntax', { skip: spawnSync('bash', ['--version'], { windowsHide: true }).status !== 0 }, () => {
  for (const name of ['fetch-runtime.sh', 'package-runtime.sh']) {
    const checked = spawnSync('bash', ['-n', `scripts/${name}`], { cwd: source, encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test('APK and tar runtime imports verify checksums, copy only runtime files and keep prior output on failure', { skip }, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'self-forming-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'cache', 'blocked-network']) await mkdir(resolve(root, directory));
  for (const name of ['fetch-runtime.sh', 'package-runtime.sh']) await copyFile(resolve(source, 'scripts', name), resolve(root, 'scripts', name));
  await writeFile(resolve(root, 'blocked-network/curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > curl-arguments.txt\necho "Network forbidden in runtime fixture: $RUNTIME_DOWNLOAD_URL" >&2\nexit 97\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${resolve(root, 'blocked-network')}:${process.env.PATH}`, GH_TOKEN: '' };
  const run = (program, args) => spawnSync(program, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  const fetch = () => run('bash', ['scripts/fetch-runtime.sh', 'cache']);
  const pin = async (format, filename, bytes, hash = sha(bytes)) => {
    await writeFile(resolve(root, 'cache', filename), bytes);
    await writeFile(resolve(root, 'runtime-source.env'), `RUNTIME_FORMAT=${format}\nRUNTIME_REPO=fixture/runtime\nRUNTIME_TAG=fixture\nRUNTIME_ARCHIVE=${filename}\nRUNTIME_SHA256=${hash}\n`);
  };
  const rootfs = zip([['usr/bin/fixture', 'Synthetic filesystem fixture']]);
  const manifest = { schema: 1, distro: 'ubuntu', release: '24.04', abi: 'arm64-v8a', sha256: sha(rootfs), compressedBytes: rootfs.length };
  const entries = [
    ['lib/arm64-v8a/libproot.so', 'synthetic native library'],
    ['lib/arm64-v8a/libproot-loader.so', 'synthetic native loader'],
    ['assets/runtime/ubuntu-arm64-v8a.zip', rootfs],
    ['assets/runtime/ubuntu-arm64-v8a.json', JSON.stringify(manifest)],
    ['assets/licenses/proot.txt', 'synthetic license'],
    ['classes.dex', 'must never be copied'],
    ['assets/self-source/source.zip', 'must never be copied'],
    ['../../outside.txt', 'must never be copied'],
    ['lib/x86_64/libproot.so', 'wrong ABI must never be copied']
  ];
  await pin('apk', 'fixture.apk', zip(entries));
  const imported = fetch();
  assert.equal(imported.status, 0, imported.stderr);
  const expected = entries.slice(0, 5).map(([name]) => name.replace('lib/arm64-v8a/', 'jniLibs/arm64-v8a/')).sort();
  const files = async directory => {
    const out = [];
    for (const item of await readdir(resolve(root, directory), { withFileTypes: true, recursive: true })) {
      if (item.isFile()) out.push(resolve(item.parentPath, item.name).slice(resolve(root, directory).length + 1).replaceAll('\\', '/'));
    }
    return out.sort();
  };
  assert.deepEqual(await files('dist/runtime'), expected);
  for (const [name, value] of entries.slice(0, 5)) assert.deepEqual(await readFile(resolve(root, 'dist/runtime', name.replace('lib/arm64-v8a/', 'jniLibs/arm64-v8a/'))), Buffer.from(value));
  await copyFile(resolve(root, 'runtime-source.env'), resolve(root, 'import.env'));
  await writeFile(resolve(root, 'runtime-source.env'), 'RUNTIME_FORMAT=unsupported\n');
  env.RUNTIME_PIN_FILE = 'import.env';
  assert.equal(fetch().status, 0, 'A checked temporary pin can override the committed runtime source');
  delete env.RUNTIME_PIN_FILE;

  // The import asset was an APK, but packaging always emits a runtime tar.gz and does not copy unrelated files.
  await writeFile(resolve(root, 'dist/runtime/assets/runtime/unrelated-source.zip'), 'excluded');
  const packed = run('bash', ['scripts/package-runtime.sh', 'packed']);
  assert.equal(packed.status, 0, packed.stderr);
  const filename = 'self-forming-runtime-arm64-v8a.tar.gz';
  assert.deepEqual(await readdir(resolve(root, 'packed')), [filename]);
  const tar = await readFile(resolve(root, 'packed', filename));
  assert.equal(run('bash', ['scripts/package-runtime.sh', 'packed-again']).status, 0);
  assert.equal(sha(await readFile(resolve(root, 'packed-again', filename))), sha(tar), 'Packaging is reproducible');
  await pin('tar', filename, tar);
  assert.equal(fetch().status, 0);
  assert.deepEqual(await files('dist/runtime'), expected);

  await writeFile(resolve(root, 'dist/runtime/keep-on-failure'), 'existing runtime');
  const assertPreserved = async () => assert.equal(await readFile(resolve(root, 'dist/runtime/keep-on-failure'), 'utf8'), 'existing runtime');
  const mismatched = entries.map(([name, value]) => [name, name.endsWith('.json') ? JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }) : value]);
  await pin('apk', 'fixture.apk', zip(mismatched));
  assert.match(fetch().stderr, /manifest\/checksum mismatch/); await assertPreserved();
  await pin('apk', 'fixture.apk', zip([...entries, entries[0]]));
  assert.match(fetch().stderr, /Duplicate runtime member/); await assertPreserved();
  await pin('apk', 'fixture.apk', zip(entries.slice(1)));
  assert.match(fetch().stderr, /missing jniLibs/); await assertPreserved();
  await pin('apk', 'fixture.apk', zip(entries), '0'.repeat(64));
  assert.match(fetch().stderr, /Network forbidden/); await assertPreserved();
  env.RUNTIME_DOWNLOAD_URL = 'https://fixture.invalid/runtime?signature=dummy-private-signature';
  env.GH_TOKEN = 'dummy-repository-token';
  const signed = fetch();
  assert.match(signed.stderr, /Runtime download failed/);
  assert.doesNotMatch(signed.stdout + signed.stderr, /dummy-private-signature|dummy-repository-token|fixture\.invalid/);
  const curlArguments = await readFile(resolve(root, 'curl-arguments.txt'), 'utf8');
  assert.ok(curlArguments.includes(env.RUNTIME_DOWNLOAD_URL));
  assert.doesNotMatch(curlArguments, /Authorization|dummy-repository-token|api\.github\.com/);
  await assertPreserved();
  await rm(resolve(root, 'curl-arguments.txt'));
  env.RUNTIME_DOWNLOAD_URL = 'http://fixture.invalid/runtime';
  assert.match(fetch().stderr, /must use HTTPS/);
  await assert.rejects(readFile(resolve(root, 'curl-arguments.txt')), { code: 'ENOENT' });
  delete env.RUNTIME_DOWNLOAD_URL;
  env.GH_TOKEN = '';

  await mkdir(resolve(root, 'tar-extra'));
  await writeFile(resolve(root, 'tar-extra/unexpected.txt'), 'excluded');
  const extra = run('tar', ['-czf', 'unexpected.tar.gz', '-C', 'tar-extra', 'unexpected.txt']);
  assert.equal(extra.status, 0, extra.stderr);
  await pin('tar', 'unexpected.tar.gz', await readFile(resolve(root, 'unexpected.tar.gz')));
  assert.match(fetch().stderr, /Unexpected runtime archive member/); await assertPreserved();
});
