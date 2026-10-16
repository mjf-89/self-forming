// core-servers in the browser edition (explicit Linux). Part 1: mocked execution environments
// (the JavaScript tmux fake of plugin-a4-support.mjs) with a real pi-durable harness: every
// browser command runs in the session's Linux environment (env.shell bash, execution@1 exec-linux)
// with no added variables, the JavaScript environment is refused clearly, Android is unchanged; the capability gate; no package installation and a clear message without tmux;
// secrets unsupported; tab-bound lifetime (a reload restarts, status never reports a process
// of an earlier page as running). Part 2: the real v86 VM (repository image by default, PI_V86_VENDOR overrides), through the real browser
// execution backend and ExecutionEnv. Run each file in its own node process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { heavy } from "./heavy.mjs";
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { tmuxFake } from './plugin-a4-support.mjs';
import { toolsFor } from './plugin-a2-support.mjs';

const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const BROWSER = Object.freeze({ platform: 'browser', capabilities: { executionEnv: true, linuxShell: true, secrets: false, backgroundExecution: false } });
const BROWSER_NO_LINUX = Object.freeze({ platform: 'browser', capabilities: { executionEnv: true, secrets: false } });
// env.shell of the two browser execution@1 providers (E1).
const LINUX_SHELL = Object.freeze({ id: 'bash', language: 'bash', name: 'Linux (Bash)' });
const JS_SHELL = Object.freeze({ id: 'javascript', language: 'javascript', name: 'JavaScript' });
const ANDROID = Object.freeze({ platform: 'android', capabilities: { executionEnv: true, backgroundExecution: true, secrets: true } });
const TIMING = { intervalMs: 25, backoffMs: [30], maxFailures: 2, defaultGraceMs: 0, stopGraceMs: 0, stopPollMs: 10, postponeMs: 20 };
let app, servers, pd, ai, chord, core, service, session;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  servers = await app.load('builtin/core-servers/web/servers.js');
  service = await app.load('builtin/core-servers/web/servers-service.js');
  core = await app.load('core-agent-plugins.js');
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
  session = await app.load('session.js');
});
after(async () => { await app?.remove(); });
const context = () => chord.BACKGROUND_CONTEXT;

/** tmux fake that records every exec with its env option; optionally an image without tmux. */
function recordingEnv({ tmux = true, cwd = '/workspace', secretsLine, shell = LINUX_SHELL } = {}) {
  const env = { cwd, ...shell ? { shell } : {} };
  const state = tmuxFake(env);
  state.calls = [];
  const inner = env.exec;
  env.exec = async (command, options = {}, callContext) => {
    state.calls.push({ command, env: options.env });
    if (command.startsWith('command -v tmux >/dev/null 2>&1 || {')) {
      if (tmux) return { ok: true, value: { exitCode: 0 } };
      options.onOutput?.('this Linux image lacks tmux\n');
      return { ok: true, value: { exitCode: 1 } };
    }
    if (command.startsWith('f=')) { // secrets state files of running servers
      if (secretsLine) options.onOutput?.(`0\t${secretsLine}\n`);
      return { ok: true, value: { exitCode: 0 } };
    }
    return inner(command, options, callContext);
  };
  return { env, state };
}

class ReopenableStorage {
  static create() { return new (class extends pd.MemoryStorage { async close() {} })(); }
}

async function fixture(t, { hostInfo, env, storage = new pd.MemoryStorage(), resume = true }) {
  let harness;
  const built = servers.createServers({ rootConversationId: pd.ROOT_CONVERSATION_ID, abortTask: (id, ctx) => harness.abortTask(id, ctx), timing: TIMING, ...(hostInfo ? { hostInfo } : {}) });
  const registry = pd.createRegistry();
  registry.install(built.extension);
  harness = await pd.Harness.open(storage, { models: ai.createModels(), registry, env: () => env }, context());
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await harness.close(context()); } };
  t.after(close);
  const root = await harness.root(context(), { agent: { cwd: env.cwd } });
  const api = { env, agent: (ctx) => root.agent(ctx), snapshot: (doc, ctx) => harness.snapshot(doc, ctx), getTask: (id, ctx) => harness.getTask(id, ctx),
    waitForTask: (id, ctx) => harness.waitForTask(id, ctx), commit: (fn, ctx) => harness.commit(fn, ctx) };
  const call = (args) => built.manage(args, api, context());
  if (resume) harness.resume();
  return { built, harness, call, close };
}
const healthyTask = (harness, id) => until(async () => (await harness.getTask(id, context())).state.checkpoint?.healthyAt !== undefined, 'server did not become healthy');

