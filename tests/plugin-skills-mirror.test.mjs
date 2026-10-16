import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSkillMirror, servedSkillSource, skillFrontmatter, skillFilePath, SKILLS_DIRECTORY } from '../apps/common/plugin-skills.js';

// A3b skill mirror (plugin-skills.js) against a REAL temporary directory: exec runs
// bash, writeFile/readTextFile use the file system, so mkdir/mv/chmod/rm really happen.
// The plugin snapshot is a mocked source (the Android host serves it at
// /assets/web/plugins/<id>/<hash>/web/skills/...). Not on-device verification; running
// as root would ignore the read-only bits, which this test only checks as mode bits.
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
const SKILL = (name, description = `Do ${name} things. Use when ${name} is asked for.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nRun scripts/run.sh.\n`;

function fsEnv(cwd) {
  const commands = [];
  return {
    cwd, commands,
    exec(command, { cwd: dir = cwd, onOutput } = {}) {
      commands.push(command);
      return new Promise((resolve) => {
        const child = spawn('bash', ['-c', command], { cwd: dir });
        child.stdout.on('data', (data) => onOutput?.(String(data)));
        child.stderr.on('data', (data) => onOutput?.(String(data)));
        child.on('close', (exitCode) => resolve({ ok: true, value: { exitCode } }));
      });
    },
    async writeFile(path, data) {
      try { await writeFile(path, data); return { ok: true, value: undefined }; }
      catch (error) { return { ok: false, error }; }
    },
    async readTextFile(path) {
      try { return { ok: true, value: await readFile(path, 'utf8') }; }
      catch (error) { return { ok: false, error }; }
    }
  };
}
function snapshotSource(files) {
  const reads = [];
  return { reads, async read(id, hash, path) {
    reads.push(`${id}@${hash.slice(0, 1)}:${path}`);
    const data = files[`${id}@${hash}/${path}`];
    if (data === undefined) throw new Error(`HTTP 404 for ${path}`);
    return new TextEncoder().encode(data);
  } };
}
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-skills-'));
  return { dir, remove: async () => { await new Promise((resolve) => spawn('chmod', ['-R', 'u+w', dir]).on('close', resolve)); await rm(dir, { recursive: true, force: true }); } };
}
const writable = async (path) => ((await stat(path)).mode & 0o222) !== 0;
async function chmodWorks(dir) {
  const probe = join(dir, '.probe');
  await writeFile(probe, 'x');
  await new Promise((resolve) => spawn('chmod', ['a-w', probe]).on('close', resolve));
  const works = !await writable(probe);
  await new Promise((resolve) => spawn('chmod', ['u+w', probe]).on('close', resolve));
  await rm(probe, { force: true });
  return works;
}

test('frontmatter and path helpers', () => {
  assert.deepEqual(skillFrontmatter(SKILL('notes')), { name: 'notes', description: 'Do notes things. Use when notes is asked for.' });
  assert.deepEqual(skillFrontmatter('---\r\nname: "quoted"\r\ndescription: \'x y\'\r\n---\r\nbody'), { name: 'quoted', description: 'x y' });
  assert.throws(() => skillFrontmatter('# no frontmatter'), /must start with YAML frontmatter/);
  assert.throws(() => skillFrontmatter('---\nname: x\n'), /not closed/);
  assert.throws(() => skillFrontmatter('---\nname: x\n---\n'), /no description/);
  for (const ok of ['SKILL.md', 'scripts/run.sh', 'assets/a b.json']) assert.equal(skillFilePath(ok), true, ok);
  for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', './x', 'x\n']) assert.equal(skillFilePath(bad), false, JSON.stringify(bad));
  assert.equal(SKILLS_DIRECTORY, '.skills');
});

