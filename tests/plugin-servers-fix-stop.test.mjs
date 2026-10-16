import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { tmuxFake } from './plugin-a4-support.mjs';
import { freePort, realEnv, run, sleep } from './plugin-servers-fix-support.mjs';

// Verified stop of a supervised server (servers.js killSessionIn and the manage_server
// stop/restart path). Part 1 runs REAL throwaway processes (busybox httpd, sleep) under a
// PRIVATE tmux socket (never "sf-servers") in a temporary workspace and removes them all.
// Part 2 uses the JavaScript tmux fake of plugin-a4-support.mjs with a real pi-durable
// harness. Real servers on the device are never touched.
const available = await libraryAvailable();
const tools = await run('command -v tmux && command -v busybox && command -v curl', {}).then((result) => result.code === 0, () => false);
const skip = !available ? 'dist/app/library (bundled pi-durable) is not present' : false;
const skipReal = skip || (tools ? false : 'tmux, busybox or curl is missing');
const SOCKET = `sf-test-${process.pid}-${randomBytes(3).toString('hex')}`;
let app, servers, pd, ai, chord, dir;
const spawned = new Set(); // pids started outside tmux by this test, killed in after()
const sessions = []; // {session, workspace} started on the private socket, stopped in after()
// Throwaway processes end by themselves even if this test is killed before after() runs.
const LIFETIME = 240;
const httpd = (port, root = '.') => `timeout -s KILL ${LIFETIME} busybox httpd -f -p 127.0.0.1:${port} -h ${root}`;
// Sleep durations unique to this run, so a concurrent run of this file is never mistaken for ours.
const SLEEP = 200 + Math.floor(Math.random() * 40) * 2;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-stop-test-'));
  if (!available) return;
  app = await assembleApp();
  servers = await app.load('builtin/core-servers/web/servers.js');
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
});
after(async () => {
  for (const { session, workspace } of sessions) await stop(realEnv(workspace), session, { workspace }).catch(() => {});
  if (tools) await run(`tmux -L '${SOCKET}' kill-server 2>/dev/null; rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${SOCKET}"; true`, {});
  for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch {} } // detached: its own process group
  await app?.remove();
  if (dir) await rm(dir, { recursive: true, force: true });
});
const context = () => chord.BACKGROUND_CONTEXT;
const tmux = (args) => run(`tmux -L '${SOCKET}' ${args}`, {});
const answers = async (port) => (await run(`curl -sS -m 2 -o /dev/null http://127.0.0.1:${port}/`, {})).code === 0;
const alive = (pid) => access(`/proc/${pid}/stat`).then(() => readFile(`/proc/${pid}/stat`, 'utf8').then((text) => !/\) [ZX] /.test(text)), () => false);
const panePid = async (session) => Number((await tmux(`list-panes -s -t '=${session}' -F '#{pane_pid}'`)).stdout.trim());
const stop = (env, session, target) => servers.killSessionIn(env, context(), session, 15, { sockets: [`-L '${SOCKET}'`], graceMs: 1500, ...target });

/** A server started the way launchSession does (launcher script in tmux), on the private socket. */
async function startServer(name, command, { launcher = true } = {}) {
  const workspace = await mkdtemp(join(dir, `${name}-`));
  const session = `srv-test-${name}`;
  await mkdir(join(workspace, '.services/logs'), { recursive: true });
  await writeFile(join(workspace, 'index.html'), 'dummy page\n');
  let shellCommand = command;
  if (launcher) {
    const script = join(workspace, `.services/${name}.sh`);
    await writeFile(script, servers.launcherScript({ name, workspace, cwd: workspace, command }, session));
    shellCommand = `sh '${script}'`;
  }
  const started = await tmux(`new-session -d -s '${session}' -c '${workspace}' "${shellCommand.replace(/"/g, '\\"')}"`);
  assert.equal(started.code, 0, started.stderr);
  sessions.push({ workspace, session });
  return { workspace, session };
}

test('a SIGHUP-proof busybox httpd: tmux kill-session alone leaves it answering (the bug), the verified stop ends it', { skip: skipReal, timeout: 60000 }, async () => {
  const port = await freePort();
  const { workspace, session } = await startServer('httpd', httpd(port));
  await until(() => answers(port), 'httpd did not start', 10000);
  const pid = await panePid(session);
  const env = realEnv(workspace);
  await stop(env, session, { workspace, health: port });
  assert.equal(await answers(port), false, 'port still answers after stop');
  assert.equal(await alive(pid), false);
  assert.equal((await tmux(`has-session -t '=${session}'`)).code, 1);
  await assert.rejects(access(join(workspace, `.services/run/${session}.pid`)), 'the launch identity is removed after a verified stop');
  // A second stop finds nothing and succeeds without touching anything.
  await stop(env, session, { workspace, health: port });
});

