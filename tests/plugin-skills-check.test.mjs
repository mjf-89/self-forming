import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// A3b: scripts/plugin.sh check validates Agent Skills shipped at web/skills/<name>/ and
// hashes them as part of web/** (the shipped set the Android host hashes as well,
// PluginHost.kt PluginFiles: plugin.json, web/**, native/module.jar). Needs bash, jq,
// coreutils, find, flock, zip and unzip; skipped otherwise.
const SCRIPT = fileURLToPath(new URL('../scripts/plugin.sh', import.meta.url));
const tools = ['bash', 'jq', 'sha256sum', 'flock', 'zip', 'unzip', 'realpath'].every((tool) => spawnSync('bash', ['-c', `command -v ${tool}`]).status === 0);
const skip = tools ? false : 'bash/jq/coreutils/flock/zip are not installed';
const MANIFEST = { id: 'notes', name: 'Notes', version: '0.1.0', api: 1, web: { entry: 'web/index.js' }, reload: 'page', provides: [], requires: [], uses: [] };
const SKILL = (name, description = 'Keep notes. Use when asked to remember something.') => `---\nname: ${name}\n${description === null ? '' : `description: ${description}\n`}---\n\n# ${name}\n`;

async function packageWith(files) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-skills-check-'));
  const all = { 'plugin.json': JSON.stringify(MANIFEST), 'web/index.js': 'export function setup() {}\n', ...files };
  for (const [path, text] of Object.entries(all)) {
    if (text === undefined) continue;
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}
const check = (dir) => spawnSync('bash', [SCRIPT, 'check', dir], { encoding: 'utf8' });
// The canonical revision (docs/plugins.md §3), independently of the script.
async function revision(dir) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full); else files.push(relative(dir, full));
    }
  }
  await walk(join(dir, 'web'));
  files.push('plugin.json');
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let records = '';
  for (const path of files) records += `${path}\0${createHash('sha256').update(await readFile(join(dir, path))).digest('hex')}\n`;
  return createHash('sha256').update(records).digest('hex');
}

test('valid skills pass, and web/skills/** is part of the revision hash', { skip }, async () => {
  const dir = await packageWith({ 'web/skills/notes/SKILL.md': SKILL('notes'), 'web/skills/notes/scripts/add.sh': 'echo hi\n', 'web/skills/notes/references/format.md': '# Format\n', 'web/skills/to-do/SKILL.md': SKILL('to-do', '"Quoted: description."') });
  try {
    const result = check(dir);
    assert.equal(result.status, 0, result.stderr);
    const hash = result.stdout.match(/Valid M1 package: ([a-f0-9]{64})/)?.[1];
    assert.equal(hash, await revision(dir), 'same canonical records as the host: skills are hashed');
    await writeFile(join(dir, 'web/skills/notes/scripts/add.sh'), 'echo changed\n');
    assert.notEqual(check(dir).stdout.match(/([a-f0-9]{64})/)[1], hash, 'changing a skill file changes the revision');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid skills are refused with a reason; a top-level skills/ (not shipped) is refused', { skip }, async () => {
  const cases = [
    [{ 'web/skills/notes/SKILL.md': SKILL('other') }, /Skill notes: frontmatter name is 'other', expected 'notes'/],
    [{ 'web/skills/notes/SKILL.md': SKILL('notes', null) }, /Skill notes: frontmatter needs a description/],
    [{ 'web/skills/notes/README.md': 'x' }, /Skill notes has no SKILL\.md/],
    [{ 'web/skills/notes/SKILL.md': '# notes\n' }, /must start with YAML frontmatter/],
    [{ 'web/skills/notes/SKILL.md': '---\nname: notes\ndescription: x\n' }, /frontmatter is not closed/],
    [{ 'web/skills/Notes/SKILL.md': SKILL('Notes') }, /Invalid skill folder name: Notes/],
    [{ 'web/skills/loose.md': 'x' }, /web\/skills\/ may only contain skill folders/],
    [{ 'skills/notes/SKILL.md': SKILL('notes') }, /skills\/ is not shipped: put each skill in web\/skills\/<name>\/SKILL\.md/]
  ];
  for (const [files, pattern] of cases) {
    const dir = await packageWith(files);
    try {
      const result = check(dir);
      assert.notEqual(result.status, 0, JSON.stringify(files));
      assert.match(result.stderr, pattern);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // No skills at all: unchanged behaviour.
  const plain = await packageWith({});
  try { assert.equal(check(plain).status, 0); } finally { await rm(plain, { recursive: true, force: true }); }
});
