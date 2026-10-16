import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { baseEnv, run, startFakeBroker } from './plugin-servers-fix-support.mjs';

// The sf-secrets helper (scripts/sf-secrets.sh) and how servers.js installs it and uses it
// in the launcher. Only a FAKE broker on loopback (plugin-servers-fix-support.mjs) with
// DUMMY values; the real broker, keystore and .pi-secrets are never used. Real /bin/sh,
// curl and jq run the helper, as in the Ubuntu runtime.
const HELPER = fileURLToPath(new URL('../scripts/sf-secrets.sh', import.meta.url));
const DUMMY = {
  DUMMY_TOKEN: "abc'def",
  DUMMY_TRICKY: 'line one\nline two $HOME `id` $(id) "dq" \\n \'\' end',
  DUMMY_EMPTY: ''
};
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, servers, chord, broker, dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-secrets-test-'));
  broker = await startFakeBroker();
  if (!available) return;
  app = await assembleApp();
  servers = await app.load('builtin/core-servers/web/servers.js');
  chord = await app.load('library/chord/context.js');
});
after(async () => {
  await broker?.close();
  await app?.remove();
  if (dir) await rm(dir, { recursive: true, force: true });
});
const answer = (value) => { broker.state.answer = { status: 200, values: {}, denied: [], locked: [], ...value }; };
const brokerEnv = (extra = {}) => baseEnv({ SF_SECRETS_URL: broker.url, SF_SECRETS_TOKEN: broker.token, ...extra });
const valuesIn = (text) => Object.values(DUMMY).filter((value) => value.length >= 3 && text.includes(value));

