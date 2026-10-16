import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { SECTIONS, captureSection, loadDeps } from './plugin-p0-capture.mjs';

// Step P2 of docs/plugins-providers-agent-core.md: the P0 provider snapshot stays
// identical when the sessions take their rows from the page adapter agent-providers.js:
// connected to a runtime with the core-providers-* built-ins (the same row objects, and
// distinct runtime copies), unavailable, and with runtime copies that fail (setup fails,
// plugin stopped, create(host) throws, create(host) returns an unusable instance), which
// hand over to the bundled rows. The adapter-absent case is plugin-p0-providers.test.mjs.
// Real session.js with the bundled pi-ai/pi-durable library, mocked hosts, dummy tokens.
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const SNAPSHOT = JSON.parse(await readFile(new URL('./plugin-p0-providers.snapshot.json', import.meta.url), 'utf8'));
let app, deps, runtimeModule, providersModule, builtinsModule, coreProviders;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = await loadDeps(app);
  runtimeModule = await app.load('plugin-runtime.js');
  providersModule = await app.load('agent-providers.js');
  builtinsModule = await app.load('plugin-builtins.js');
  coreProviders = await app.load('core-providers.js');
});
after(async () => { await app?.remove(); });

const IDS = ['core-providers-offline', 'core-providers-claude', 'core-providers-chatgpt', 'core-providers-openai'];

/** A page runtime with the four built-ins; rowOf(row) may replace each loaded row. */
async function page({ rowOf, load, connect = true } = {}) {
  const runtime = runtimeModule.createPluginRuntime();
  const rows = coreProviders.CORE_PROVIDER_ROWS.map((entry) => ({
    ...entry,
    load: load ?? (async () => ({ providerRow: rowOf ? rowOf((await entry.load()).providerRow) : (await entry.load()).providerRow }))
  }));
  for (const definition of builtinsModule.createCoreProviderPlugins({ rows })) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const adapter = providersModule.createAgentProviders({ onError: (error, details) => errors.push([details.phase, details.id, error.message]) });
  if (connect) adapter.connect(runtime);
  return { runtime, adapter, errors };
}
/** The whole P0 capture with every session attached to the adapter. */
async function assertP0(adapter, label) {
  const wrapped = { ...deps, session: { ...deps.session, openAppSession: (options) => deps.session.openAppSession({ ...options, agentProviders: adapter }) } };
  for (const section of SECTIONS) {
    const now = await captureSection(wrapped, section);
    assert.deepEqual(Object.keys(now), Object.keys(SNAPSHOT[section]), `${label}: ${section} keys`);
    for (const key of Object.keys(SNAPSHOT[section])) assert.deepEqual(now[key], SNAPSHOT[section][key], `${label}: ${section}/${key}`);
  }
  assert.equal(adapter.list().sessions, 0, `${label}: every session detached on close`);
}
const sources = (adapter) => Object.fromEntries(adapter.list().accepted.map((item) => [item.pluginId, item.source]));
const fallbacks = (adapter) => Object.fromEntries(adapter.list().fallbacks.map((item) => [item.pluginId, item.reason]));

test('P0 unchanged: adapter connected to the core-providers-* built-ins (the bundled row objects)', { skip, timeout: 300000 }, async () => {
  const { runtime, adapter, errors } = await page();
  assert.deepEqual(runtime.list().map((record) => [record.id, record.state, record.essential]), IDS.map((id) => [id, 'active', true]));
  await assertP0(adapter, 'connected');
  assert.deepEqual(sources(adapter), Object.fromEntries(IDS.map((id) => [id, 'runtime'])));
  assert.deepEqual(adapter.list().fallbacks, []);
  assert.deepEqual(errors, []);
  await runtime.close();
});

