// E1: switching the execution@1 provider reopens the page session in place (no page reload).
// core-agent decides (executionSwitch); agent-sessions.js reopens (tests/plugin-c1-sessions.test.mjs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';

const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, coreAgent, runtimeModule;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  coreAgent = await app.load('builtin/core-agent/web/index.js');
  runtimeModule = await app.load('plugin-runtime.js');
});
after(async () => { await app?.remove(); });

test('executionSwitch: asks once per mismatch; same shell, no open yet, or a provider without a shell (Android) never asks', { skip }, async () => {
  let service = { shell: 'bash' };
  const asked = [];
  const sw = coreAgent.executionSwitch({ execution: () => service, reopen: (reason) => { asked.push(reason); return Promise.resolve(true); } });
  assert.equal(sw.check(), false, 'nothing opened yet');
  sw.opened({ shell: { id: 'bash' } });
  assert.equal(sw.check(), false, 'same shell');
  service = { shell: 'javascript' };
  assert.equal(sw.check(), true);
  assert.deepEqual(asked, ['execution']);
  sw.opened({ shell: { id: 'javascript' } });   // the reopened session got the new environment
  assert.equal(sw.check(), false);
  // Android: core-execution's execution@1 has no shell; envs have none either.
  const android = coreAgent.executionSwitch({ execution: () => ({ open() {} }), reopen: () => assert.fail('never') });
  android.opened({ cwd: '/data' });
  assert.equal(android.check(), false);
  // A throwing lookup (stopped scope) or reopen is contained.
  const broken = coreAgent.executionSwitch({ execution: () => { throw new Error('closed'); }, reopen: () => assert.fail('never') });
  broken.opened({ shell: { id: 'bash' } });
  assert.equal(broken.check(), false);
});

test('core-agent wiring: a provider switch in the runtime selection asks the lifecycle for ONE reopen; switching back asks none', { skip }, async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/core-agent/plugin.json', import.meta.url), 'utf8'));
  const saved = new Map();
  const runtime = runtimeModule.createPluginRuntime({ storage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) } });
  const reopens = [];
  let opener;
  const lifecycle = {
    sessionOptions: { bridge: { call: async () => ({}), subscribe: () => () => {} }, hostInfo: { capabilities: { executionEnv: true } } },
    begin(open) { opener = open; return true; },
    reopenWhenIdle(reason) { reopens.push(reason); return Promise.resolve(true); }
  };
  const envOpens = [];
  const provider = (id, shell, isDefault = false) => ({ id, version: '1.0.0', provides: [{ id: 'execution', version: 1, ...isDefault ? { default: true } : {} }],
    setup(ctx) { ctx.provide('execution', 1, Object.freeze({ shell, open: async () => { envOpens.push(shell); return { shell: { id: shell, language: shell, name: shell } }; } })); } });
  runtime.register(provider('exec-linux', 'bash', true));
  runtime.register(provider('exec-js', 'javascript'));
  runtime.register({ ...manifest, ...coreAgent.create({ sessions: {}, lifecycle, subscribe: (listener) => runtime.subscribe(listener) }) });
  await runtime.start();
  assert.equal(typeof opener, 'function', 'core-agent began the lifecycle with its opener');
  // The session opens with the selected (default) Linux environment; the opener reports it
  // before openAppSession (which this fake bridge cannot complete; its outcome is irrelevant).
  void opener({ wanted: () => false }).catch(() => {});
  const until = async (done, ms = 15000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 10)); };
  await until(() => envOpens.length > 0);  // the opener imports the session engine first
  assert.deepEqual(envOpens, ['bash'], 'the session opened the selected (default) Linux environment');
  assert.deepEqual(reopens, [], 'no reopen while the selection matches');
  runtime.selection.choose('execution', 1, 'exec-js');
  await until(() => reopens.length > 0, 2000);
  assert.deepEqual(reopens, ['execution'], 'switching to JavaScript asked for one reopen');
  // Back to the provider the open session already has: no reopen request.
  reopens.length = 0;
  runtime.selection.choose('execution', 1, 'exec-linux');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reopens, []);
  await runtime.close();
});