test('servers launched before the fix and orphans of the old kill-session-only stop are found and ended', { skip: skipReal, timeout: 60000 }, async () => {
  // (a) No launcher identity (older launcher): found through the tmux pane.
  const portA = await freePort();
  const old = await startServer('old', httpd(portA, '/'), { launcher: false });
  await until(() => answers(portA), 'old httpd did not start', 10000);
  await stop(realEnv(old.workspace), old.session, { workspace: old.workspace, health: portA });
  assert.equal(await answers(portA), false);
  // (b) The old stop: only kill-session; httpd survives, reparented. The launch identity finds it.
  const portB = await freePort();
  const orphan = await startServer('orphan', httpd(portB));
  await until(() => answers(portB), 'orphan httpd did not start', 10000);
  const pid = await panePid(orphan.session);
  await tmux(`kill-session -t '=${orphan.session}'`);
  await sleep(300);
  assert.equal(await answers(portB), true, 'precondition: kill-session alone leaves httpd answering');
  await stop(realEnv(orphan.workspace), orphan.session, { workspace: orphan.workspace, health: portB });
  assert.equal(await answers(portB), false);
  assert.equal(await alive(pid), false);
});

test('TERM-ignoring children, a detached grandchild and a busy parent are all ended (KILL after the grace period)', { skip: skipReal, timeout: 60000 }, async () => {
  const port = await freePort();
  // The server shell ignores TERM, starts httpd, a TERM-ignoring sleeper and a grandchild whose parent exits (orphan in the group).
  const command = `trap '' TERM; ${httpd(port)} & (trap '' TERM; exec sleep ${SLEEP}) & (sleep ${SLEEP + 1} &) ; wait`;
  const { workspace, session } = await startServer('stubborn', command);
  await until(() => answers(port), 'stubborn server did not start', 10000);
  // The sleepers of THIS server: same tmux session id as its pane (a concurrent run of this file has other panes).
  const pane = await panePid(session);
  const sleepers = async () => (await run(`for f in /proc/[0-9]*/stat; do set -- $(sed 's/.*) //' "$f" 2>/dev/null); [ "$4" = ${pane} ] && grep -q '(sleep)' "$f" 2>/dev/null && { p=\${f#/proc/}; echo \${p%/stat}; }; done`, {})).stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  await until(async () => (await sleepers()).length === 2, 'both sleepers run');
  const members = await sleepers();
  const started = Date.now();
  await stop(realEnv(workspace), session, { workspace, health: port });
  assert.ok(Date.now() - started >= 1400, 'the grace period was given before KILL');
  assert.equal(await answers(port), false);
  for (const pid of members) assert.equal(await alive(pid), false, `sleeper ${pid} survived`);
});

test('never touches processes outside the server: an unrelated listener on the health port fails the verification and keeps running', { skip: skipReal, timeout: 60000 }, async () => {
  const port = await freePort();
  const foreign = spawn('timeout', ['-s', 'KILL', String(LIFETIME), 'busybox', 'httpd', '-f', '-p', `127.0.0.1:${port}`, '-h', dir], { stdio: 'ignore', detached: true });
  spawned.add(foreign.pid);
  await until(() => answers(port), 'foreign httpd did not start', 10000);
  // Nothing of this server exists: the stop succeeds without looking at the port.
  const empty = await mkdtemp(join(dir, 'empty-'));
  await stop(realEnv(empty), 'srv-test-nothing', { workspace: empty, health: port });
  // A real server with its session, but the health port is answered by someone else.
  const { workspace, session } = await startServer('innocent', `exec sleep ${SLEEP + 2}`);
  await until(async () => (await panePid(session)) > 0, 'session did not start');
  const pid = await panePid(session);
  await assert.rejects(stop(realEnv(workspace), session, { workspace, health: port }),
    (error) => /^Stop of srv-test-innocent is not verified: health endpoint \d+ still answers, but no process of srv-test-innocent is left \(stopped: [\d, ]+\); whatever answers is not part of this server and was not touched\.$/.test(error.message));
  assert.equal(await alive(pid), false, 'the server itself was stopped');
  assert.equal(await alive(foreign.pid), true, 'the unrelated process was not touched');
  assert.equal(await answers(port), true);
  process.kill(-foreign.pid, 'SIGKILL'); // timeout and its httpd
  spawned.delete(foreign.pid);
  await until(async () => !(await answers(port)), 'the foreign httpd did not end');
});