test('copies the selected revision read-only, reuses it, refreshes on a new revision and removes stale copies', async () => {
  const space = await workspace();
  try {
    const env = fsEnv(space.dir);
    const source = snapshotSource({
      [`notes@${H1}/web/skills/notes/SKILL.md`]: SKILL('notes'),
      [`notes@${H1}/web/skills/notes/scripts/run.sh`]: 'echo v1\n',
      [`notes@${H2}/web/skills/notes/SKILL.md`]: SKILL('notes', 'Version two.'),
      [`notes@${H2}/web/skills/notes/scripts/run.sh`]: 'echo v2\n',
      [`todo@${H1}/web/skills/todo/SKILL.md`]: SKILL('todo')
    });
    const errors = [];
    const mirror = createSkillMirror({ env, source, onError: (error) => errors.push(error.message) });
    const notes = (hash) => ({ pluginId: 'notes', hash, name: 'notes', files: ['SKILL.md', 'scripts/run.sh'] });
    const todo = { pluginId: 'todo', hash: H1, name: 'todo', files: ['SKILL.md'] };
    assert.equal(mirror.location('notes', H1, 'notes'), undefined, 'nothing is listed before the copy');
    const first = await mirror.sync([notes(H1), todo]);
    assert.deepEqual(first.failed, []);
    const skillFile = join(space.dir, '.skills/notes/notes/SKILL.md');
    assert.equal(mirror.location('notes', H1, 'notes'), skillFile);
    assert.equal(await readFile(skillFile, 'utf8'), SKILL('notes'));
    assert.equal(await readFile(join(space.dir, '.skills/notes/notes/scripts/run.sh'), 'utf8'), 'echo v1\n');
    assert.equal(await readFile(join(space.dir, '.skills/todo/todo/SKILL.md'), 'utf8'), SKILL('todo'));
    assert.ok(env.commands.some((command) => command.includes(`chmod -R a-w '${join(space.dir, '.skills/notes')}'`)), 'the copy is marked read-only');
    // Some file systems ignore modes (e.g. this PRoot workspace on Android): check bits only where chmod works.
    if (await chmodWorks(space.dir)) {
      for (const path of ['.skills/notes', '.skills/notes/notes', '.skills/notes/notes/SKILL.md', '.skills/notes/notes/scripts/run.sh']) {
        assert.equal(await writable(join(space.dir, path)), false, `${path} is read-only (a-w)`);
      }
      assert.equal(await writable(join(space.dir, '.skills')), true, 'the .skills folder itself stays writable for the mirror');
    }
    // Same revision again (e.g. the next session): the stamp matches, nothing is fetched.
    const reads = source.reads.length;
    const again = createSkillMirror({ env, source });
    await again.sync([notes(H1), todo]);
    assert.equal(source.reads.length, reads, 'an unchanged revision is not copied again');
    assert.equal(again.location('notes', H1, 'notes'), skillFile);
    // New revision: replaced; the old revision is no longer listed. todo is gone: removed.
    await again.sync([notes(H2)]);
    assert.equal(await readFile(join(space.dir, '.skills/notes/notes/scripts/run.sh'), 'utf8'), 'echo v2\n');
    assert.match(await readFile(skillFile, 'utf8'), /Version two\./);
    assert.equal(again.location('notes', H1, 'notes'), undefined);
    assert.equal(again.location('notes', H2, 'notes'), skillFile);
    assert.deepEqual((await readdir(join(space.dir, '.skills'))).sort(), ['notes'], 'stale plugin folder and staging folders removed');
    assert.equal(again.location('todo', H1, 'todo'), undefined);
    // Nothing active any more: everything is removed, .skills/ included.
    await again.sync([]);
    assert.deepEqual(await readdir(space.dir), []);
    // A workspace that never had plugin skills gets no .skills/ folder.
    await again.sync([]);
    assert.deepEqual(env.commands.at(-1).startsWith(`[ -e '${join(space.dir, '.skills')}' ] || exit 0;`), true);
    assert.deepEqual(errors, []);
  } finally { await space.remove(); }
});

