import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { assistantModels, fakeAccount, fakeFetch, keptStorage, openSession, storedDocs } from './plugin-p0-support.mjs';

// Step P3 of docs/plugins-providers-agent-core.md (§B1b): a model provider whose plugin
// is missing (disabled, uninstalled, unknown, still loading). A fake plugin provider
// "llama-local" (provider id "llama-id", auth none, OpenAI Responses stream to a local
// URL answered by a fake transport) is disabled while a chat that uses it has a pending
// reply: the chat keeps its mode, sending is refused naming the provider, the pending
// work waits under the recovery hold provider:<id> and resumes when the provider comes
// back (mid-session, through the adapter) or after a reopen with the plugin enabled.
// The four built-in modes never take these paths (P0 pins them; checked here as well).
// Real session.js / session-providers.js / agent-providers.js / plugin-runtime.js with the
// bundled library; the app.js #mode/recovery helpers run against a mocked select.
// Mocked hosts and transports only: not on-device verification.
const root = new URL('..', import.meta.url).pathname;
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai/pi-durable) is not present';
let app, deps, runtimeModule, providersModule, createCoreProviderPlugins;
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
  ({ createCoreProviderPlugins } = await app.load('plugin-builtins.js'));
});
after(async () => { await app?.remove(); });

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const UNAVAILABLE = 'Local llama is not available. Enable its plugin or choose another model.';
const LLAMA_URL = 'http://127.0.0.1:8080/v1';
const llamaModel = (id) => ({ id, name: `Llama ${id}`, api: 'openai-responses', provider: 'llama-id', baseUrl: LLAMA_URL, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
// The fake third-party provider row (what a plugin contributes as agent.providers).
const llamaRow = Object.freeze({
  mode: 'llama-local', providerIds: Object.freeze(['llama-id']), label: 'Local llama', waitingLabel: 'Local llama', auth: 'none', order: 40, listed: true, defaultModelId: 'llama-3',
  catalog: () => [llamaModel('llama-3')], catalogModel: (id) => id === 'llama-3' ? llamaModel(id) : undefined, thinkingEfforts: () => [], fastModel: () => undefined,
  create(host) {
    const { stream, streamSimple } = host.ai.streams.openaiResponses;
    return {
      credential: async () => ({ auth: { apiKey: 'local-placeholder-not-a-secret' } }),
      models: async () => [llamaModel('llama-3')],
      savedModels: (refs) => refs.map((ref) => llamaModel(ref.modelId)),
      choose: async (config) => ({ model: llamaModel(config.modelId || 'llama-3'), list: [llamaModel('llama-3')] }),
      streams: { stream, streamSimple }
    };
  }
});
const LLAMA = { mode: 'llama-local', modelId: 'llama-3', thinkingEffort: '' };
const plugin = (id, setup) => ({ id, version: '1.0.0', provides: [], requires: [], uses: [], setup });
/** A page: plugin runtime with the core providers (+ llama unless left out) and a connected adapter. */
async function page({ llama = true, gate } = {}) {
  const runtime = runtimeModule.createPluginRuntime();
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  if (llama) runtime.register(plugin('llama', async (ctx) => { if (gate) await gate; ctx.contribute('agent.providers', 'llama-local', llamaRow, 40); }));
  void runtime.start();
  await until(() => runtime.list().filter((record) => record.state === 'active').length === (llama && !gate ? 5 : 4), 'plugins active');
  const adapter = providersModule.createAgentProviders();
  adapter.connect(runtime);
  return { runtime, adapter };
}
const finished = (opened, before) => !opened.snapshot.busy && !opened.snapshot.anyBusy && opened.snapshot.messages.length > before && opened.snapshot.messages.at(-1)?.role === 'assistant' && !opened.snapshot.messages.at(-1)?.pending;
async function sendAndWait(opened, text, config) {
  const before = opened.snapshot.messages.length;
  await opened.send(text, config);
  await until(() => finished(opened, before + 1), `${text}: the reply did not finish`);
  return opened.snapshot.messages.at(-1).text;
}
const refused = async (promise) => { try { await promise; return 'sent'; } catch (error) { return error.message; } };

test('a plugin provider disabled mid-life: mode kept, send refused, pending work waits; reopen still missing waits; re-enable + reopen resumes', { skip, timeout: 180000 }, async () => {
  const storage = keptStorage(deps.pd);
  let chat2;
  // ---- session 1: the plugin works, then is disabled while chat 2 has a reply in progress
  let holdSecond;
  const firstTransport = fakeFetch(async ({ url }, n) => {
    if (n === 2) {
      await new Promise((resolve) => { holdSecond = resolve; });
      return { tool: { name: 'workspace_write', args: { path: 'llama-note.txt', text: 'from llama' } } };
    }
    return undefined;
  });
  const first = await page();
  let opened = await openSession(deps, 'offline', storage, { fetch: firstTransport.fetch, agentProviders: first.adapter });
  try {
    assert.equal(await sendAndWait(opened, 'one', LLAMA), 'reply 1');
    assert.ok(firstTransport.requests[0].url.startsWith(`${LLAMA_URL}/responses`), 'the plugin provider answered');
    assert.deepEqual(opened.snapshot.modelSettings, LLAMA, 'available: no flag');
    assert.equal(opened.snapshot.mode, 'llama-local');
    await opened.newThread();
    chat2 = opened.snapshot.conversation.id;
    assert.notEqual(chat2, 1);
    assert.deepEqual(opened.snapshot.modelSettings, LLAMA, 'the new chat inherits the choice');
    await opened.send('two', LLAMA);
    await until(() => typeof holdSecond === 'function', 'second request reached the transport');
    // Disable the plugin while its request streams (it finishes there); the next request waits.
    await first.runtime.stop('llama');
    await until(() => !first.adapter.rows().some((row) => row.mode === 'llama-local'), 'llama row gone');
    holdSecond();
    await until(() => opened.snapshot.paused === true, 'the pending reply did not pause');
    await settle(100);
    assert.equal(firstTransport.requests.length, 2, 'no request reached the transport after the provider went away');
    assert.deepEqual(opened.snapshot.recoveryProviders, ['provider:llama-id']);
    assert.ok(opened.snapshot.busy, 'chat 2 is still working');
    assert.deepEqual(opened.snapshot.modelSettings, { ...LLAMA, available: false, label: 'Local llama' }, 'mode kept, marked unavailable');
    assert.equal(opened.snapshot.mode, 'provider:llama-id');
    // Chat 1 (idle, stored llama-local): sending and saving the mode are refused, nothing is written.
    await opened.switchConversation(1);
    assert.deepEqual(opened.snapshot.modelSettings, { ...LLAMA, available: false, label: 'Local llama' });
    assert.equal(await refused(opened.send('three')), UNAVAILABLE);
    assert.equal(await refused(opened.send('three', { mode: 'provider:llama-id' })), 'Local llama is not available. Enable its plugin or choose another model.');
    assert.equal(await refused(opened.setModelSettings(LLAMA)), UNAVAILABLE);
    assert.equal(firstTransport.requests.length, 2);
    assert.equal(opened.snapshot.messages.filter((message) => message.role === 'user').length, 1, 'the refused text was not submitted');
    await opened.switchConversation(chat2);
  } finally {
    await opened.close();
    await first.runtime.close();
  }
  let docs = await storedDocs(deps, storage, [1, chat2]);
  assert.deepEqual(docs.modelSettings, { 1: LLAMA, [chat2]: LLAMA }, 'ThreadsDoc keeps llama-local (no coercion to offline)');
  assert.deepEqual(docs.agents[chat2].model, { provider: 'llama-id', modelId: 'llama-3' });

  // ---- session 2: reopened while the plugin is still disabled: the work waits, mode kept
  const secondTransport = fakeFetch();
  const second = await page({ llama: false });
  opened = await openSession(deps, 'offline', storage, { fetch: secondTransport.fetch, agentProviders: second.adapter });
  try {
    assert.equal(opened.snapshot.conversation.id, chat2);
    await until(() => opened.snapshot.paused === true, 'reopened work did not wait');
    await settle(150);
    assert.equal(secondTransport.requests.length, 0);
    assert.deepEqual(opened.snapshot.recoveryProviders, ['provider:llama-id']);
    // Never seen on this page: the label is the raw mode.
    assert.deepEqual(opened.snapshot.modelSettings, { ...LLAMA, available: false, label: 'llama-local' });
    assert.equal(opened.snapshot.mode, 'provider:llama-id');
    await opened.switchConversation(1);
    assert.equal(await refused(opened.send('four')), 'llama-local is not available. Enable its plugin or choose another model.');
  } finally {
    await opened.close();
    await second.runtime.close();
  }
  docs = await storedDocs(deps, storage, [1, chat2]);
  assert.deepEqual(docs.modelSettings, { 1: LLAMA, [chat2]: LLAMA });

  // ---- session 3: the plugin is enabled again; reopening resumes the saved work
  const thirdTransport = fakeFetch(() => ({ text: 'Recovered by llama.' }));
  const third = await page();
  opened = await openSession(deps, 'offline', storage, { fetch: thirdTransport.fetch, agentProviders: third.adapter });
  try {
    await opened.switchConversation(chat2);
    await until(() => thirdTransport.requests.length === 1 && finished(opened, 2) && !opened.snapshot.paused, 'did not resume after the plugin came back', 20000);
    assert.equal(opened.snapshot.messages.at(-1).text, 'Recovered by llama.');
    assert.ok(thirdTransport.requests[0].url.startsWith(`${LLAMA_URL}/responses`));
    assert.deepEqual(opened.snapshot.recoveryProviders, []);
    assert.deepEqual(opened.snapshot.modelSettings, LLAMA);
    assert.equal(opened.snapshot.mode, 'llama-local');
  } finally {
    await opened.close();
    await third.runtime.close();
  }
  assert.deepEqual(await assistantModels(deps, storage, chat2), ['llama-id/openai-responses/llama-3', 'llama-id/openai-responses/llama-3'], 'the saved model answered (tool call, then the recovered reply)');
});

test('missing at open, then the adapter reports the provider: the held work resumes without a reopen', { skip, timeout: 120000 }, async () => {
  const storage = keptStorage(deps.pd);
  // A reply interrupted by close (its request hangs), with the plugin present.
  const hanging = fakeFetch(() => 'hang');
  const first = await page();
  let opened = await openSession(deps, 'offline', storage, { fetch: hanging.fetch, agentProviders: first.adapter });
  try {
    await opened.send('Interrupted reply.', LLAMA);
    await until(() => hanging.requests.length === 1, 'first request');
  } finally {
    await opened.close();
    await first.runtime.close();
  }
  // Reopen: the plugin is still loading (its setup waits), so nothing owns llama-id yet.
  let arrive;
  const gate = new Promise((resolve) => { arrive = resolve; });
  const transport = fakeFetch(() => ({ text: 'Recovered mid-session.' }));
  const second = await page({ gate });
  opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch, agentProviders: second.adapter });
  const seen = [];
  const unsubscribe = opened.subscribe((snapshot) => seen.push(snapshot.modelSettings.available));
  try {
    await until(() => opened.snapshot.paused === true, 'did not wait');
    await settle(100);
    assert.equal(transport.requests.length, 0);
    assert.deepEqual(opened.snapshot.recoveryProviders, ['provider:llama-id']);
    assert.equal(opened.snapshot.modelSettings.available, false);
    arrive();
    await until(() => transport.requests.length === 1 && finished(opened, 1) && !opened.snapshot.paused, 'did not resume when the provider arrived', 20000);
    assert.equal(opened.snapshot.messages.at(-1).text, 'Recovered mid-session.');
    assert.deepEqual(opened.snapshot.modelSettings, LLAMA, 'available again (republished when the rows changed)');
    assert.ok(seen.includes(false) && seen.at(-1) === undefined);
    // And it sends normally again.
    assert.equal(await sendAndWait(opened, 'again', {}), 'Recovered mid-session.');
  } finally {
    unsubscribe();
    await opened.close();
    await second.runtime.close();
  }
  assert.deepEqual((await assistantModels(deps, storage)).slice(-2), ['llama-id/openai-responses/llama-3', 'llama-id/openai-responses/llama-3']);
});