test('P0 unchanged: distinct runtime copies of the rows are really used', { skip, timeout: 300000 }, async () => {
  const created = new Set();
  const { runtime, adapter, errors } = await page({ rowOf: (row) => Object.freeze({ ...row, create(host) { created.add(row.mode); return row.create(host); } }) });
  await assertP0(adapter, 'runtime copies');
  assert.deepEqual([...created].sort(), ['chatgpt', 'claude', 'offline', 'openai'], 'every session built the runtime copies');
  assert.deepEqual(sources(adapter), Object.fromEntries(IDS.map((id) => [id, 'runtime'])));
  assert.deepEqual(errors, []);
  // Settings → Plugins: each runtime contribution is diagnosed installed.
  const diagnostic = runtime.list().find((record) => record.id === 'core-providers-claude').contributions;
  assert.deepEqual(diagnostic, [{ kind: 'agent.providers', key: 'claude', order: 10, state: 'installed', mode: 'claude', providerIds: ['anthropic'] }, { kind: 'settings.sections', key: 'provider-claude', order: 10 }], 'S1a: plus its Settings panel');
  await runtime.close();
});

test('P0 unchanged: composition unavailable (bundled rows only)', { skip, timeout: 300000 }, async () => {
  const adapter = providersModule.createAgentProviders();
  adapter.unavailable(new Error('composition failed'));
  await assertP0(adapter, 'unavailable');
  assert.deepEqual(sources(adapter), Object.fromEntries(IDS.map((id) => [id, 'bundled'])));
});

test('P0 unchanged: setup fails → every session uses the bundled rows; reported "(using built-in copy)"', { skip, timeout: 300000 }, async () => {
  const { runtime, adapter, errors } = await page({ load: async () => { throw new Error('row module unavailable'); } });
  assert.ok(runtime.list().every((record) => record.state === 'failed'));
  await assertP0(adapter, 'setup failed');
  assert.deepEqual(sources(adapter), Object.fromEntries(IDS.map((id) => [id, 'bundled'])));
  assert.deepEqual(fallbacks(adapter), Object.fromEntries(IDS.map((id) => [id, 'row module unavailable'])));
  assert.deepEqual(errors.filter(([phase]) => phase === 'fallback').map(([, id, text]) => [id, text]).sort(), IDS.map((id) => [id, 'row module unavailable (using built-in copy)']).sort(), 'each reported once');
  await runtime.close();
});

test('P0 unchanged: plugins stopped unexpectedly → bundled rows', { skip, timeout: 300000 }, async () => {
  const { runtime, adapter } = await page();
  for (const id of IDS) await runtime.stop(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assertP0(adapter, 'stopped');
  assert.deepEqual(fallbacks(adapter), Object.fromEntries(IDS.map((id) => [id, 'Stopped unexpectedly'])));
  await runtime.close();
});

test('P0 unchanged: create(host) throws → the bundled copy is built instead, for every session', { skip, timeout: 300000 }, async () => {
  const { runtime, adapter, errors } = await page({ rowOf: (row) => Object.freeze({ ...row, create() { throw new Error(`${row.mode} create exploded`); } }) });
  await assertP0(adapter, 'create throws');
  assert.deepEqual(fallbacks(adapter), Object.fromEntries(IDS.map((id) => [id, `${id.slice('core-providers-'.length)} create exploded`])));
  assert.deepEqual(errors.filter(([phase]) => phase === 'create').map(([, id, text]) => [id, text]).sort(),
    IDS.map((id) => [id, `${id.slice('core-providers-'.length)} create exploded (using built-in copy)`]).sort(), 'reported once each');
  // Diagnosed failed (fallback) on the runtime contribution.
  const entry = runtime.list().find((record) => record.id === 'core-providers-openai').contributions[0];
  assert.deepEqual([entry.state, entry.reason, entry.fallback], ['failed', 'openai create exploded (using built-in copy)', true]);
  await runtime.close();
});

test('P0 unchanged: create(host) returns an unusable instance → bundled copy', { skip, timeout: 300000 }, async () => {
  const { runtime, adapter } = await page({ rowOf: (row) => Object.freeze({ ...row, create: () => ({ streams: {} }) }) });
  await assertP0(adapter, 'unusable instance');
  assert.deepEqual(Object.keys(fallbacks(adapter)).sort(), [...IDS].sort());
  assert.match(fallbacks(adapter)['core-providers-claude'], /create\(\) needs streams \{stream, streamSimple\} or a complete provider/);
  await runtime.close();
});