async function lifecycle(t, hostInfo) {
  const { env, state } = recordingEnv({ cwd: hostInfo ? '/workspace' : '/w', shell: hostInfo?.platform === 'browser' ? LINUX_SHELL : null });
  const { harness, call, built } = await fixture(t, { hostInfo, env });
  const started = await call({ action: 'start', name: 'web', command: 'busybox httpd -f -p 8080', health: 8080 });
  await healthyTask(harness, started.details.taskId);
  const status = await call({ action: 'status' });
  const logs = await call({ action: 'logs', name: 'web', lines: 5 });
  const restarted = await call({ action: 'restart', name: 'web' });
  await until(() => state.launches.length === 2, 'restart did not launch');
  await healthyTask(harness, restarted.details.taskId);
  const stopped = await call({ action: 'stop', name: 'web' });
  return { state, started, status, logs, restarted, stopped, built };
}

test('browser: every command core-servers issues runs unchanged in the Linux environment (no PI_EXEC_KIND); nothing installs packages or uses the secret broker', { skip, timeout: 60000 }, async (t) => {
  const { state, started, status, logs, stopped, built } = await lifecycle(t, BROWSER);
  assert.ok(state.calls.length > 10, 'the lifecycle ran commands');
  for (const { command, env } of state.calls) {
    assert.equal(env?.PI_EXEC_KIND, undefined, `command-level selector: ${command.slice(0, 80)}`);
    assert.equal(env?.PI_SECRET_SCOPE, undefined, 'no secret scope in the browser');
    assert.doesNotMatch(command, /apt-get|DEBIAN_FRONTEND|update-environment|SF_SECRETS_TOKEN=|\.tools\/bin\/sf-secrets/);
    assert.doesNotMatch(command, /\/workspace\/\.services/, 'state stays inside the VM, outside the live /workspace');
  }
  const launcher = state.calls.find(({ command }) => command.includes("cat > '/var/lib/sf-servers/web.sh'"));
  assert.ok(launcher, 'launcher written to the guest-only state directory');
  assert.match(launcher.command, /secrets: not supported in the browser edition/);
  assert.match(launcher.command, /PATH='\/var\/lib\/sf-servers\/bin':"\$PATH"; export PATH/);
  assert.match(launcher.command, /sf-secrets \(browser edition\)/);
  assert.match(launcher.command, /exec bash -lc 'busybox httpd -f -p 8080'/);
  assert.ok(state.calls.some(({ command }) => command.includes("/var/lib/sf-servers/run/srv-")), 'stop uses the guest-only pid file');
  assert.ok(state.calls.filter(({ command }) => command.startsWith('command -v tmux >/dev/null 2>&1 || {')).length >= 2, 'tmux is re-checked, not cached per page');
  assert.match(started.content[0].text, /stops when the tab is closed or reloaded and is started again when the app is opened again/);
  assert.match(started.content[0].text, /no browser preview/);
  assert.match(status.content[0].text, /^web: running/);
  assert.match(status.content[0].text, /they stop when the tab is closed or reloaded and are started again when the app is opened again/);
  assert.match(status.content[0].text, /the browser has no preview of guest ports/);
  assert.match(logs.content[0].text, /line one/);
  assert.match(stopped.content[0].text, /^Stopped web/);
  const description = built.tools[0].description;
  assert.match(description, /Servers live only while this tab is open: closing or reloading the tab stops them, and they are started again when the app is opened again/);
  assert.match(description, /no preview/);
  assert.match(description, /Service secrets are not supported in the browser edition/);
  assert.doesNotMatch(description, /comes back after the app restarts/);
});