test('a provider removed while its mode holds saved work: the work moves to provider:<id> and resumes with the next owner', { skip, timeout: 120000 }, async () => {
  const storage = keptStorage(deps.pd);
  const hanging = fakeFetch(() => 'hang');
  const first = await page();
  let opened = await openSession(deps, 'offline', storage, { fetch: hanging.fetch, agentProviders: first.adapter });
  try {
    await opened.send('Interrupted reply.', LLAMA);
    await until(() => hanging.requests.length === 1, 'first request');
  } finally {
    await opened.close();
    await first.runtime.close();
  }
  // Reopen: llama is there but its server is down (models() fails), so the work is held by mode.
  const down = Object.freeze({ ...llamaRow, create(host) { return { ...llamaRow.create(host), models: async () => { throw new Error('server down'); } }; } });
  let arrive;
  const gate = new Promise((resolve) => { arrive = resolve; });
  const runtime = runtimeModule.createPluginRuntime();
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  runtime.register(plugin('llama-down', (ctx) => { ctx.contribute('agent.providers', 'llama-local', down, 40); }));
  // A second package for the same mode (e.g. a reinstalled build) that loads later.
  runtime.register(plugin('llama-new', async (ctx) => { await gate; ctx.contribute('agent.providers', 'llama-local', llamaRow, 40); }));
  void runtime.start();
  await until(() => runtime.list().filter((record) => record.state === 'active').length === 5, 'plugins active');
  const adapter = providersModule.createAgentProviders();
  adapter.connect(runtime);
  const transport = fakeFetch(() => ({ text: 'Recovered by the new owner.' }));
  opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch, agentProviders: adapter });
  try {
    await until(() => opened.snapshot.paused === true, 'did not wait');
    assert.deepEqual(opened.snapshot.recoveryProviders, ['llama-local'], 'held by mode while its row exists');
    assert.deepEqual(opened.snapshot.modelSettings, LLAMA);
    // The row goes away: its waiting request moves to the stand-in under provider:llama-id.
    await runtime.stop('llama-down');
    await until(() => opened.snapshot.recoveryProviders?.[0] === 'provider:llama-id', 'the work did not move to provider:llama-id');
    assert.equal(opened.snapshot.paused, true);
    assert.equal(opened.snapshot.modelSettings.available, false);
    assert.equal(transport.requests.length, 0);
    // The next owner arrives: same mode, same id; the work resumes on it.
    arrive();
    await until(() => transport.requests.length === 1 && finished(opened, 1) && !opened.snapshot.paused, 'did not resume with the next owner', 20000);
    assert.equal(opened.snapshot.messages.at(-1).text, 'Recovered by the new owner.');
    assert.ok(transport.requests[0].url.startsWith(`${LLAMA_URL}/responses`));
    assert.deepEqual(opened.snapshot.recoveryProviders, []);
  } finally {
    await opened.close();
    await runtime.close();
  }
  assert.deepEqual((await assistantModels(deps, storage)).at(-1), 'llama-id/openai-responses/llama-3');
});

