import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { assistantModels, fakeAccount, fakeFetch, keptStorage, openSession } from './plugin-p0-support.mjs';

// Step P2 of docs/plugins-providers-agent-core.md: the page adapter agent-providers.js
// (contribution kind agent.providers) and the essential built-ins core-providers-*.
// Checks: wiring (plugin-builtins/bootstrap/app.js/session.js), names in Settings →
// Plugins, the composition rules (duplicate mode or providerId rejected, explicit
// replaces), a runtime copy swapped mid-session applies from the next request (a request
// already streaming finishes on the provider it started with), detach on close and the
// shared 5 s readiness budget. P0 identity under the adapter: plugin-p2-snapshot.test.mjs.
// Mocked hosts, dummy tokens, fake transports. Not on-device verification.
const root = new URL('..', import.meta.url).pathname;
const source = (name) => readFile(join(root, name.startsWith('plugins/') ? '' : 'apps/common', name), 'utf8');
const code = async (name) => (await source(name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const bare = await assembleApp({ withLibrary: false });
after(() => bare.remove());
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai/pi-durable) is not present';
let app, deps, runtimeModule, providersModule, extensionsModule, claudeRow, offlineRow;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    env: await app.load('library/pi-durable/env.js')
  };
  runtimeModule = await app.load('plugin-runtime.js');
  providersModule = await app.load('agent-providers.js');
  extensionsModule = await app.load('agent-extensions.js');
  ({ providerRow: claudeRow } = await app.load('builtin/core-providers-claude/web/provider.js'));
  ({ providerRow: offlineRow } = await app.load('builtin/core-providers-offline/web/provider.js'));
});
after(async () => { await app?.remove(); });

const IDS = ['core-providers-offline', 'core-providers-claude', 'core-providers-chatgpt', 'core-providers-openai'];
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const plugin = (id, setup, extra = {}) => ({ id, version: '1.0.0', provides: [], requires: [], uses: [], setup, ...extra });
// A minimal valid row for composition checks (never sent through).
const fakeRow = (mode, providerIds, extra = {}) => Object.freeze({
  mode, providerIds: Object.freeze(providerIds), label: mode, auth: 'none',
  catalog: () => [], catalogModel: () => undefined, thinkingEfforts: () => [], fastModel: () => undefined,
  create: () => ({ provider: { id: providerIds[0] } }), ...extra
});

// ---- wiring and static checks ------------------------------------------------------------
test('plugin-builtins and agent-providers load without the bundled library; four essential page built-ins', async () => {
  // Served layout without the library next to it: nothing is imported at evaluation.
  const builtins = await bare.load('plugin-builtins.js');
  const definitions = builtins.createCoreProviderPlugins({ hostInfo: { platform: 'android' } });
  assert.deepEqual(definitions.map((item) => [item.id, item.essential, item.reload, item.provides.length]), IDS.map((id) => [id, true, 'page', 0]));
  // Registered only when asked, after core-execution/core-agent and before the agent tool rows.
  assert.ok(!builtins.createBuiltinPlugins({ openExecution() {} }).some((item) => IDS.includes(item.id)));
  const all = builtins.createBuiltinPlugins({ openExecution() {}, providers: { hostInfo: {} }, agentTools: { hostInfo: {} } }).map((item) => item.id);
  assert.deepEqual(all.filter((id) => IDS.includes(id)), IDS);
  assert.ok(all.indexOf('core-providers-openai') < all.indexOf('core-prompt'));
  const adapterSource = await code('agent-providers.js');
  assert.ok(!/^\s*import\s/m.test(adapterSource), 'agent-providers.js imports nothing');
  for (const word of ['commit(', 'tx.doc', 'harness.', 'storage.', 'Storage', 'apiKey', 'console.']) assert.ok(!adapterSource.includes(word), `agent-providers.js uses ${word}`);
  // plugin-builtins: only library-free modules at evaluation; the rows load in setup.
  const imports = [...(await source('plugin-builtins.js')).matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.every((path) => !path.includes('library') && !/provider\.js/.test(path)), imports.join());
});