test('Android: commands carry no PI_EXEC_KIND; env options, paths and texts are as before', { skip, timeout: 60000 }, async (t) => {
  const { state, started, status, built } = await lifecycle(t, undefined);
  const lifecycleAndroid = await lifecycle(t, ANDROID); // an explicit android hostInfo behaves the same
  for (const calls of [state.calls, lifecycleAndroid.state.calls]) {
    for (const { command, env } of calls) {
      if (env !== undefined) {
        assert.deepEqual(env, { PI_SECRET_SCOPE: 'servers' }, 'only the tmux start has an env (secret scope)');
        assert.match(command, /update-environment 'SF_SECRETS_URL SF_SECRETS_TOKEN'/);
      }
      assert.doesNotMatch(command, /\/var\/lib\/sf-servers|PI_EXEC_KIND/);
    }
    assert.equal(calls.filter(({ command }) => command.includes('apt-get install -y -q tmux')).length, 1, 'tmux provisioning once per environment');
  }
  assert.ok(state.calls.some(({ command }) => command.includes("cat > '/w/.services/web.sh'")));
  assert.ok(state.calls.some(({ command }) => command.includes("SF_H='/w/.tools/bin/sf-secrets'")));
  assert.match(started.content[0].text, /and after app restarts\. Check logs or attach with: tmux -L sf-servers attach -t srv-/);
  assert.doesNotMatch(status.content[0].text, /Browser edition/);
  assert.match(built.tools[0].description, /it comes back after the app restarts/);
  // tmux provisioning is per environment now (a new environment checks again), commands unchanged.
  const other = recordingEnv({ cwd: '/w', shell: null });
  await servers.killSessionIn(other.env, context(), 'srv-x', 5, { workspace: '/w', graceMs: 0 });
  await servers.killSessionIn(other.env, context(), 'srv-y', 5, { workspace: '/w', graceMs: 0 });
  assert.equal(other.state.calls.filter(({ command }) => command.includes('apt-get install')).length, 1);
  assert.ok(other.state.calls.every(({ env }) => env === undefined));
});

test('browser JavaScript environment: core-servers refuses clearly (needs Bash) and runs no command', { skip, timeout: 60000 }, async (t) => {
  const { env, state } = recordingEnv({ shell: JS_SHELL });
  const { harness, call } = await fixture(t, { hostInfo: BROWSER, env });
  const outcome = async (args) => { try { return (await call(args)).content[0].text; } catch (error) { return error.message; } };
  const started = await outcome({ action: 'start', name: 'web', command: 'serve', health: 8080 });
  const status = await outcome({ action: 'status' });
  for (const text of [started, status]) assert.match(text, /need Bash.*not Linux.*Settings → Providers → Execution environment/);
  assert.equal(state.calls.length, 0, 'no command reached the JavaScript environment');
  assert.equal(state.launches.length, 0);
});

test('browser without tmux: never installs, fails clearly ("this Linux image lacks tmux")', { skip, timeout: 60000 }, async (t) => {
  const { env, state } = recordingEnv({ tmux: false });
  const { harness, call } = await fixture(t, { hostInfo: BROWSER, env });
  const started = await call({ action: 'start', name: 'web', command: 'serve', health: 8080 });
  const receipt = await harness.waitForTask(started.details.taskId, context());
  assert.equal(receipt.state.outcome.status, 'failed');
  assert.match(receipt.state.outcome.error.message, /this Linux image lacks tmux\. The browser edition does not install packages for servers/);
  assert.match((await call({ action: 'status', name: 'web' })).content[0].text, /^web: failed[\s\S]*lacks tmux/);
  assert.equal(state.launches.length, 0);
  assert.ok(state.calls.every(({ command, env: options }) => !/apt-get|apk add/.test(command) && options?.PI_EXEC_KIND === undefined));
});

test('browser lifetime: after a reload the server is started again in the new VM; status never reports the old process as running', { skip, timeout: 60000 }, async (t) => {
  const storage = ReopenableStorage.create();
  const savedVm = globalThis.__sfServersPageVm;
  t.after(() => { globalThis.__sfServersPageVm = savedVm; });
  globalThis.__sfServersPageVm = 'vm-page-1';
  const first = recordingEnv();
  const page1 = await fixture(t, { hostInfo: BROWSER, env: first.env, storage });
  const started = await page1.call({ action: 'start', name: 'web', command: 'serve', health: 8080 });
  const id = started.details.taskId;
  await healthyTask(page1.harness, id);
  assert.match((await page1.call({ action: 'status', name: 'web' })).content[0].text, /^web: running/);
  await page1.close();
  // Reload: a new page (new VM id), a fresh VM without the tmux session; the tasks are not resumed yet.
  globalThis.__sfServersPageVm = 'vm-page-2';
  const second = recordingEnv();
  const page2 = await fixture(t, { hostInfo: BROWSER, env: second.env, storage, resume: false });
  const before = (await page2.call({ action: 'status', name: 'web' })).content[0].text;
  assert.doesNotMatch(before, /^web: running/);
  assert.match(before, /^web: restarting \(the browser tab was closed or reloaded, which stopped the previous process\)/);
  page2.harness.resume();
  await until(() => second.state.launches.length === 1, 'the server was not started again after the reload');
  await until(async () => { const c = (await page2.harness.getTask(id, context())).state.checkpoint; return c?.healthyAt !== undefined && c.vm === 'vm-page-2'; }, 'not healthy in the new VM');
  const record = await page2.harness.getTask(id, context());
  assert.equal(record.state.checkpoint.failures, 0, 'a reload is not counted as a failure');
  assert.match((await page2.call({ action: 'status', name: 'web' })).content[0].text, /^web: running/);
  assert.ok(second.state.calls.every(({ env }) => env?.PI_EXEC_KIND === undefined));
});