test('built-in modes never take the missing-provider paths', { skip, timeout: 120000 }, async () => {
  const transport = fakeFetch();
  const { runtime, adapter } = await page();
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { fetch: transport.fetch, agentProviders: adapter, chatgpt: fakeAccount('chatgpt'), claude: fakeAccount('claude') });
  try {
    // A plugin provider going away changes nothing for the built-ins.
    await runtime.stop('llama');
    // A built-in runtime copy going away falls back to its bundled copy (still available).
    await runtime.stop('core-providers-claude');
    await settle(20);
    assert.ok(adapter.rows().some((row) => row.mode === 'claude'));
    for (const config of [{ mode: 'offline', modelId: 'faux-1', thinkingEffort: '' }, { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: '' }, { mode: 'claude', modelId: '', thinkingEffort: '' }, { mode: 'openai', modelId: 'gpt-4.1-mini', thinkingEffort: '' }]) {
      await opened.setModelSettings(config);
      assert.deepEqual(opened.snapshot.modelSettings, config, `${config.mode}: no availability flag, nothing added`);
    }
    assert.equal(await sendAndWait(opened, 'claude', { mode: 'claude', modelId: '' }), 'reply 1');
    assert.equal(opened.snapshot.mode, 'claude');
    assert.equal(await sendAndWait(opened, 'chatgpt', { mode: 'chatgpt', modelId: 'gpt-5' }), 'reply 2');
    assert.equal(opened.snapshot.mode, 'chatgpt');
    assert.match(await sendAndWait(opened, 'offline', { mode: 'offline' }), /scripted offline demo/);
    assert.deepEqual(opened.snapshot.recoveryProviders, []);
    // Missing or empty modes still mean offline (only a named mode without a row is refused).
    await opened.setModelSettings({});
    assert.deepEqual(opened.snapshot.modelSettings, { mode: 'offline', modelId: 'faux-1', thinkingEffort: '' });
  } finally {
    await opened.close();
    await runtime.close();
  }
});