test('a fork leaves a provider out with omit(hostInfo); setup contributes the row under its mode', { skip }, async () => {
  const { createCoreProviderPlugins } = await app.load('plugin-builtins.js');
  const { CORE_PROVIDER_ROWS } = await app.load('core-providers.js');
  const rows = CORE_PROVIDER_ROWS.map((entry) => entry.mode === 'openai' ? { ...entry, omit: (hostInfo) => hostInfo?.platform === 'browser' } : entry);
  assert.deepEqual(createCoreProviderPlugins({ hostInfo: { platform: 'browser' }, rows }).map((item) => item.id), IDS.filter((id) => id !== 'core-providers-openai'));
  const runtime = runtimeModule.createPluginRuntime();
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  await runtime.start();
  assert.deepEqual(runtime.contributions('agent.providers').map((entry) => [entry.providerId, entry.key, entry.order, entry.value.mode]),
    [['core-providers-offline', 'offline', 0, 'offline'], ['core-providers-claude', 'claude', 10, 'claude'], ['core-providers-chatgpt', 'chatgpt', 20, 'chatgpt'], ['core-providers-openai', 'openai', 30, 'openai']]);
  assert.equal(runtime.contributions('agent.providers')[1].value, claudeRow, 'the runtime copy is the row module itself');
  await runtime.close();
});