test('browser: switching the conversation to JavaScript pauses supervision (waits, no failure, no restart); switching back resumes it', { skip, timeout: 60000 }, async (t) => {
  // A switch (Settings → Providers) reopens the session in the SAME page: same VM, new environment.
  const storage = ReopenableStorage.create();
  const savedVm = globalThis.__sfServersPageVm;
  t.after(() => { globalThis.__sfServersPageVm = savedVm; });
  globalThis.__sfServersPageVm = 'vm-same-page';
  const linux = recordingEnv();
  const p1 = await fixture(t, { hostInfo: BROWSER, env: linux.env, storage });
  const started = await p1.call({ action: 'start', name: 'web', command: 'serve', health: 8080 });
  const id = started.details.taskId;
  await healthyTask(p1.harness, id);
  await p1.close();
  // Reopened with the JavaScript environment: supervision waits, it neither fails nor restarts.
  const js = recordingEnv({ shell: JS_SHELL });
  const p2 = await fixture(t, { hostInfo: BROWSER, env: js.env, storage });
  await until(async () => /Waiting for Linux/.test((await p2.harness.getTask(id, context())).state.checkpoint?.lastError ?? ''), 'supervision did not wait for Linux');
  const waiting = await p2.harness.getTask(id, context());
  assert.equal(waiting.state.status, 'running');
  assert.equal(waiting.state.checkpoint.failures ?? 0, 0, 'waiting is not a failure');
  assert.equal(js.state.calls.length, 0, 'no command reached the JavaScript environment');
  await p2.close();
  // Reopened with Linux again (same VM): the process kept running; supervision continues, no restart.
  const callsBefore = linux.state.calls.length;
  const p3 = await fixture(t, { hostInfo: BROWSER, env: linux.env, storage });
  await until(() => linux.state.calls.length > callsBefore + 1, 'supervision did not resume on Linux');
  const resumed = await p3.harness.getTask(id, context());
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.state.checkpoint.failures ?? 0, 0);
  assert.equal(linux.state.launches.length, 1, 'not restarted: the process kept running in the VM');
  assert.equal(linux.state.kills.length, 0);
});

test('browser: a check the busy VM could not run is postponed, not counted as a failure', { skip, timeout: 60000 }, async (t) => {
  const { env, state } = recordingEnv();
  const { harness, call } = await fixture(t, { hostInfo: BROWSER, env });
  const started = await call({ action: 'start', name: 'web', command: 'serve', health: 8080 });
  await healthyTask(harness, started.details.taskId);
  const exec = env.exec;
  let busy = 3;
  env.exec = async (command, options, ctx) => command.startsWith('curl ') && busy-- > 0
    ? { ok: false, error: Object.assign(new Error('Command did not finish'), { code: 'timeout' }) }
    : exec(command, options, ctx);
  await until(async () => /Check postponed/.test((await harness.getTask(started.details.taskId, context())).state.checkpoint?.lastError ?? ''), 'no postponed check');
  await until(() => busy < 0, 'checks did not continue');
  await healthyTask(harness, started.details.taskId);
  assert.equal(state.launches.length, 1, 'the server was not restarted');
  assert.equal(state.kills.length, 0);
});