test('subagents: an unknown provider id is still "Unknown model" (no stand-in is listed)', { skip, timeout: 60000 }, async () => {
  const { createSessionProviders } = await app.load('session-providers.js');
  const { createRecoveryGate } = await app.load('recovery.js');
  const { providerRow: offline } = await app.load('builtin/core-providers-offline/web/provider.js');
  const models = deps.ai.createModels();
  const recovery = createRecoveryGate();
  const engine = createSessionProviders({ models, rows: [offline], recovery, host: { transport: () => fetch, credentials: {}, messages: { textOf: () => '', attachedUserPresentation: () => undefined } }, storedModel: async () => ({ provider: 'llama-id', modelId: 'llama-3' }) });
  try {
    await assert.rejects(engine.resolveModel('llama-id/llama-3'), /Unknown model "llama-id\/llama-3"/);
    assert.equal(engine.modeOf('llama-id'), 'provider:llama-id');
    assert.equal(engine.modeOf(undefined), 'offline');
    assert.equal(engine.modeOf('faux'), 'offline');
    assert.deepEqual(engine.normalize({ mode: 'llama-local', modelId: ' llama-3 ', thinkingEffort: 'high' }), { mode: 'llama-local', modelId: 'llama-3', thinkingEffort: 'high' }, 'kept, never coerced');
    assert.deepEqual(engine.normalize({ mode: 'Not A Mode' }), { mode: 'offline', modelId: 'faux-1', thinkingEffort: '' }, 'an impossible mode is not a provider');
    assert.throws(() => engine.checked({ mode: 'llama-local' }), /^Error: llama-local is not available\. Enable its plugin or choose another model\.$/);
    await assert.rejects(engine.ensureStored(3), /llama-id is not available/);
    assert.equal(engine.stored({ mode: 'provider:llama-id', modelId: 'x', thinkingEffort: '' }), undefined, 'a display-only mode is never stored');
    // Saved work of a provider nobody owns waits behind a stand-in that lists its model.
    engine.registerSaved([{ provider: 'llama-id', modelId: 'llama-3' }]);
    assert.ok(recovery.has('provider:llama-id'));
    assert.deepEqual(engine.recovering, []);
    assert.ok(models.getModel('llama-id', 'llama-3'), 'pi-durable finds the saved model (no "not available" failure)');
    const listed = await engine.listModels(undefined);
    assert.ok(!listed.includes('llama-id'), listed);
  } finally {
    engine.close();
  }
});