test('wiring: bootstrap connects the adapter; app.js creates it page-owned and passes it on; session.js attaches and detaches', async () => {
  const bootstrap = await code('plugin-bootstrap.js');
  assert.match(bootstrap, /providers: \{ hostInfo \}/);
  assert.match(bootstrap, /agentProviders\?\.connect\(runtime\)/);
  const appSource = await code('app.js');
  assert.match(appSource, /^const agentProviders = createAgentProviders\(/m);
  assert.match(appSource, /startPluginComposition\(\{\s*bridge, hostInfo, agentExtensions, agentProviders,/);
  assert.match(appSource, /agentProviders\.unavailable\(cause\)/);
  // Step C3d: the page passes them through its session options to core-agent's opener.
  assert.match(appSource, /sessionOptions: \{[\s\S]*?agentExtensions, agentProviders,/);
  const opener = await source('plugins/core-agent/web/open-sessions.js');
  assert.match(opener, /openAppSession\(\{[\s\S]*?agentExtensions: options\.agentExtensions,\s*agentProviders: options\.agentProviders,/);
  const session = await code('session-engine.js');
  assert.match(session, /options\.agentProviders\?\.attach\(models, \{ builtins: coreProviderContributions\(PROVIDER_ROWS\) \}\)/);
  assert.match(session, /rows: attachedProviders \?\? PROVIDER_ROWS,/);
  assert.equal([...session.matchAll(/attachedProviders\?\.detach\(\);/g)].length, 3, 'close and both failed-open paths detach');
  assert.match(session, /Promise\.all\(\[agentExtensions\?\.ready\?\.\(\), options\.agentProviders\?\.ready\?\.\(\)\]\)/);
});

test('Settings → Plugins names the four providers; they belong to self-forming-core', async () => {
  const settings = await app.load('builtin/core-plugin-management/web/plugin-settings.js');
  const bundles = await app.load('plugin-bundles.js');
  assert.deepEqual(IDS.map((id) => settings.builtinName(id)), ['Offline demo', 'Claude', 'ChatGPT', 'OpenAI API']);
  for (const id of IDS) assert.equal(bundles.bundleOf(id)?.id, 'self-forming-core', id);
});

// ---- composition rules ---------------------------------------------------------------------
async function composed(definitions, { builtins } = {}) {
  const runtime = runtimeModule.createPluginRuntime();
  for (const definition of definitions) runtime.register(definition);
  await runtime.start();
  const errors = [];
  const adapter = providersModule.createAgentProviders({ onError: (error, details) => errors.push([details.phase, details.id, error.message]) });
  adapter.connect(runtime);
  const models = deps.ai.createModels();
  const handle = adapter.attach(models, { builtins });
  return { runtime, adapter, errors, models, handle };
}
const contribute = (key, row, order = 0) => (ctx) => { ctx.contribute('agent.providers', key, row, order); };
const builtinsOf = (...rows) => rows.map((row, index) => ({ pluginId: `core-providers-${row.mode}`, key: row.mode, order: index * 10, value: row }));

test('composition: duplicate modes and provider ids are rejected; replaces takes a mode explicitly, once', { skip }, async () => {
  const offline = fakeRow('offline', ['faux'], { requestLabel: 'Offline', waitingLabel: 'Offline', listed: false, order: 0, defaultModelId: 'faux-1' });
  const claude = fakeRow('claude', ['anthropic']);
  const { runtime, adapter, errors, handle } = await composed([
    plugin('core-providers-offline', contribute('offline', offline), { essential: true }),
    plugin('core-providers-claude', contribute('claude', claude, 10), { essential: true }),
    plugin('dup-mode', contribute('claude-copy', fakeRow('claude', ['other-id']))),
    plugin('dup-id', contribute('local-a', fakeRow('local-a', ['anthropic']))),
    plugin('local', contribute('local-b', fakeRow('local-b', ['local-b-id']))),
    plugin('local-twin', contribute('local-b-twin', fakeRow('local-b2', ['local-b-id']))),
    plugin('bad-replaces', contribute('bad', fakeRow('bad-mode', ['bad-id'], { replaces: ['claude'] }))),
    plugin('claude-alt', contribute('claude-alt', fakeRow('claude', ['anthropic'], { replaces: ['claude'] }))),
    plugin('claude-alt2', contribute('claude-alt2', fakeRow('claude', ['anthropic'], { replaces: ['claude'] }))),
    plugin('invalid', contribute('invalid', { mode: 'Bad Mode' }))
  ], { builtins: builtinsOf(offline, claude) });
  const list = adapter.list();
  assert.deepEqual(list.accepted.map((item) => [item.pluginId, item.mode, item.source, item.replaces ?? null]), [
    ['core-providers-offline', 'offline', 'runtime', null], ['claude-alt', 'claude', 'runtime', ['claude']], ['local', 'local-b', 'runtime', null]
  ], 'the replacement keeps the replaced row\'s position');
  const reasons = Object.fromEntries(list.rejected.map((item) => [item.pluginId, item.reason]));
  assert.equal(reasons['dup-mode'], 'Model provider mode claude is already provided by core plugin core-providers-claude; declare replaces: ["claude"] to replace it');
  assert.equal(reasons['dup-id'], 'Provider id anthropic is already used by model provider claude (core plugin core-providers-claude)');
  assert.equal(reasons['local-twin'], 'Provider id local-b-id is already used by model provider local-b (plugin local)');
  assert.equal(reasons['bad-replaces'], 'Model provider bad-mode: replaces may only name the mode itself (replaces: ["bad-mode"])');
  assert.equal(reasons['claude-alt2'], 'Model provider mode claude is already replaced by plugin claude-alt');
  assert.match(reasons.invalid, /Invalid model provider mode "Bad Mode"/);
  assert.equal(reasons['core-providers-claude'], undefined, 'the replaced built-in is not a rejection');
  assert.ok(!list.accepted.some((item) => item.pluginId === 'core-providers-claude'), 'nor accepted while replaced');
  assert.deepEqual(list.fallbacks, [], 'a replaced built-in is not a fallback');
  // rows() / the session handle: the same accepted rows; runtime rows get the engine defaults.
  assert.deepEqual(handle.rows().map((row) => row.mode), ['offline', 'claude', 'local-b']);
  assert.equal(handle.rows()[0], offline, 'a complete row is passed as is');
  const local = handle.rows()[2];
  assert.deepEqual([local.requestLabel, local.waitingLabel, local.listed, local.order, local.defaultModelId], ['local-b', 'local-b', true, 0, '']);
  assert.deepEqual(adapter.describe().map((item) => [item.mode, item.pluginId, item.source, Boolean(item.essential)]), [['offline', 'core-providers-offline', 'runtime', true], ['claude', 'claude-alt', 'runtime', false], ['local-b', 'local', 'runtime', false]]);
  // Diagnostics on the runtime contributions (Settings → Plugins).
  const diagnosed = (id) => runtime.list().find((record) => record.id === id).contributions?.[0];
  assert.equal(diagnosed('dup-mode').state, 'failed');
  assert.deepEqual(diagnosed('claude-alt'), { kind: 'agent.providers', key: 'claude-alt', order: 0, state: 'installed', mode: 'claude', providerIds: ['anthropic'], replaces: ['claude'] });
  assert.ok(errors.some(([phase, id]) => phase === 'agent.providers' && id === 'dup-mode'), 'rejections are reported');
  // Stopping the replacement hands the mode back to the built-in.
  await runtime.stop('claude-alt');
  await settle();
  assert.deepEqual(adapter.list().accepted.find((item) => item.mode === 'claude').pluginId, 'claude-alt2', 'the next replacement in line takes over');
  await runtime.stop('claude-alt2');
  await settle();
  assert.deepEqual(adapter.list().accepted.find((item) => item.mode === 'claude').pluginId, 'core-providers-claude');
  handle.detach();
  assert.equal(adapter.list().sessions, 0);
  await runtime.close();
  // Bundled rows only (runtime closed): the built-ins stand in, plugins are gone.
  await settle();
  assert.deepEqual(adapter.list().accepted.map((item) => [item.pluginId, item.source]), [['core-providers-offline', 'bundled'], ['core-providers-claude', 'bundled']]);
});

test('a plugin provider whose create(host) fails has no bundled copy: it is rejected, the session goes on without it', { skip }, async () => {
  const offline = fakeRow('offline', ['faux']);
  const broken = fakeRow('local-x', ['local-x'], { create: () => { throw new Error('no local server'); } });
  const { runtime, adapter, errors, handle } = await composed([plugin('local-x', contribute('local-x', broken))], { builtins: builtinsOf(offline) });
  assert.throws(() => handle.instantiate(handle.rows()[1], {}), /no local server/);
  await settle();
  assert.deepEqual(adapter.list().accepted.map((item) => item.mode), ['offline']);
  assert.deepEqual(adapter.list().rejected.map((item) => [item.pluginId, item.reason]), [['local-x', 'no local server']]);
  assert.deepEqual(errors.filter(([phase]) => phase === 'create'), [['create', 'local-x', 'no local server']]);
  // A provider that claims another id than its own is refused as well.
  const thief = fakeRow('local-y', ['local-y'], { create: () => ({ provider: { id: 'anthropic' } }) });
  const second = await composed([plugin('local-y', contribute('local-y', thief))], { builtins: builtinsOf(offline) });
  assert.throws(() => second.handle.instantiate(second.handle.rows()[1], {}), /returned provider "anthropic", not one of its providerIds/);
  await runtime.close();
  await second.runtime.close();
});

// ---- sessions -------------------------------------------------------------------------------
const finished = (opened, before) => !opened.snapshot.busy && !opened.snapshot.anyBusy && opened.snapshot.messages.length > before && opened.snapshot.messages.at(-1)?.role === 'assistant' && !opened.snapshot.messages.at(-1)?.pending;
async function sendAndWait(opened, text, config) {
  const before = opened.snapshot.messages.length;
  await opened.send(text, config);
  await until(() => finished(opened, before + 1), `${text}: the reply did not finish`);
  return opened.snapshot.messages.at(-1).text;
}

test('a runtime copy swapped mid-session applies from the next request; a streaming request finishes on the old one', { skip, timeout: 120000 }, async () => {
  const log = [];
  let release;
  const arrived = new Promise((resolve) => { release = resolve; });
  // claude-alt: a replacement of the claude row that marks the requests it streams.
  const alternative = Object.freeze({ ...claudeRow, replaces: ['claude'], create(host) {
    const base = claudeRow.create(host);
    return { ...base, streams: {
      stream: (model, transcript, options) => { log.push(`alt:${model.id}`); return base.streams.stream(model, transcript, options); },
      streamSimple: (model, transcript, options) => { log.push(`alt:${model.id}`); return base.streams.streamSimple(model, transcript, options); }
    } };
  } });
  const runtime = runtimeModule.createPluginRuntime();
  const { createCoreProviderPlugins } = await app.load('plugin-builtins.js');
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  runtime.register(plugin('claude-alt', async (ctx) => { await arrived; ctx.contribute('agent.providers', 'claude-alt', alternative, 10); }));
  void runtime.start();
  await until(() => runtime.list().filter((record) => record.state === 'active').length === 4, 'built-ins active');
  const adapter = providersModule.createAgentProviders();
  adapter.connect(runtime);
  let hold;
  const transport = fakeFetch(async (_request, n) => { if (n === 2) await new Promise((resolve) => { hold = resolve; }); return undefined; });
  const storage = keptStorage(deps.pd);
  const opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch, claude: fakeAccount('claude'), agentProviders: adapter });
  const config = { mode: 'claude', modelId: '' };
  try {
    assert.equal(adapter.list().sessions, 1);
    assert.equal(await sendAndWait(opened, 'one', config), 'reply 1');
    assert.deepEqual(log, [], 'the built-in streamed the first request');
    // The second request starts on the built-in and hangs in the transport while claude-alt arrives.
    const before = opened.snapshot.messages.length;
    await opened.send('two', config);
    await until(() => typeof hold === 'function', 'second request reached the transport');
    release();
    await until(() => adapter.list().accepted.some((item) => item.pluginId === 'claude-alt'), 'replacement accepted');
    hold();
    await until(() => finished(opened, before + 1), 'second reply');
    assert.equal(opened.snapshot.messages.at(-1).text, 'reply 2');
    assert.deepEqual(log, [], 'the streaming request finished on the provider it started with');
    assert.equal(await sendAndWait(opened, 'three', config), 'reply 3');
    assert.deepEqual(log, ['alt:claude-sonnet-4-6'], 'the next request used the replacement');
    // Stopping the replacement hands back to the built-in, again from the next request.
    await runtime.stop('claude-alt');
    await settle();
    assert.equal(await sendAndWait(opened, 'four', config), 'reply 4');
    assert.deepEqual(log, ['alt:claude-sonnet-4-6']);
    assert.equal(transport.requests.length, 4);
    assert.ok(transport.requests.every((request) => request.url.startsWith('https://api.anthropic.com/')));
  } finally {
    await opened.close();
  }
  assert.equal(adapter.list().sessions, 0, 'close detaches the session');
  assert.deepEqual(await assistantModels(deps, storage), Array(4).fill('anthropic/anthropic-messages/claude-sonnet-4-6'));
  await runtime.close();
});

test('the offline demo row can be replaced mid-session too (a complete provider is set again)', { skip, timeout: 120000 }, async () => {
  const runtime = runtimeModule.createPluginRuntime();
  const { createCoreProviderPlugins } = await app.load('plugin-builtins.js');
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  let release;
  const arrived = new Promise((resolve) => { release = resolve; });
  // A demo whose scripted answer is a fixed text (the faux helpers come from host.ai).
  const quiet = Object.freeze({ ...offlineRow, replaces: ['offline'], create(host) {
    const demo = host.ai.fauxProvider({ api: 'self-forming-offline', tokensPerSecond: 0, tokenSize: { min: 4, max: 4 } });
    const step = () => { demo.appendResponses([step]); return host.ai.fauxAssistantMessage('quiet demo'); };
    demo.setResponses([step]);
    return { provider: demo.provider };
  } });
  runtime.register(plugin('quiet-demo', async (ctx) => { await arrived; ctx.contribute('agent.providers', 'quiet', quiet); }));
  void runtime.start();
  await until(() => runtime.list().filter((record) => record.state === 'active').length === 4, 'built-ins active');
  const adapter = providersModule.createAgentProviders();
  adapter.connect(runtime);
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: adapter });
  try {
    assert.match(await sendAndWait(opened, 'hello', { mode: 'offline' }), /I saved your message to demo-note\.txt/);
    release();
    await until(() => adapter.list().accepted.some((item) => item.pluginId === 'quiet-demo'), 'replacement accepted');
    assert.equal(await sendAndWait(opened, 'again', { mode: 'offline' }), 'quiet demo');
  } finally {
    await opened.close();
  }
  await runtime.close();
});

test('readiness: sends wait for agent tools and model providers side by side, within one budget', { skip, timeout: 60000 }, async () => {
  const budget = 1000;
  const calls = [];
  // Records when the session asks each adapter (both timers start then).
  const timed = (adapter, name) => ({ ...adapter, ready: () => { calls.push([name, Date.now()]); return adapter.ready(); } });
  const providersAdapter = providersModule.createAgentProviders({ timeoutMs: budget });
  const agentProviders = timed(providersAdapter, 'providers');
  const agentExtensions = timed(extensionsModule.createAgentExtensions({ timeoutMs: budget }), 'extensions');
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders, agentExtensions });
  try {
    await sendAndWait(opened, 'hello', { mode: 'offline' });
    const elapsed = Date.now() - Math.min(...calls.map(([, at]) => at));
    assert.deepEqual(calls.map(([name]) => name).sort(), ['extensions', 'providers']);
    assert.ok(Math.abs(calls[0][1] - calls[1][1]) < 50, 'asked side by side');
    assert.ok(elapsed >= budget - 50, `the send waited for the barrier (${elapsed} ms)`);
    assert.ok(elapsed < 2 * budget - 100, `one shared budget, not two in a row (${elapsed} ms)`);
    assert.equal(providersAdapter.status().late, true);
  } finally {
    await opened.close();
  }
  // Providers alone still hold sends until they are ready (or their deadline).
  const pending = providersModule.createAgentProviders({ timeoutMs: 10000 });
  const second = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: pending });
  try {
    let sent = false;
    const sending = second.send('hello', { mode: 'offline' }).then(() => { sent = true; });
    await settle(150);
    assert.equal(sent, false, 'no request before the providers are ready');
    pending.unavailable(new Error('composition failed'));
    await sending;
    assert.equal(sent, true);
    await until(() => finished(second, 1), 'reply');
  } finally {
    await second.close();
  }
});

