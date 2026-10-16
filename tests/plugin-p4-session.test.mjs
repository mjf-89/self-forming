import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { keptStorage, openSession } from './plugin-p0-support.mjs';
import { all, builtinModeOptions, installDom } from './plugin-p4-support.mjs';

// Step P4 of docs/plugins-providers-agent-core.md with the real session.js /
// session-providers.js / agent-providers.js / plugin-runtime.js and the bundled library:
// - session.providers() (agent.sessions@1) lists the session's rows, with the live parts of
//   a contributed row (status, models, connect, subscribe) and nothing installed by reading;
// - provider-settings.js renders a fake plugin provider from it (option, panel, Connect) and
//   a model choice is stored through setModelSettings;
// - Settings → Plugins shows "Failed: … (using built-in copy)" for a core provider whose
//   runtime copy fell back after create() failed (agent-providers list().fallbacks).
// Mocked hosts, transports and DOM only: not on-device or visual verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai/pi-durable) is not present';
let app, deps, runtimeModule, providersModule, builtinsModule, coreProviders, providerSettingsModule, pluginSettingsModule, sessionsModule;
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
  builtinsModule = await app.load('plugin-builtins.js');
  coreProviders = await app.load('core-providers.js');
  providerSettingsModule = await app.load('builtin/core-chat/web/provider-settings.js'); // core-chat since C7
  pluginSettingsModule = await app.load('builtin/core-plugin-management/web/plugin-settings.js');
  sessionsModule = await app.load('agent-sessions.js');
});
after(async () => { await app?.remove(); });

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const LLAMA_URL = 'http://127.0.0.1:8080/v1';
const llamaModel = (id, name = `Llama ${id}`) => ({ id, name, api: 'openai-responses', provider: 'llama-id', baseUrl: LLAMA_URL, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
/** A fake third-party provider row with a session part that has status/subscribe/connect. */
function llamaRow(server) {
  return Object.freeze({
    mode: 'llama-local', providerIds: Object.freeze(['llama-id']), label: 'Local llama', auth: 'none', order: 40, defaultModelId: 'llama-3',
    catalog: () => [llamaModel('llama-3')], catalogModel: (id) => id === 'llama-3' ? llamaModel(id) : undefined, thinkingEfforts: () => [], fastModel: () => undefined,
    create(host) {
      server.created++;
      const { stream, streamSimple } = host.ai.streams.openaiResponses;
      return {
        status: () => server.up ? { ready: true, message: 'Connected to 127.0.0.1:8080' } : { ready: false, message: 'The local server is not running.' },
        subscribe(listener) { server.listeners.add(listener); return () => server.listeners.delete(listener); },
        async connect() { server.connects++; server.up = true; for (const listener of [...server.listeners]) listener({ signedIn: true }); },
        credential: async () => ({ auth: { apiKey: 'local-placeholder-not-a-secret' } }),
        async models() { server.modelCalls++; if (!server.up) throw new Error('Start the local server first.'); return [llamaModel('llama-3'), llamaModel('llama-3-small', 'Llama 3 small')]; },
        savedModels: (refs) => refs.map((ref) => llamaModel(ref.modelId)),
        choose: async (config) => ({ model: llamaModel(config.modelId || 'llama-3'), list: [llamaModel('llama-3'), llamaModel('llama-3-small')] }),
        streams: { stream, streamSimple }
      };
    }
  });
}
const plugin = (id, setup) => ({ id, version: '1.0.0', provides: [], requires: [], uses: [], setup });
/** A page runtime: the four core providers (rowOf may replace a loaded row) plus optional plugin rows. */
async function page({ rowOf, extra = [] } = {}) {
  const runtime = runtimeModule.createPluginRuntime();
  const rows = coreProviders.CORE_PROVIDER_ROWS.map((entry) => ({ ...entry, load: async () => ({ providerRow: rowOf ? rowOf((await entry.load()).providerRow) : (await entry.load()).providerRow }) }));
  for (const definition of builtinsModule.createCoreProviderPlugins({ rows })) runtime.register(definition);
  for (const row of extra) runtime.register(plugin(`plugin-${row.mode}`, async (ctx) => { ctx.contribute('agent.providers', row.mode, row, row.order); }));
  await runtime.start();
  await until(() => runtime.list().every((record) => record.state === 'active'), 'plugins active');
  const errors = [];
  const adapter = providersModule.createAgentProviders({ onError: (error, details) => errors.push([details.phase, details.id, error.message]) });
  adapter.connect(runtime);
  return { runtime, adapter, errors };
}

test('session.providers(): every row of the session, read-only; a contributed row exposes its live status, models, connect and subscribe', { skip, timeout: 120000 }, async () => {
  const server = { up: false, created: 0, connects: 0, modelCalls: 0, listeners: new Set() };
  const { runtime, adapter } = await page({ extra: [llamaRow(server)] });
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: adapter });
  try {
    const rows = opened.providers();
    assert.deepEqual(rows.map((row) => [row.mode, row.label, row.auth, row.available]), [
      ['offline', 'Offline demo', 'none', true], ['claude', 'Claude Code', 'account', true], ['chatgpt', 'ChatGPT', 'account', true], ['openai', 'OpenAI API key', 'transient-key', true], ['llama-local', 'Local llama', 'none', true]
    ]);
    for (const row of rows) assert.ok(Object.isFrozen(row));
    for (const row of rows.slice(0, 4)) assert.equal(row.connect, undefined, `${row.mode}: built-ins have no connect()`);
    const llama = rows[4];
    assert.equal(server.created, 1, 'the engine built the row once; providers() reuses that instance');
    assert.deepEqual(llama.status, { ready: false, message: 'The local server is not running.' });
    assert.equal(llama.defaultModelId, 'llama-3');
    assert.deepEqual(llama.catalog().map((model) => model.id), ['llama-3']);
    assert.deepEqual(llama.thinkingEfforts('llama-3'), []);
    await assert.rejects(llama.models(), /Start the local server first\./);
    assert.equal(typeof llama.subscribe, 'function');
    await llama.connect();
    assert.equal(server.connects, 1);
    assert.deepEqual(opened.providers()[4].status, { ready: true, message: 'Connected to 127.0.0.1:8080' }, 'status is read at each call');
    assert.deepEqual((await opened.providers()[4].models()).map((model) => model.id), ['llama-3', 'llama-3-small']);
    assert.equal(server.created, 1);
    // The offline row's models are its catalog; nothing about recovery or the snapshot changed.
    assert.deepEqual((await rows[0].models()).map((model) => model.id), rows[0].catalog().map((model) => model.id));
    assert.equal(opened.snapshot.paused, false);
    assert.deepEqual(opened.snapshot.modelSettings, { mode: 'offline', modelId: 'faux-1', thinkingEffort: '' });
    // C7 (additive): providerLabel names a mode or provider id for the chat (#mode, recovery).
    assert.deepEqual(opened.providerLabel('llama-local'), { label: 'Local llama', waitingLabel: 'Local llama' });
    assert.deepEqual(opened.providerLabel('provider:llama-id'), { label: 'Local llama', waitingLabel: 'Local llama' });
    assert.equal(opened.providerLabel('chatgpt').label, 'ChatGPT');
    assert.equal(opened.providerLabel('provider:never-seen'), undefined);
  } finally {
    await opened.close();
  }
  assert.deepEqual(opened.providers(), [], 'closed: no rows');
  // Without the adapter: the bundled built-ins only, without session parts.
  const bare = await openSession(deps, 'offline', keptStorage(deps.pd));
  try {
    assert.deepEqual(bare.providers().map((row) => row.mode), ['offline', 'claude', 'chatgpt', 'openai']);
  } finally {
    await bare.close();
  }
  await runtime.close();
});