// ---- chat.js (core-chat, C7; was app.js): #mode option and recovery names (functions run
// against a mocked select and a session whose providerLabel (agent.sessions@1) answers from
// rows, else remembered labels, as session-providers.js labelsOf does) ----
const CHAT = 'plugins/core-chat/web/chat.js';
async function appHelpers({ rows = [], labels = {} } = {}) {
  const text = await readFile(join(root, CHAT), 'utf8');
  const extract = (name) => {
    const start = text.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `app.js: function ${name} not found`);
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error(`app.js: function ${name} not closed`);
  };
  class Option { constructor(label, value) { this.textContent = label; this.value = value; this.dataset = {}; this.disabled = false; } }
  const options = ['offline', 'chatgpt', 'claude', 'openai'].map((value) => new Option(value, value));
  const mode = {
    get options() { return [...options]; },
    add(option) { options.push(option); option.remove = () => options.splice(options.indexOf(option), 1); },
    value: ''
  };
  for (const option of options) option.remove = () => options.splice(options.indexOf(option), 1);
  const session = { providerLabel(key) {
    const id = key.startsWith('provider:') ? key.slice('provider:'.length) : undefined;
    const row = rows.find((item) => id === undefined ? item.mode === key : item.providerIds.includes(id));
    return row ? { label: row.label, waitingLabel: row.waitingLabel ?? row.label } : labels[key];
  } };
  const sessions = { current: () => session };
  const make = new Function('mode', 'Option', 'sessions', `${extract('providerLabel')}\n${extract('modeOption')}\n${extract('waitingName')}\nreturn { modeOption, waitingName };`);
  return { ...make(mode, Option, sessions), mode, options };
}