test('the helper source is the copy servers.js installs (byte for byte)', { skip }, async () => {
  assert.equal(servers.SF_SECRETS_SCRIPT, await readFile(HELPER, 'utf8'));
  assert.match(servers.SF_SECRETS_SCRIPT, /^#!\/bin\/sh\n# sf-secrets-version: \d+\n/);
});

test('--exports prints only shell-safe export lines that round-trip through eval', async () => {
  answer({ values: DUMMY });
  broker.state.requests.length = 0;
  const result = await run(`sh ${HELPER} --exports --label 'Server my web' --wait 7`, { env: brokerEnv() });
  assert.equal(result.code, 0);
  const lines = result.stdout.trimEnd().split('\n').filter((line) => line.startsWith('export '));
  assert.deepEqual(lines.map((line) => line.split('=')[0]).sort(), ['export DUMMY_EMPTY', 'export DUMMY_TOKEN', 'export DUMMY_TRICKY']);
  // Everything on stdout parses as exports (the multi-line value is inside single quotes).
  const parsed = await run(`eval "$(cat)"; for n in DUMMY_TOKEN DUMMY_TRICKY DUMMY_EMPTY; do eval "v=\\$$n"; printf '%s=%s\\0' "$n" "$v"; done`, { env: baseEnv(), input: result.stdout });
  const got = Object.fromEntries(parsed.stdout.split('\0').filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  assert.deepEqual(got, DUMMY);
  assert.match(lines.find((line) => line.startsWith('export DUMMY_TOKEN=')), /^export DUMMY_TOKEN='abc'\\''def'$/);
  // Diagnostics name what was delivered, never a value.
  assert.match(result.stderr, /^sf-secrets: delivered: DUMMY_EMPTY, DUMMY_TOKEN, DUMMY_TRICKY$/m);
  assert.deepEqual(valuesIn(result.stderr), []);
  // Protocol: GET /v1/env with the bearer token, the label and the wait.
  assert.deepEqual(broker.state.requests, [{ method: 'GET', path: '/v1/env', label: 'Server my web', wait: '7', authorized: true }]);
});

test('without SF_SECRETS_URL/TOKEN the helper is a silent no-op', async () => {
  for (const env of [baseEnv(), baseEnv({ SF_SECRETS_URL: broker.url }), baseEnv({ SF_SECRETS_TOKEN: broker.token })]) {
    const result = await run(`sh ${HELPER} --exports --label x --wait 1`, { env });
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  }
});

test('refusals and broken answers: exit 1, nothing on stdout, a "secrets unavailable" reason on stderr', async () => {
  const cases = [
    [{ status: 401 }, brokerEnv(), /secrets unavailable: the secret broker refused the token \(HTTP 401/],
    [{ status: 200 }, brokerEnv({ SF_SECRETS_TOKEN: 'not' + 'the-token' }), /HTTP 401/],
    [{ status: 404 }, brokerEnv(), /secrets unavailable: the secret broker answered HTTP 404/],
    [{ status: 200, raw: '{"values":{"DUMMY_TOKEN":42}}' }, brokerEnv(), /secrets unavailable: the secret broker sent an unexpected answer/],
    [{ status: 200, raw: 'not json' }, brokerEnv(), /secrets unavailable: the secret broker sent an unexpected answer/],
    [{ status: 200 }, brokerEnv({ SF_SECRETS_URL: 'http://example.invalid:1' }), /secrets unavailable: SF_SECRETS_URL is not a loopback broker address/],
    [{ status: 200 }, brokerEnv({ SF_SECRETS_TOKEN: 'bad"token' }), /secrets unavailable: SF_SECRETS_TOKEN has an unexpected format/]
  ];
  for (const [reply, env, reason] of cases) {
    answer({ values: DUMMY, ...reply });
    const result = await run(`sh ${HELPER} --exports --wait 1`, { env });
    assert.equal(result.code, 1, String(reason));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, reason);
    assert.deepEqual(valuesIn(result.stderr), []);
  }
  const usage = await run(`sh ${HELPER} --exports --wait soon`, { env: brokerEnv() });
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
});

test('an unreachable broker is reported after retries, without output', { timeout: 30000 }, async () => {
  const gone = await startFakeBroker();
  await gone.close();
  const result = await run(`sh ${HELPER} --exports --wait 1`, { env: baseEnv({ SF_SECRETS_URL: gone.url, SF_SECRETS_TOKEN: gone.token }) });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /secrets unavailable: the secret broker is not reachable at http:\/\/127\.0\.0\.1:\d+/);
});

test('declined and locked names: the rest is exported, the names are reported (exit 0)', async () => {
  answer({ values: { DUMMY_TOKEN: DUMMY.DUMMY_TOKEN }, denied: ['DUMMY_FP'], locked: ['DUMMY_LOCKED'] });
  const result = await run(`sh ${HELPER} --exports --wait 1`, { env: brokerEnv() });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "export DUMMY_TOKEN='abc'\\''def'\n");
  assert.match(result.stderr, /^sf-secrets: secrets unavailable: declined or not answered in time: DUMMY_FP; cannot be unlocked \(no fingerprint or screen lock available\): DUMMY_LOCKED$/m);
  const names = await run(`sh ${HELPER} --names --wait 1`, { env: brokerEnv() });
  assert.equal(names.stdout, 'DUMMY_TOKEN\n');
  // Names that are not shell variable names are skipped, never printed into an export line.
  answer({ values: { 'bad name; rm -rf x': 'zzz', DUMMY_TOKEN: 'ok' } });
  const odd = await run(`sh ${HELPER} --exports --wait 1`, { env: brokerEnv() });
  assert.equal(odd.stdout, "export DUMMY_TOKEN='ok'\n");
  assert.match(odd.stderr, /skipped 1 secret\(s\)/);
});

test('installation: missing or outdated helper is (re)installed with mode 0700, an identical one is left alone', { skip }, async () => {
  const workspace = await mkdtemp(join(dir, 'ws-'));
  const target = join(workspace, '.tools/bin/sf-secrets');
  const install = () => run(servers.helperInstallScript(workspace), { env: baseEnv() });
  assert.equal((await install()).code, 0);
  assert.equal(await readFile(target, 'utf8'), servers.SF_SECRETS_SCRIPT);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  const first = (await stat(target)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await install()).code, 0);
  assert.equal((await stat(target)).mtimeMs, first, 'an up-to-date helper is not rewritten');
  await writeFile(target, '#!/bin/sh\n# sf-secrets-version: 0\necho old\n');
  await chmod(target, 0o755);
  assert.equal((await install()).code, 0);
  assert.equal(await readFile(target, 'utf8'), servers.SF_SECRETS_SCRIPT);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(workspace, '.tools/bin')), ['sf-secrets'], 'no temporary files left');
  // An unwritable location never fails the launch command.
  const blocked = await mkdtemp(join(dir, 'blocked-'));
  await writeFile(join(blocked, '.tools'), 'a file, not a directory');
  const failed = await run(servers.helperInstallScript(blocked), { env: baseEnv() });
  assert.equal(failed.code, 0);
  assert.match(failed.stderr, /sf-secrets could not be installed/);
});

/** Writes a launcher like launchSession does and runs it to the end (the "server" is a short command). */
async function launch(workspace, { env, command, install = true, name = 'web' }) {
  const input = { name, workspace, cwd: workspace, command };
  await mkdir(join(workspace, '.services/logs'), { recursive: true });
  const script = join(workspace, `.services/${name}.sh`);
  await writeFile(script, servers.launcherScript(input, 'srv-test-1'));
  if (install) assert.equal((await run(servers.helperInstallScript(workspace), { env: baseEnv() })).code, 0);
  const result = await run(`sh '${script}'`, { env, cwd: workspace });
  const read = (path) => readFile(join(workspace, path), 'utf8').catch(() => undefined);
  return { result, log: await read(`.services/logs/${name}.log`), state: await read(`.services/logs/${name}.secrets`), got: await read('got'), pid: await read('.services/run/srv-test-1.pid') };
}
const SERVE = `printf '%s' "\${DUMMY_TOKEN-unset}" > got`;