test('secrets: unsupported in the browser with a clear message (stub, status); servers without secrets work', { skip, timeout: 60000 }, async (t) => {
  const message = 'secrets unavailable: service secrets are not supported in the browser edition (no secret broker); run this server without secrets';
  // The stub, run by a real POSIX shell.
  const dir = await mkdtemp(join(tmpdir(), 'sf-browser-secrets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'web.secrets');
  const result = spawnSync('sh', ['-c', `${servers.BROWSER_SECRETS_SCRIPT}`, 'sf-secrets', '--exports'], { env: { PATH: process.env.PATH, SF_SECRETS_STATE: stateFile }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', 'nothing to eval');
  assert.equal(result.stderr, `sf-secrets: ${message}\n`);
  assert.equal(await readFile(stateFile, 'utf8'), `${message}\n`);
  // The launcher writes and uses the stub; status shows the reason left by it.
  const launcher = servers.launcherScript({ name: 'web', workspace: '/workspace', cwd: '/workspace', command: 'serve' }, 'srv-1', { browser: true });
  assert.match(launcher, /SF_SECRETS_STATE='\/var\/lib\/sf-servers\/logs\/web\.secrets'; export SF_SECRETS_STATE/);
  assert.doesNotMatch(launcher, /SF_SECRETS_URL|SF_SECRETS_TOKEN|--wait/);
  const install = servers.helperInstallScript('/workspace', { browser: true });
  assert.match(install, /SF_H='\/var\/lib\/sf-servers\/bin\/sf-secrets'/);
  assert.ok(install.includes(servers.BROWSER_SECRETS_SCRIPT));
  const { env } = recordingEnv({ secretsLine: message });
  const { harness, call } = await fixture(t, { hostInfo: BROWSER, env });
  const started = await call({ action: 'start', name: 'web', command: 'eval "$(sf-secrets --exports)"; serve', health: 8080 });
  await healthyTask(harness, started.details.taskId);
  const status = await call({ action: 'status', name: 'web' });
  assert.match(status.content[0].text, /^web: running[\s\S]*secrets unavailable: service secrets are not supported in the browser edition/);
  assert.equal(status.details.web.secrets, message);
});

test('gate: core-servers is available in the browser exactly when it reports linuxShell; servers@1 reports the tab lifetime', { skip, timeout: 120000 }, async () => {
  const definition = (hostInfo) => core.createCoreAgentPlugins({ hostInfo }).find((item) => item.id === 'core-servers');
  const withLinux = definition(BROWSER);
  assert.ok(withLinux, 'not omitted in the browser');
  assert.equal(withLinux.unavailable, undefined);
  assert.deepEqual(withLinux.provides.map((entry) => entry.id).sort(), ['servers', 'servers.engine']);
  const noLinux = definition(BROWSER_NO_LINUX);
  assert.match(noLinux.unavailable, /in-page Linux \(linuxShell\)/);
  assert.deepEqual(noLinux.provides, []);
  assert.equal(definition(ANDROID).unavailable, undefined);
  // Session side: the browser session's binding enables the row only with linuxShell.
  const builders = { workspaceTools: () => [] };
  const binding = { part: () => ({ tools: [], tasks: [] }) };
  const ids = (host) => core.coreAgentContributions({ host, builders }).map((entry) => entry.pluginId);
  assert.ok(ids({ workspace: {}, env: {}, servers: binding, hostInfo: BROWSER }).includes('core-servers'));
  assert.ok(!ids({ workspace: {}, env: {}, servers: binding, hostInfo: BROWSER_NO_LINUX }).includes('core-servers'));
  assert.ok(!ids({ workspace: {}, env: {}, hostInfo: BROWSER }).includes('core-servers'));
  // servers@1 of the browser composition: persistent false, lifetime "tab"; Android unchanged.
  const runtimeModule = await app.load('plugin-runtime.js');
  const piModule = await app.load('plugin-pi.js');
  for (const [hostInfo, expected] of [[BROWSER, { persistent: false, lifetime: 'tab' }], [ANDROID, { persistent: true }]]) {
    const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
    for (const item of core.createCoreAgentPlugins({ hostInfo })) runtime.register(item);
    await runtime.start();
    const bound = service.createServerSession({ build: () => ({ tools: [], tasks: [], manage: async () => ({ content: [{ type: 'text', text: 'ok' }] }), validate: (args) => args }) });
    bound.connect({ harness: {}, env: {}, rootConversationId: 'root', context: {} });
    try {
      const { content, ...rest } = await runtime.service('servers', 1).status();
      assert.deepEqual(rest, expected);
    } finally { bound.close(); await runtime.close(); }
  }
  // Real sessions (session.js): the browser with linuxShell offers manage_server, without it not.
  const deps = { pd, ai, chord, session };
  assert.ok((await toolsFor(deps, 'browser')).tools.some((tool) => tool.startsWith('manage_server#')));
  assert.ok(!(await toolsFor(deps, 'browserNoLinux')).tools.some((tool) => tool.startsWith('manage_server#')));
});

// ---------------------------------------------------------------------------------------------
// Part 2: the real VM, by default the repository image apps/browser/vendor/v86 (override:
// PI_V86_VENDOR=<dir with libv86.mjs, v86.wasm, *.bin, image/>). The image must contain tmux,
// bash, curl and procps; the cancellation step needs the core-execution guest dispatcher
// (cancel without a VM reset). Skipped when the image is missing or PI_V86_SKIP=1.
const vendor = process.env.PI_V86_VENDOR || fileURLToPath(new URL('../apps/browser/vendor/v86', import.meta.url));
const vendorSkip = heavy || skip || (process.env.PI_V86_SKIP === '1' ? 'PI_V86_SKIP=1' : !existsSync(join(vendor, 'image/alpine-state.bin.gz')) ? `no v86 image in ${vendor}` : false);

test('real v86: a BusyBox nc HTTP server with a health port runs, survives an unrelated cancelled command, stop kills its processes', { skip: vendorSkip, timeout: 270000 }, async (t) => {
  // Served layout: builtin/exec-linux/web/browser/browser-assets.js resolves ../../../../vendor/v86.
  await mkdir(join(app.dir, 'vendor'), { recursive: true });
  await symlink(vendor, join(app.dir, 'vendor/v86'), 'dir'); // assembled copy resolves vendor/ next to the app files
  const { Vfs, MemoryBackend } = await app.load('builtin/core-execution/web/browser/browser-vfs.js');
  const { createBrowserExecution } = await app.load('builtin/core-execution/web/browser/browser-execution.js');
  const { createLinuxShell } = await app.load('builtin/exec-linux/web/browser/linux-shell.js');
  const { openNativeExecutionEnv } = await app.load('builtin/core-execution/web/execution-env.js');
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const listeners = new Set();
  const backend = createBrowserExecution({ vfs, shells: { bash: createLinuxShell({ vfs, network: null }) }, emit: (event) => { for (const listener of listeners) listener(event); } });
  t.after(() => backend.dispose());
  const bridge = {
    call: async (method, params) => backend.methods[method](params),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const env = await openNativeExecutionEnv(bridge, '/workspace', { owner: 'servers-test', shell: 'bash' });
  assert.deepEqual(env.shell, LINUX_SHELL);
  if (process.env.PI_V86_TRACE) { const exec = env.exec.bind(env); env.exec = (command, options, ctx) => { console.error(`[exec ${new Date().toISOString()}] ${JSON.stringify(options?.env)} ${String(command).slice(0, 60).replace(/\n/g, ' ')}`); return exec(command, options, ctx); }; }
  const step = (text) => { if (process.env.PI_V86_TRACE) console.error(`[servers-test ${new Date().toISOString()}] ${text}`); };
  const linux = async (command, { timeout = 60, signal } = {}) => {
    step(`linux: ${command.slice(0, 70)}`);
    let out = '';
    const ctx = signal ? { ...context(), abortSignal: signal } : context();
    const result = await env.exec(command, { timeout, onOutput: (text) => { out += text; } }, ctx);
    return { code: result.ok ? result.value.exitCode : -1, out, error: result.ok ? undefined : result.error };
  };
  const boot = await linux('cat /proc/sys/kernel/random/boot_id; command -v tmux bash curl nc', { timeout: 200 });
  assert.equal(boot.code, 0, boot.out);
  t.diagnostic(boot.out.trim());
  const timing = { intervalMs: 2000, backoffMs: [2000], maxFailures: 3, defaultGraceMs: 2000, stopGraceMs: 1500, stopPollMs: 200, execTimeoutSec: 60 };
  let harness;
  const built = servers.createServers({ rootConversationId: pd.ROOT_CONVERSATION_ID, hostInfo: BROWSER, abortTask: (id, ctx) => harness.abortTask(id, ctx), timing });
  const registry = pd.createRegistry();
  registry.install(built.extension);
  harness = await pd.Harness.open(new pd.MemoryStorage(), { models: ai.createModels(), registry, env: () => env }, context());
  t.after(() => harness.close(context()));
  const root = await harness.root(context(), { agent: { cwd: env.cwd } });
  const api = { env, agent: (ctx) => root.agent(ctx), snapshot: (doc, ctx) => harness.snapshot(doc, ctx), getTask: (id, ctx) => harness.getTask(id, ctx),
    waitForTask: (id, ctx) => harness.waitForTask(id, ctx), commit: (fn, ctx) => harness.commit(fn, ctx) };
  const call = (args) => built.manage(args, api, context());
  harness.resume();
  // The image's BusyBox has no httpd: a persistent BusyBox nc server answering HTTP/1.0 (reads the request first).
  // Not `exec nc`: BusyBox nc ended silently when it was itself the pane's session leader (observed in this image).
  vfs.write('/workspace/site/respond.sh', new TextEncoder().encode([
    'CR=$(printf "\\r")',
    'while IFS= read -r line; do if [ "$line" = "$CR" ] || [ -z "$line" ]; then break; fi; done',
    'printf "HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nserved-from-guest\\n"',
    ''
  ].join('\n')));
  const started = await call({ action: 'start', name: 'site', command: 'nc -lk -p 8099 -e sh /workspace/site/respond.sh < /dev/null; echo "nc exited: $?"', cwd: 'site', health: 8099, startGraceSeconds: 2 });
  const id = started.details.taskId;
  step(`started task ${id}`);
  await until(async () => (await harness.getTask(id, context())).state.checkpoint?.healthyAt !== undefined, 'server not healthy in the VM', 150000)
    .catch(async (error) => { const logs = await call({ action: 'logs', name: 'site', lines: 30 }).catch((e) => ({ content: [{ text: String(e) }] })); throw new Error(`${error.message}\n${(await call({ action: 'status', name: 'site' })).content[0].text}\n${logs.content[0].text}`); });
  const status = await call({ action: 'status', name: 'site' });
  t.diagnostic(status.content[0].text);
  assert.match(status.content[0].text, /^site: running/);
  const fetched = await linux('curl -fsS http://127.0.0.1:8099/');
  assert.equal(fetched.code, 0, fetched.out);
  assert.match(fetched.out, /served-from-guest/);
  // Live /workspace: the running server reads the page's edit of its script (no copy step).
  const script = new TextDecoder().decode(await vfs.read('/workspace/site/respond.sh'));
  vfs.write('/workspace/site/respond.sh', new TextEncoder().encode(script.replace('served-from-guest', 'served-after-page-edit')));
  const edited = await linux('curl -fsS http://127.0.0.1:8099/');
  assert.match(edited.out, /served-after-page-edit/, 'the server sees the page edit live');
  const pids = async () => (await linux("ps -eo pid,args | grep '[n]c -lk -p 8099' | awk '{print $1}'")).out.trim().split(/\s+/).filter(Boolean);
  const before = await pids();
  assert.ok(before.length >= 1, 'the server runs in the VM');
  // An unrelated command, cancelled: only that command ends; the server and the VM stay.
  const controller = new AbortController();
  const slow = linux('sleep 40; echo never', { signal: controller.signal, timeout: 120 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  controller.abort();
  const cancelled = await slow;
  assert.notEqual(cancelled.code, 0, 'the command was cancelled');
  const afterCancel = await linux('cat /proc/sys/kernel/random/boot_id; tmux -L sf-servers has-session -t =srv-' + id + ' && echo session-alive; curl -fsS -o /dev/null http://127.0.0.1:8099/ && echo health-ok');
  t.diagnostic(afterCancel.out.trim());
  assert.match(afterCancel.out, /session-alive/);
  assert.match(afterCancel.out, /health-ok/);
  assert.ok((await pids()).includes(before[0]), 'same server process after the cancellation');
  // Logs come from the guest-only state directory.
  const logs = await call({ action: 'logs', name: 'site', lines: 20 });
  assert.match(logs.content[0].text, /starting site/);
  assert.match(logs.content[0].text, /secrets: not supported in the browser edition/);
  // Stop: verified; no process of the server is left and the port is closed.
  const stopped = await call({ action: 'stop', name: 'site' });
  assert.match(stopped.content[0].text, /^Stopped site/);
  assert.deepEqual(await pids(), []);
  const closed = await linux('curl -sS -m 3 -o /dev/null http://127.0.0.1:8099/ && echo still-open || echo port-closed');
  assert.match(closed.out, /port-closed/);
  assert.equal((await linux(`tmux -L sf-servers has-session -t =srv-${id} 2>/dev/null && echo alive || echo gone`)).out.trim(), 'gone');
});