test('session.js falls back to the bundled rows when attach throws', { skip, timeout: 60000 }, async () => {
  const broken = { attach() { throw new Error('adapter broken'); }, ready: async () => {} };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  let opened;
  try {
    opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: broken });
  } finally {
    console.error = original;
  }
  try {
    assert.match(await sendAndWait(opened, 'hello', { mode: 'offline' }), /scripted offline demo/);
    assert.ok(errors.some((line) => line.includes('adapter broken')));
  } finally {
    await opened.close();
  }
});

// ---- copy check of the files above (node --check needs .mjs copies of browser modules) ----
test('syntax: the changed modules parse as ES modules', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'plugin-p2-check-'));
  try {
    for (const name of ['agent-providers.js', 'plugin-builtins.js', 'plugin-bootstrap.js', 'app.js', 'session.js', 'session-engine.js', 'plugins/core-conversations/web/session-tail.js', 'plugins/core-conversations/web/session-threads.js', 'plugins/core-conversations/web/session-tree.js', 'session-providers.js', 'core-providers.js']) {
      const target = join(dir, name.split('/').pop().replace(/\.js$/, '.mjs'));
      await copyFile(join(root, name.startsWith('plugins/') ? '' : 'apps/common', name), target);
      const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    await writeFile(join(dir, 'done'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