test('agent.sessions@1 facade forwards providers() and refuses it while no session is open', { skip }, async () => {
  const contracts = await app.load('agent-contracts.js');
  const { createSessionCloser } = await app.load('app-revisions.js');
  const fake = { snapshot: { busy: false }, subscribe: () => () => {}, providers: () => [{ mode: 'llama-local' }], setDraft: async () => {}, close: async () => {} };
  const sessions = sessionsModule.createAgentSessions({ open: async () => fake, closer: createSessionCloser(async () => {}), hostInfo: { foreground: true } });
  const { facade } = sessions;
  assert.equal(typeof facade.providers, 'function');
  assert.throws(() => facade.providers(), { message: contracts.SESSION_NOT_OPEN_MESSAGE });
  await sessions.start();
  assert.equal(facade.current(), fake);
  assert.deepEqual(facade.providers(), [{ mode: 'llama-local' }], 'forwarded to the open session');
});

test('provider-settings.js over the real session: option, panel, Connect, model choice saved through setModelSettings', { skip, timeout: 120000 }, async () => {
  const server = { up: false, created: 0, connects: 0, modelCalls: 0, listeners: new Set() };
  const { runtime, adapter } = await page({ extra: [llamaRow(server)] });
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: adapter });
  const dom = installDom({ mode: 'select', 'provider-panel': 'div' }, (fixed) => builtinModeOptions(fixed.mode));
  try {
    const select = dom.fixed.mode;
    const connected = [];
    let saves = 0;
    const settings = providerSettingsModule.initProviderSettings({
      getSession: () => opened,
      onChange: () => { saves++; void opened.setModelSettings({ mode: select.value, modelId: settings.selectedModel(select.value), thinkingEffort: '' }); },
      onUpdate: () => settings.update({ mode: select.value }),
      onConnected: (mode) => connected.push(mode)
    });
    settings.sync();
    assert.deepEqual(select.options.map((option) => [option.value, option.textContent]), [['offline', 'Offline demo'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude Code'], ['openai', 'OpenAI API key'], ['llama-local', 'Local llama']]);
    select.value = 'llama-local';
    await opened.setModelSettings({ mode: 'llama-local', modelId: '', thinkingEffort: '' });
    settings.restore(opened.snapshot.modelSettings);
    settings.update({ mode: 'llama-local', locked: false });
    await settle(10);
    const byId = (id) => all(dom.fixed['provider-panel']).find((node) => node.id === id);
    assert.equal(dom.fixed['provider-panel'].hidden, false);
    assert.equal(byId('provider-status').textContent, 'The local server is not running. Start the local server first.');
    assert.deepEqual(byId('provider-model').options.map((option) => [option.value, option.textContent]), [['', 'Default (Llama llama-3)'], ['llama-3', 'Llama llama-3']], 'catalog while models() fails');
    assert.equal(byId('provider-connect').hidden, false);
    assert.equal(settings.modelLabel('llama-local'), 'Llama llama-3', 'composer label: the default model, by name');
    await byId('provider-connect').click();
    await settle(10);
    assert.deepEqual(connected, ['llama-local']);
    assert.equal(byId('provider-status').textContent, 'Connected to 127.0.0.1:8080');
    assert.equal(byId('provider-connect').hidden, true);
    assert.deepEqual(byId('provider-model').options.map((option) => option.value), ['', 'llama-3', 'llama-3-small']);
    byId('provider-model').value = 'llama-3-small';
    await byId('provider-model').dispatch('change');
    await until(() => opened.snapshot.modelSettings.modelId === 'llama-3-small', 'the choice was saved');
    assert.equal(saves, 1);
    assert.deepEqual(opened.snapshot.modelSettings, { mode: 'llama-local', modelId: 'llama-3-small', thinkingEffort: '' });
    assert.equal(settings.modelLabel('llama-local'), 'Llama 3 small');
    assert.equal(settings.ready('llama-local'), true);
    // The plugin goes away while selected: the option becomes "(not available)", the panel hides.
    await runtime.stop('plugin-llama-local');
    await until(() => !adapter.rows().some((row) => row.mode === 'llama-local'), 'llama row gone');
    settings.update({ mode: select.value, locked: false });
    assert.deepEqual(select.options.slice(4).map((option) => [option.value, option.textContent, option.disabled, option.dataset.provider]), [['llama-local', 'Local llama (not available)', true, 'unavailable']]);
    assert.equal(dom.fixed['provider-panel'].hidden, true);
    assert.deepEqual(opened.snapshot.modelSettings, { mode: 'llama-local', modelId: 'llama-3-small', thinkingEffort: '', available: false, label: 'Local llama' }, 'P3: the chat keeps its mode');
    assert.equal(settings.ready('llama-local'), false);
  } finally {
    await opened.close();
    await runtime.close();
    await settle();
    dom.restore();
  }
});

test('Settings → Plugins: a core provider whose runtime copy fell back after create() failed says "Failed: … (using built-in copy)"', { skip, timeout: 120000 }, async () => {
  const { runtime, adapter, errors } = await page({ rowOf: (row) => row.mode === 'chatgpt' ? Object.freeze({ ...row, create() { throw new Error('chatgpt create exploded'); } }) : row });
  const IDS = { 'plugin-settings': 'details', 'plugin-group-conversation': 'section', 'plugin-list': 'div', 'plugin-group-builtin': 'details', 'plugin-builtin-count': 'span', 'plugin-builtin': 'div', 'plugin-group-installed': 'section', 'plugin-installed': 'div', 'plugin-status': 'p', 'chat-settings': 'button' };
  const dom = installDom(IDS);
  let opened;
  try {
    let current = null;
    const withProviders = pluginSettingsModule.initPluginSettings({ agentProviders: adapter, getSession: () => current });
    await withProviders.connect({ runtime });
    const row = (name) => all(dom.fixed['plugin-builtin']).find((node) => node.className === 'plugin-item' && all(node).some((child) => child.className === 'plugin-name' && child.textContent === name));
    assert.equal(row('ChatGPT').textContent, 'ChatGPTbuilt-inActive · model provider: chatgpt · settings.sections provider-chatgpt', 'healthy until a session builds the row (S1a: plus its Settings panel)');
    // A session builds the rows: chatgpt's create() throws, the bundled copy is used.
    opened = await openSession(deps, 'offline', keptStorage(deps.pd), { agentProviders: adapter });
    current = opened;
    await settle();
    assert.deepEqual(adapter.list().fallbacks, [{ pluginId: 'core-providers-chatgpt', reason: 'chatgpt create exploded' }]);
    assert.ok(errors.some(([phase, id, text]) => phase === 'create' && id === 'core-providers-chatgpt' && text === 'chatgpt create exploded (using built-in copy)'));
    // Re-rendered through the adapter's subscribe (no manual update).
    assert.match(row('ChatGPT').textContent, /Failed: chatgpt create exploded \(using built-in copy\)$/);
    assert.equal(all(row('ChatGPT')).find((node) => node.tag === 'strong').textContent, 'Failed');
    assert.match(dom.fixed['plugin-builtin-count'].textContent, /1 not active/);
    assert.equal(row('Claude').textContent, 'Claudebuilt-inActive · model provider: claude · settings.sections provider-claude', 'the others stay healthy');
    // The session still works on the bundled ChatGPT row (no provider is missing).
    assert.ok(opened.providers().some((entry) => entry.mode === 'chatgpt'));
    // Without agentProviders (pre-P4 wiring) the fallback was not shown.
    const fixedBefore = dom.fixed['plugin-builtin'];
    fixedBefore.replaceChildren();
    const legacy = pluginSettingsModule.initPluginSettings({ getSession: () => current });
    await legacy.connect({ runtime });
    assert.doesNotMatch(row('ChatGPT').textContent, /Failed/);
  } finally {
    await opened?.close();
    await runtime.close();
    await settle();
    dom.restore();
  }
});