test('chat.js: a stored unknown mode gets a "(not available)" option; recovery names come from rows or the raw id', async () => {
  const { modeOption, waitingName, options } = await appHelpers({ labels: { 'llama-local': { label: 'Local llama', waitingLabel: 'Local llama server' } } });
  modeOption({ mode: 'llama-local', modelId: 'llama-3', thinkingEffort: '', available: false, label: 'Local llama' });
  let extra = options.filter((option) => option.dataset.provider);
  assert.deepEqual(extra.map((option) => [option.value, option.textContent, option.disabled, option.dataset.provider]), [['llama-local', 'Local llama (not available)', true, 'unavailable']]);
  // Without a label from the session: the adapter's memory, else the raw id.
  modeOption({ mode: 'provider:other-id', modelId: '', thinkingEffort: '', available: false });
  extra = options.filter((option) => option.dataset.provider);
  assert.deepEqual(extra.map((option) => [option.value, option.textContent]), [['provider:other-id', 'other-id (not available)']], 'the previous extra option is removed');
  // A built-in choice removes it and adds nothing.
  modeOption({ mode: 'chatgpt', modelId: '', thinkingEffort: '' });
  assert.deepEqual(options.map((option) => option.value), ['offline', 'chatgpt', 'claude', 'openai']);
  // Recovery names: built-ins keep today's texts without rows (fallback) and with rows.
  assert.deepEqual(['openai', 'chatgpt', 'claude'].map(waitingName), ['OpenAI API key', 'ChatGPT', 'Claude Code']);
  assert.equal(waitingName('provider:llama-id'), 'llama-id', 'never seen: the raw id');
  assert.equal(waitingName('llama-local'), 'Local llama server', 'the remembered waitingLabel');
  const withRows = await appHelpers({ rows: [{ mode: 'chatgpt', providerIds: ['openai-chatgpt'], label: 'ChatGPT', waitingLabel: 'ChatGPT' }, { mode: 'llama-local', providerIds: ['llama-id'], label: 'Local llama', waitingLabel: 'Local llama' }] });
  assert.equal(withRows.waitingName('chatgpt'), 'ChatGPT');
  assert.equal(withRows.waitingName('provider:llama-id'), 'Local llama', 'an owner of the id names it');
});

test('chat.js wiring: restoreModelSettings uses modeOption; the resume panel names missing providers', async () => {
  const text = await readFile(join(root, CHAT), 'utf8');
  assert.match(text, /renderedModelSettings = signature;\n\s+modeOption\(choice\);\n\s+mode\.value = choice\.mode;/);
  assert.match(text, /const names = providers\.map\(waitingName\)\.filter\(Boolean\);/);
  assert.match(text, /Enable its plugin to continue\./);
  // The built-in recovery sentence is unchanged.
  assert.ok(text.includes('Open Settings to connect the account, or enter the API key and choose Resume. Work continues with its saved model.'));
});