test('a group or session shared with the app\'s own commands never selects processes', { skip: skipReal, timeout: 30000 }, async () => {
  // A sleeper in this test runner's process group (as every app command shares one), and an entry naming that group.
  const sleeper = spawn('sleep', [String(SLEEP + 3)], { stdio: 'ignore' });
  spawned.add(sleeper.pid);
  try {
    const field = async (pid, index) => (await readFile(`/proc/${pid}/stat`, 'utf8')).replace(/^.*\) /s, '').split(' ')[index];
    const group = await field(sleeper.pid, 2);
    assert.equal(group, await field(process.pid, 2), 'precondition: same group as the runner');
    const env = realEnv(dir);
    for (const known of [[`4194999::${group}:0`], [`4194999::0:${group}`]]) {
      let out = '';
      const result = await env.exec(servers.treeScript({ mode: 'check', session: 'srv-test-none', sockets: [`-L '${SOCKET}'`], known }), { onOutput: (text) => { out += text; } });
      assert.equal(result.value.exitCode, 0);
      assert.match(out, /^sf-tree alive: *$/m, `selected by ${known}: ${out}`);
    }
    assert.equal(await alive(sleeper.pid), true);
  } finally {
    sleeper.kill('SIGKILL');
    spawned.delete(sleeper.pid);
  }
});

// ----------------------------------------------------------------- mocked protocol

/** tmuxFake plus answers for the process-tree steps: `survivors` stay "alive" while set. */
function treeFake(env) {
  const state = tmuxFake(env);
  state.survivors = [];
  state.treeSteps = [];
  const exec = env.exec;
  env.exec = async (command, options = {}, callContext) => {
    if (command.startsWith('SF_AWK=')) {
      state.commands.push(command);
      const mode = command.includes('sf_term; i=0') ? 'stop' : 'check';
      state.treeSteps.push(mode);
      const list = state.survivors.join(' ');
      options.onOutput?.(`sf-tree found: ${list} \nsf-tree alive: ${list} \n`);
      return { ok: true, value: { exitCode: 0 } };
    }
    return exec(command, options, callContext);
  };
  return state;
}

test('killSessionIn: survivors are retried once, then reported with their pids; an empty tree is not checked', { skip }, async () => {
  const env = { cwd: '/w' };
  const state = treeFake(env);
  state.sessions.add('srv-9');
  state.survivors = ['4242:777:4242:4242', '4243:778:4242:4242'];
  await assert.rejects(servers.killSessionIn(env, context(), 'srv-9', 5, { workspace: '/w', health: 3000, graceMs: 0 }),
    /^Error: Stop of srv-9 is not verified: process\(es\) 4242, 4243 of srv-9 are still alive after TERM and KILL\.$/);
  assert.deepEqual(state.treeSteps, ['stop', 'check', 'stop', 'check']);
  assert.ok(state.commands.some((command) => command.includes("for e in '4242:777:4242:4242' '4243:778:4242:4242'; do sf_add")), 'the retry knows what the first attempt found');
  // Nothing exists: one scan, no check, no health probe.
  state.treeSteps.length = 0;
  state.survivors = [];
  state.commands.length = 0;
  await servers.killSessionIn(env, context(), 'srv-10', 5, { workspace: '/w', health: 3000, graceMs: 0 });
  assert.deepEqual(state.treeSteps, ['stop']);
  assert.ok(!state.commands.some((command) => command.startsWith('curl ')));
  // A remote health URL may answer without this phone's process: only loopback endpoints are verified after a stop.
  state.sessions.add('srv-11');
  state.treeSteps.length = 0;
  await servers.killSessionIn(env, context(), 'srv-11', 5, { workspace: '/w', health: 'https://example.com/health', graceMs: 0 });
  assert.deepEqual(state.treeSteps, ['stop', 'check']);
  assert.ok(!state.commands.some((command) => command.startsWith('curl ')));
  // The generated shell parses (sh -n) in both modes.
  for (const mode of ['stop', 'check']) {
    const script = servers.treeScript({ mode, session: 'srv-1', sockets: ['-L sf-x', '', "-L 'srv-1'"], pidFile: '/w/.services/run/srv-1.pid', known: ['1:2:3:4'] });
    assert.equal((await run('sh -n', { input: script })).code, 0, mode);
    assert.equal((await run('bash -n', { input: script })).code, 0, mode);
  }
});