test('a skill whose files cannot be read or whose SKILL.md names another skill is not listed; others are', async () => {
  const space = await workspace();
  try {
    const env = fsEnv(space.dir);
    const source = snapshotSource({
      [`pack@${H1}/web/skills/good/SKILL.md`]: SKILL('good'),
      [`pack@${H1}/web/skills/wrong/SKILL.md`]: SKILL('other'),
      [`pack@${H1}/web/skills/partial/SKILL.md`]: SKILL('partial')
    });
    const errors = [];
    const mirror = createSkillMirror({ env, source, onError: (error, details) => errors.push([details.name, error.message]) });
    const result = await mirror.sync(['good', 'wrong', 'partial'].map((name) => ({ pluginId: 'pack', hash: H1, name, files: name === 'partial' ? ['SKILL.md', 'scripts/missing.sh'] : ['SKILL.md'] })));
    assert.deepEqual(result.failed.map((item) => [item.name, item.reason]), [['wrong', 'Skill wrong: SKILL.md names it other'], ['partial', 'HTTP 404 for web/skills/partial/scripts/missing.sh']]);
    assert.deepEqual(errors, [], 'per-skill problems are returned, not reported (the caller reports them once)');
    assert.ok(mirror.location('pack', H1, 'good'));
    assert.equal(mirror.location('pack', H1, 'wrong'), undefined);
    assert.equal(mirror.location('pack', H1, 'partial'), undefined);
    // An incomplete copy is not stamped: the next sync tries again (the file appeared).
    const reads = source.reads.length;
    await mirror.sync(['good'].map((name) => ({ pluginId: 'pack', hash: H1, name, files: ['SKILL.md'] })));
    assert.ok(source.reads.length > reads);
  } finally { await space.remove(); }
});

test('inline contents work without reading the snapshot; latest set wins; a failing shell lists nothing', async () => {
  const space = await workspace();
  try {
    const env = fsEnv(space.dir);
    const source = { async read() { throw new Error('must not read'); } };
    const mirror = createSkillMirror({ env, source });
    const inline = (text) => ({ pluginId: 'weather', hash: H1, name: 'forecast', contents: { 'SKILL.md': SKILL('forecast'), 'references/units.md': text } });
    // Two quick syncs: both resolve with the outcome of the latest set.
    const [a, b] = await Promise.all([mirror.sync([inline('old')]), mirror.sync([inline('metric')])]);
    assert.deepEqual(a, b);
    assert.equal(await readFile(join(space.dir, '.skills/weather/forecast/references/units.md'), 'utf8'), 'metric');
    await mirror.settled(1000);
    // The environment's shell fails (closed, no Linux): nothing is reported as copied.
    const broken = createSkillMirror({ env: { ...env, async exec() { return { ok: false, error: new Error('Execution environment closed') }; } }, source, onError() {} });
    const result = await broken.sync([inline('x')]);
    assert.deepEqual(result.ready, []);
    assert.match(result.failed[0].reason, /Execution environment closed/);
    assert.equal(broken.location('weather', H1, 'forecast'), undefined);
  } finally { await space.remove(); }
});

test('servedSkillSource reads the pinned snapshot URL and explains failures (CSP: Track B)', async () => {
  const urls = [];
  const source = servedSkillSource({ fetch: async (url) => { urls.push(url); return new Response('hi'); } });
  assert.equal(new TextDecoder().decode(await source.read('notes', H1, 'web/skills/notes/a b.md')), 'hi');
  assert.deepEqual(urls, [`/assets/web/plugins/notes/${H1}/web/skills/notes/a%20b.md`]);
  await assert.rejects(source.read('notes', H1, '../plugin.json'), /Invalid plugin file/);
  const refused = servedSkillSource({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(refused.read('notes', H1, 'web/skills/notes/SKILL.md'), /Failed to fetch \(the host must allow the page to read plugin files\)/);
  const missing = servedSkillSource({ fetch: async () => new Response('', { status: 403 }) });
  await assert.rejects(missing.read('notes', H1, 'web/skills/notes/SKILL.md'), /HTTP 403/);
  assert.throws(() => createSkillMirror({ env: { cwd: 'relative', exec() {}, writeFile() {} }, source }), /absolute workspace directory/);
});
