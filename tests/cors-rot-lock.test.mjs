// libs/cors-rot must match libs/cors-rot/UPSTREAM.lock exactly: no extra, missing or edited files.
// Never edit libs/cors-rot by hand; run scripts/update-cors-rot.sh <commit>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('../libs/cors-rot/', import.meta.url).pathname;
const lock = JSON.parse(readFileSync(join(root, 'UPSTREAM.lock'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p).split(sep).join('/')];
  });
}

test('lock names repo and a full commit', () => {
  assert.match(lock.repo, /^https:\/\/github\.com\//);
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.match(lock.artifacts.tarballSha256, /^[0-9a-f]{64}$/);
});

test('libs/cors-rot has exactly the locked files', () => {
  const actual = walk(root).filter((f) => f !== 'UPSTREAM.lock').sort();
  const locked = lock.files.map((f) => f.path).sort();
  assert.deepEqual(actual, locked);
  assert.equal(new Set(locked).size, locked.length, 'duplicate lock entries');
});

test('every locked file has its locked sha256', () => {
  for (const { path, sha256 } of lock.files) {
    const got = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    assert.equal(got, sha256, `${path} was edited (run scripts/update-cors-rot.sh)`);
  }
});
