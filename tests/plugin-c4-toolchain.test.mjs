import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// Step C4: the core-toolchain built-in. Real plugin-runtime.js / plugin-builtins.js and the
// plugin's own module with a fake agent.harness@1 provider and a fake exec environment.
// No library, network or device. Not on-device verification.
let app, runtimeModule, builtins, plugin;
before(async () => {
  app = await assembleApp({ withLibrary: false });
  runtimeModule = await app.load('plugin-runtime.js');
  builtins = await app.load('plugin-builtins.js');
  plugin = await app.load('builtin/core-toolchain/web/index.js');
});
after(async () => { await app?.remove(); delete globalThis.__piHostInfo; });

// A harness facade like core-agent's: current() + onSession(listener), listeners persist.
function fakeHarness() {
  const listeners = new Set();
  let handle = null;
  return {
    facade: { current: () => handle, onSession(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    open(next) { handle = next; for (const listener of listeners) listener(next); },
    close() { handle = null; for (const listener of listeners) listener(null); }
  };
}
const fakeEnv = ({ backgroundExecution = true, statusCode = 1 } = {}) => {
  const commands = [];
  return {
    commands, backgroundExecution, cwd: '/ws',
    async exec(command, options, context) {
      commands.push({ command, options, context });
      return { ok: true, value: { exitCode: command.startsWith('pi-android status') ? statusCode : 0 } };
    }
  };
};
const handleOf = (env) => ({ env, context: { name: 'background' }, workspace: {}, rootConversationId: 'main' });

async function compose({ harness, toolchain = true } = {}) {
  const runtime = runtimeModule.createPluginRuntime({ onError: (error) => { throw error; } });
  const definitions = builtins.createBuiltinPlugins({ openExecution: () => ({}), sessions: undefined, harness: undefined, toolchain });
  for (const definition of definitions) if (definition.id === 'core-toolchain') runtime.register(definition);
  if (harness) runtime.register({ id: 'fake-agent', version: '1.0.0', provides: [{ id: 'agent.harness', version: 1 }], setup: (ctx) => ctx.provide('agent.harness', 1, harness.facade) });
  await runtime.start();
  return runtime;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const installs = (env) => env.commands.filter((entry) => entry.command.includes('pi-android install'));

test('manifest: self-forming-tools bundle, not essential, provides toolchain@1, uses agent.harness@1', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/core-toolchain/plugin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.bundle, 'self-forming-tools');
  assert.notEqual(manifest.essential, true);
  assert.deepEqual(manifest.provides, [{ id: 'toolchain', version: 1 }]);
  assert.deepEqual(manifest.uses, [{ id: 'agent.harness', version: 1 }]);
});

test('native session: ensure runs once per start (flock guarded detached install), again after a restart', async () => {
  delete globalThis.__piHostInfo;
  const harness = fakeHarness();
  const runtime = await compose({ harness });
  const service = runtime.service('toolchain', 1);
  assert.deepEqual(Object.keys(service).sort(), ['ensure', 'installed']);
  const env = fakeEnv();
  harness.open(handleOf(env));
  await settle();
  assert.equal(installs(env).length, 1);
  const [{ command, options, context }] = installs(env);
  assert.match(command, /nohup flock -n '\/ws\/\.self-forming\/toolchain\.lock' sh -c .*pi-android install --accept-licenses && pi-android doctor/);
  assert.match(command, /toolchain\.log/);
  assert.equal(options.timeout, 30);
  assert.equal(context.name, 'background');
  await service.ensure(); await service.ensure();
  assert.equal(installs(env).length, 1, 'ensure() again in the same start does nothing');
  assert.equal(await service.installed(), false);
  harness.close();
  assert.equal(await service.installed(), undefined, 'unknown while no session is open');
  const next = fakeEnv();
  harness.open(handleOf(next)); // a new start retries
  await settle();
  assert.equal(installs(next).length, 1);
  await runtime.close?.();
});

test('a session already open when the plugin starts is ensured too', async () => {
  const harness = fakeHarness();
  const env = fakeEnv();
  harness.open(handleOf(env));
  await compose({ harness });
  await settle();
  assert.equal(installs(env).length, 1);
});

test('no background execution, or the browser platform: nothing runs and installed() is unknown', async () => {
  const harness = fakeHarness();
  const runtime = await compose({ harness });
  const service = runtime.service('toolchain', 1);
  const plain = fakeEnv({ backgroundExecution: false });
  harness.open(handleOf(plain));
  await settle(); await service.ensure();
  assert.equal(plain.commands.length, 0);
  const browserEnv = fakeEnv();
  globalThis.__piHostInfo = { platform: 'browser' };
  harness.open(handleOf(browserEnv));
  await settle(); await service.ensure();
  assert.equal(await service.installed(), undefined);
  assert.equal(browserEnv.commands.length, 0);
  delete globalThis.__piHostInfo;
});

test('browser composition leaves the plugin out; absent plugin or harness: no service / unknown', async () => {
  const bootstrap = await readFile(new URL('../apps/common/plugin-bootstrap.js', import.meta.url), 'utf8');
  assert.match(bootstrap, /if \(!browser\) options\.toolchain = true/);
  const without = await compose({ harness: fakeHarness(), toolchain: false });
  assert.equal(without.service('toolchain', 1), null);
  const alone = await compose({}); // no agent.harness provider
  assert.equal(await alone.service('toolchain', 1).installed(), undefined);
  await alone.service('toolchain', 1).ensure();
  const appSource = await readFile(new URL('../apps/common/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /runtime\?\.service\("toolchain", 1\)/);
  assert.ok(!/opened\.toolchain/.test(appSource), 'app.js no longer reads session.toolchain');
});

test('installed() reports true when pi-android status succeeds and then stops further installs', async () => {
  const harness = fakeHarness();
  const runtime = await compose({ harness });
  const service = runtime.service('toolchain', 1);
  const env = fakeEnv({ statusCode: 0 });
  harness.open(handleOf(env));
  await settle();
  assert.equal(await service.installed(), true);
  const later = fakeEnv();
  harness.open(handleOf(later));
  await settle();
  assert.equal(installs(later).length, 0, 'known ready: no install');
});