test('launcher: secrets reach the server, the log names them without values, the launch identity is recorded', { skip }, async () => {
  answer({ values: { DUMMY_TOKEN: DUMMY.DUMMY_TOKEN, DUMMY_TRICKY: DUMMY.DUMMY_TRICKY } });
  broker.state.requests.length = 0;
  const workspace = await mkdtemp(join(dir, 'ws-'));
  const { result, log, state, got, pid } = await launch(workspace, { env: brokerEnv(), command: SERVE });
  assert.equal(result.code, 0);
  assert.equal(got, DUMMY.DUMMY_TOKEN);
  assert.equal(state, undefined, 'no "secrets unavailable" state');
  assert.match(log, /sf-secrets: delivered: DUMMY_TOKEN, DUMMY_TRICKY/);
  assert.deepEqual(valuesIn(log), []);
  assert.deepEqual(broker.state.requests.map((request) => [request.label, request.wait]), [['Server web', '20']]);
  assert.match(pid, /^\d+ \d+ \d+ \d*\n$/);
  assert.deepEqual(await readdir(join(workspace, '.services/logs')), ['web.log'], 'no wait or error files left');
});

test('launcher: a missing helper, a refusing broker or a declined fingerprint still start the server and say "secrets unavailable"', { skip }, async () => {
  const missing = await launch(await mkdtemp(join(dir, 'ws-')), { env: brokerEnv(), command: SERVE, install: false });
  assert.equal(missing.got, 'unset', 'the server still started');
  assert.match(missing.state, /^secrets unavailable: the helper .*\/\.tools\/bin\/sf-secrets is missing\n$/);
  assert.match(missing.log, /^secrets unavailable: the helper .* is missing$/m);

  answer({ status: 401, values: DUMMY });
  const refused = await launch(await mkdtemp(join(dir, 'ws-')), { env: brokerEnv(), command: SERVE });
  assert.equal(refused.got, 'unset');
  assert.match(refused.state, /^secrets unavailable: the secret broker refused the token \(HTTP 401/);
  assert.match(refused.log, /^secrets unavailable: the secret broker refused the token/m);

  answer({ values: { DUMMY_TOKEN: DUMMY.DUMMY_TOKEN }, denied: ['DUMMY_FP'] });
  const declined = await launch(await mkdtemp(join(dir, 'ws-')), { env: brokerEnv(), command: SERVE });
  assert.equal(declined.got, DUMMY.DUMMY_TOKEN);
  assert.equal(declined.state, 'secrets unavailable: declined or not answered in time: DUMMY_FP\n');

  const none = await launch(await mkdtemp(join(dir, 'ws-')), { env: baseEnv(), command: SERVE });
  assert.equal(none.got, 'unset');
  assert.equal(none.state, undefined);
  assert.match(none.log, /^secrets: none \(no secret broker in this environment\)$/m);
  for (const outcome of [missing, refused, declined, none]) assert.deepEqual(valuesIn(outcome.log + (outcome.state ?? '')), []);
});

test('status shows "secrets unavailable: <reason>" for a running server whose launch could not get its secrets', { skip }, async () => {
  const workspace = await mkdtemp(join(dir, 'ws-'));
  await mkdir(join(workspace, '.services/logs'), { recursive: true });
  await writeFile(join(workspace, '.services/logs/web.secrets'), 'secrets unavailable: the secret broker refused the token (HTTP 401)\n');
  const built = servers.createServers({ rootConversationId: 'root' });
  const records = {
    t1: { state: { status: 'running', checkpoint: { phase: 'watch', healthyAt: 1, failures: 0, restarts: 0 } }, input: { name: 'web', workspace } },
    t2: { state: { status: 'running', checkpoint: { phase: 'watch', healthyAt: 1, failures: 0, restarts: 0 } }, input: { name: 'api', workspace } }
  };
  const { spawn } = await import('node:child_process');
  const env = {
    cwd: workspace,
    exec: (command, options) => new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { env: baseEnv() });
      child.stdout.on('data', (chunk) => options.onOutput?.(String(chunk)));
      child.on('close', (code) => resolve({ ok: true, value: { exitCode: code } }));
    })
  };
  const api = {
    env,
    snapshot: async () => ({ servers: { web: { taskId: 't1', command: 'serve', cwd: workspace }, api: { taskId: 't2', command: 'serve-api', cwd: workspace } } }),
    getTask: async (id) => records[id]
  };
  const result = await built.manage({ action: 'status' }, api, chord.BACKGROUND_CONTEXT);
  const text = result.content[0].text;
  assert.match(text, /^web: running · restarts 0 · serve \(in .*\)\n {2}session srv-t1 · tmux -L sf-servers attach -t srv-t1\n {2}secrets unavailable: the secret broker refused the token \(HTTP 401\)$/m);
  assert.equal(text.split('\n').filter((line) => line.startsWith('  secrets unavailable')).length, 1, 'only web has a secrets line');
  assert.equal(result.details.web.secrets, 'secrets unavailable: the secret broker refused the token (HTTP 401)');
  assert.equal(result.details.api.secrets, undefined);
  // A stopped server shows no stale secrets line.
  records.t1.state = { status: 'terminal', outcome: { status: 'aborted' } };
  const stopped = await built.manage({ action: 'status', name: 'web' }, api, chord.BACKGROUND_CONTEXT);
  assert.doesNotMatch(stopped.content[0].text, /secrets unavailable/);
});