/** A pi-durable harness with the servers extension over the fake environment. */
async function harnessFixture(t) {
  const env = { cwd: '/w' };
  const state = treeFake(env);
  let harness;
  const built = servers.createServers({ rootConversationId: pd.ROOT_CONVERSATION_ID, abortTask: (id, ctx) => harness.abortTask(id, ctx),
    timing: { intervalMs: 25, backoffMs: [30], maxFailures: 3, defaultGraceMs: 0, stopGraceMs: 0, stopPollMs: 10 } });
  const registry = pd.createRegistry();
  registry.install(built.extension);
  harness = await pd.Harness.open(new pd.MemoryStorage(), { models: ai.createModels(), registry, env: () => env }, context());
  t.after(() => harness.close(context()));
  const root = await harness.root(context(), { agent: { cwd: env.cwd } });
  const api = { env, agent: (ctx) => root.agent(ctx), snapshot: (doc, ctx) => harness.snapshot(doc, ctx), getTask: (id, ctx) => harness.getTask(id, ctx),
    waitForTask: (id, ctx) => harness.waitForTask(id, ctx), commit: (fn, ctx) => harness.commit(fn, ctx) };
  const call = (args) => built.manage(args, api, context());
  harness.resume();
  return { env, state, harness, call };
}

test('stop reports a failed cleanup instead of success; restart starts nothing until the stop is verified', { skip, timeout: 30000 }, async (t) => {
  const { state, harness, call } = await harnessFixture(t);
  const started = await call({ action: 'start', name: 'web', command: 'serve', health: 8791 });
  const id = started.details.taskId;
  await until(async () => (await harness.getTask(id, context())).state.checkpoint?.healthyAt !== undefined, 'not healthy');
  assert.equal(state.launches.length, 1);
  state.survivors = ['5151:900:5151:5151'];
  await assert.rejects(call({ action: 'stop', name: 'web' }),
    /^Error: web is not stopped yet: Stop pending: Stop of srv-\S+ is not verified: process\(es\) 5151 of srv-\S+ are still alive after TERM and KILL\. The stop is retried in the background; check status before starting it again\.$/);
  const status = await call({ action: 'status', name: 'web' });
  assert.match(status.content[0].text, /^web: stopping .*\n[\s\S]*last error: Stop pending: Stop of srv-\S+ is not verified: process\(es\) 5151/);
  await assert.rejects(call({ action: 'restart', name: 'web' }), /web is not stopped yet/);
  assert.equal(state.launches.length, 1, 'restart did not launch on top of a live server');
  // Once the processes are gone, the pending stop completes in the background; restart then works.
  state.survivors = [];
  const receipt = await harness.waitForTask(id, context());
  assert.equal(receipt.state.outcome.status, 'aborted');
  const restarted = await call({ action: 'restart', name: 'web' });
  assert.match(restarted.content[0].text, /^Stopped web \(tmux session srv-\S+ killed\)\.\nScheduled restart of web|^web was not running/);
  await until(() => state.launches.length === 2, 'restart did not launch');
});

test('a clean stop keeps its message; the health endpoint is verified after the tree is gone', { skip, timeout: 30000 }, async (t) => {
  const { state, harness, call } = await harnessFixture(t);
  const started = await call({ action: 'start', name: 'api', command: 'serve-api', health: 8792 });
  const id = started.details.taskId;
  await until(async () => (await harness.getTask(id, context())).state.checkpoint?.healthyAt !== undefined, 'not healthy');
  const before = state.commands.length;
  const stopped = await call({ action: 'stop', name: 'api' });
  assert.equal(stopped.content[0].text, `Stopped api (tmux session srv-${id} killed).`);
  const during = state.commands.slice(before);
  const order = during.map((command) => command.startsWith('SF_AWK=') ? (command.includes('sf_term; i=0') ? 'tree-stop' : 'tree-check')
    : command.includes('kill-session') ? 'kill-session' : command.startsWith('curl ') ? 'health' : null).filter(Boolean);
  assert.deepEqual(order, ['tree-stop', 'kill-session', 'tree-check', 'health']);
  assert.ok(during.find((command) => command.startsWith('SF_AWK=')).includes(`/w/.services/run/srv-${id}.pid`), 'the launch identity of this task is used');
});
