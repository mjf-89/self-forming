import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { assistantModels, keptStorage, openSession, storedDocs } from './plugin-p0-support.mjs';
import { DUMMY_KEY, fakeCredentials, fakeHttp, hostAi, importPlugin, memoryStorage, startFixtureServer, textFrames, toolFrames } from './plugin-p5-support.mjs';

// Step P5 end to end: the installed package examples/plugins/openai-compatible loaded
// through the real plugin runtime (and plugin-client.js loadInstalledPlugins with a fake
// bridge), the real agent-providers.js adapter and the real session (session.js +
// session-providers.js, A2 "offline" configuration), talking to a real HTTP server on
// 127.0.0.1. Checks: a send streams the reply; a tool call round trip; missing endpoint
// and missing key errors; a stored key (fake ctx.credentials lane) goes only into the
// Authorization header; a remote https endpoint goes through the session's host
// transport and the allow-list (fake ctx.http lane); the plugin refuses to start without
// ctx.pi.ai. ctx.pi.ai, ctx.credentials and ctx.http are the PROPOSED host additions
// (plugin-pi.js / plugin-client.js), simulated here. Dummy keys only. Not on-device.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai/pi-durable) is not present';
let app, deps, runtimeModule, providersModule, clientModule, createCoreProviderPlugins, pluginPi, plugin, server;
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
  clientModule = await app.load('plugin-client.js');
  ({ createCoreProviderPlugins } = await app.load('plugin-builtins.js'));
  ({ pluginPi } = await app.load('plugin-pi.js'));
  plugin = await importPlugin('index.js');
  server = await startFixtureServer();
});
after(async () => {
  await server?.close();
  await app?.remove();
  delete globalThis.localStorage;
});

const HASH = 'a'.repeat(64);
const MANIFEST = { id: 'openai-compatible', name: 'OpenAI-compatible', version: '0.1.0', api: 1, hash: HASH, enabled: true, state: 'installed', reload: 'page', web: { entry: 'web/index.js' }, provides: [{ id: 'openai-compatible.endpoints', version: 1 }], requires: [], uses: [] };
const COMPAT = (modelId) => ({ mode: 'openai-compatible', modelId, thinkingEffort: '' });
const NO_ENDPOINT = 'Add an OpenAI-compatible endpoint first (its base URL, e.g. http://127.0.0.1:8080/v1).';
const refused = async (promise) => { try { await promise; return 'sent'; } catch (error) { return error.message; } };
const finished = (opened, before) => !opened.snapshot.busy && !opened.snapshot.anyBusy && opened.snapshot.messages.length > before && opened.snapshot.messages.at(-1)?.role === 'assistant' && !opened.snapshot.messages.at(-1)?.pending;
async function sendAndWait(opened, text, config) {
  const before = opened.snapshot.messages.length;
  await opened.send(text, config);
  await until(() => finished(opened, before + 1), `${text}: the reply did not finish`, 20000);
  return opened.snapshot.messages.at(-1).text;
}

/**
 * A page: plugin runtime (pi = plugin-pi.js bag + the proposed ai bag) with the core
 * providers and the package, connected agent.providers adapter.
 * via "client": plugin-client.js loadInstalledPlugins (today's lanes: no credentials/http);
 * via "lanes": a definition that hands setup the proposed ctx.credentials / ctx.http.
 */
async function page({ via = 'client', credentials, http, ai = true, keepStorage = false } = {}) {
  if (!keepStorage || !globalThis.localStorage) globalThis.localStorage = memoryStorage();
  // plugin-pi.js now ships the ai bag; ai:false simulates an older host without it.
  const { ai: _hostAi, ...withoutAi } = pluginPi;
  const pi = ai ? Object.freeze({ ...pluginPi, ai: pluginPi.ai ?? hostAi(deps.ai) }) : Object.freeze(withoutAi);
  const errors = [];
  const runtime = runtimeModule.createPluginRuntime({ pi, onError: (error, details) => errors.push([details?.id, error.message]) });
  for (const definition of createCoreProviderPlugins({})) runtime.register(definition);
  if (via === 'client') {
    const bridge = { async call(method) { if (method === 'plugins.list') return { api: 1, plugins: [MANIFEST] }; throw new Error(`unexpected ${method}`); } };
    const loaded = await clientModule.loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities: { plugins: true } }, importModule: async (url) => { assert.equal(url, `/assets/web/plugins/openai-compatible/${HASH}/web/index.js`); return plugin; } });
    assert.deepEqual(loaded.plugins.map((item) => [item.id, item.registered]), [['openai-compatible', true]]);
  } else {
    runtime.register({ ...MANIFEST, setup: (ctx) => plugin.setup(Object.freeze({ ...ctx, ...(credentials ? { credentials } : {}), ...(http ? { http } : {}) })) });
  }
  void runtime.start();
  await until(() => runtime.list().every((record) => record.state !== 'installed' && record.state !== 'starting'), 'plugins settled');
  const adapter = providersModule.createAgentProviders();
  adapter.connect(runtime);
  const endpoints = runtime.service('openai-compatible.endpoints', 1);
  return { runtime, adapter, endpoints, errors };
}
/** The session transport (options.fetch): Node fetch, recorded; remote test hosts map to the fixture. */
function hostTransport() {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', authorization: new Headers(init.headers).get('authorization') });
    return globalThis.fetch(url.replace('https://llm.example.test/v1', server.base), init);
  };
  return { fetch, calls };
}
async function allEntriesText(storage, ids = [1]) {
  const context = deps.chord.BACKGROUND_CONTEXT;
  let text = '';
  for (const conversationId of ids) {
    let cursor;
    do {
      const pageOf = await storage.scanEntries({ conversationId }, 100, cursor, context);
      for (const record of pageOf.items) text += JSON.stringify((await storage.entry?.(record.id, context))?.entry ?? record);
      cursor = pageOf.next;
    } while (cursor !== undefined);
  }
  return text;
}

test('installed package: a send streams the reply and a tool call round trip completes', { skip, timeout: 60000 }, async () => {
  server.setModels([{ id: 'qwen-test', object: 'model', owned_by: 'fixture' }]);
  server.setAnswer((request, n) => n === 1
    ? { frames: toolFrames('t1', { callId: 'call_fixture_1', name: 'workspace_write', args: { path: 'compat-note.txt', text: 'from compat' } }) }
    : { frames: textFrames('t2', ['Saved ', 'the ', 'note.']), delayMs: 80 });
  const start = server.requests.length;
  const { runtime, adapter, endpoints, errors } = await page();
  assert.deepEqual(errors, []);
  assert.equal(runtime.list().find((record) => record.id === 'openai-compatible').state, 'active');
  assert.deepEqual(adapter.describe().find((row) => row.mode === 'openai-compatible'), { mode: 'openai-compatible', label: 'OpenAI-compatible', auth: 'none', providerIds: ['openai-compatible'], pluginId: 'openai-compatible', source: 'runtime' });
  const added = await endpoints.add({ baseUrl: `${server.base}/`, label: 'Local' });
  assert.deepEqual({ slug: added.slug, baseUrl: added.baseUrl, models: added.models, keyRequired: added.keyRequired, keyStorage: added.keyStorage }, { slug: 'local', baseUrl: server.base, models: ['local/qwen-test'], keyRequired: false, keyStorage: 'memory' });
  const transport = hostTransport();
  const storage = keptStorage(deps.pd);
  const opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch, agentProviders: adapter });
  const partial = [];
  const unsubscribe = opened.subscribe((snapshot) => {
    const last = snapshot.messages.at(-1);
    if (last?.role === 'assistant' && last.pending && last.text) partial.push(last.text);
  });
  try {
    assert.equal(await sendAndWait(opened, 'Write a note, please.', COMPAT('local/qwen-test')), 'Saved the note.');
    assert.equal(opened.snapshot.mode, 'openai-compatible');
    assert.deepEqual(opened.snapshot.modelSettings, COMPAT('local/qwen-test'));
    const tool = opened.snapshot.messages.find((message) => message.role === 'tool');
    assert.equal(tool?.toolName, 'workspace_write');
    assert.ok(!tool.error, 'the tool ran');
    assert.ok(partial.some((text) => text !== 'Saved the note.' && 'Saved the note.'.startsWith(text)), `the reply streamed (partial texts: ${JSON.stringify(partial)})`);
  } finally {
    unsubscribe();
    await opened.close();
    await runtime.close();
  }
  const chats = server.requests.slice(start).filter((request) => request.path === '/v1/chat/completions');
  assert.equal(chats.length, 2);
  assert.ok(chats.every((request) => request.body.model === 'qwen-test' && request.body.stream === true && request.headers.authorization === undefined));
  assert.ok(chats[0].body.tools.some((item) => item.function.name === 'workspace_write'), 'the session tools are offered');
  const replay = chats[1].body.messages.slice(-2);
  assert.deepEqual(replay[0].tool_calls, [{ id: 'call_fixture_1', type: 'function', function: { name: 'workspace_write', arguments: '{"path":"compat-note.txt","text":"from compat"}' } }]);
  assert.equal(replay[1].role, 'tool');
  assert.equal(replay[1].tool_call_id, 'call_fixture_1');
  assert.equal(transport.calls.length, 0, 'loopback endpoints use the page fetch, not the host transport');
  assert.deepEqual(await assistantModels(deps, storage), ['openai-compatible/openai-completions/local/qwen-test', 'openai-compatible/openai-completions/local/qwen-test']);
  const docs = await storedDocs(deps, storage);
  assert.deepEqual(docs.modelSettings[1], COMPAT('local/qwen-test'));
  assert.deepEqual(docs.agents[1].model, { provider: 'openai-compatible', modelId: 'local/qwen-test' });
});

test('missing endpoint, unknown endpoint, model not offered and server down: sends are refused with a reason', { skip, timeout: 60000 }, async () => {
  server.setModels([{ id: 'qwen-test' }]);
  const { runtime, adapter, endpoints } = await page();
  const storage = keptStorage(deps.pd);
  const opened = await openSession(deps, 'offline', storage, { fetch: hostTransport().fetch, agentProviders: adapter });
  const before = server.chats().length;
  try {
    assert.equal(await refused(opened.send('hello', COMPAT(''))), NO_ENDPOINT);
    await endpoints.add({ baseUrl: server.base, label: 'Local' });
    assert.equal(await refused(opened.send('hello', COMPAT('gone/qwen-test'))), 'The OpenAI-compatible endpoint "gone" is not configured. Add it again or choose another model.');
    assert.equal(await refused(opened.send('hello', COMPAT('local/other-model'))), 'other-model is not offered by Local. Refresh its model list or choose another model.');
    await endpoints.add({ baseUrl: 'http://127.0.0.1:9/v1', label: 'Down' });
    assert.match((await endpoints.list()).find((item) => item.slug === 'down').lastError, /^Could not reach Down at http:\/\/127\.0\.0\.1:9\/v1 /);
    assert.match(await refused(opened.send('hello', COMPAT('down/anything'))), /^Could not reach Down at http:\/\/127\.0\.0\.1:9\/v1 .*Check that the server is running\.$/);
    assert.equal(server.chats().length, before, 'nothing was sent to the model server');
    assert.equal(opened.snapshot.messages.filter((message) => message.role === 'user').length, 0, 'no refused text was submitted');
    // "" = the first model of the first endpoint.
    server.setAnswer(() => ({ frames: textFrames('d', ['Default model.']) }));
    assert.equal(await sendAndWait(opened, 'hello', COMPAT('')), 'Default model.');
    assert.equal(server.chats().at(-1).body.model, 'qwen-test');
    assert.deepEqual(await refused(endpoints.add({ baseUrl: 'http://192.168.1.20:8080/v1' })), 'Plain http only works for this phone (127.0.0.1 or localhost). Use https for other machines.');
  } finally {
    await opened.close();
    await runtime.close();
  }
});

test('stored key: required key missing is refused; once saved it goes only into the Authorization header', { skip, timeout: 60000 }, async () => {
  server.setModels([{ id: 'qwen-test' }]);
  const credentials = fakeCredentials();
  const { runtime, adapter, endpoints } = await page({ via: 'lanes', credentials });
  const storage = keptStorage(deps.pd);
  const opened = await openSession(deps, 'offline', storage, { fetch: hostTransport().fetch, agentProviders: adapter });
  try {
    const added = await endpoints.add({ baseUrl: server.base, label: 'Locked', keyRequired: true });
    assert.equal(added.keyStorage, 'encrypted');
    const before = server.chats().length;
    assert.equal(await refused(opened.send('hello', COMPAT('locked/qwen-test'))), 'Save the API key for Locked first.');
    assert.equal(server.chats().length, before);
    assert.deepEqual(await endpoints.setKey('locked', DUMMY_KEY), { slug: 'locked', keySaved: true, keyStorage: 'encrypted' });
    assert.deepEqual([...credentials.records], [['locked', { apiKey: DUMMY_KEY }]], 'one plugin credential record, by endpoint slug');
    server.setAnswer(() => ({ frames: textFrames('k', ['With key.']) }));
    assert.equal(await sendAndWait(opened, 'hello', COMPAT('locked/qwen-test')), 'With key.');
    assert.equal(server.chats().at(-1).headers.authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(server.requests.filter((request) => request.path === '/v1/models').at(-1).headers.authorization, `Bearer ${DUMMY_KEY}`, 'model listing sends the key too');
    // Never in the snapshot, the stored chat, the endpoint config or the service answers.
    assert.ok(!JSON.stringify(opened.snapshot).includes(DUMMY_KEY));
    assert.ok(!(await allEntriesText(storage)).includes(DUMMY_KEY));
    assert.ok(![...globalThis.localStorage.values.values()].join('').includes(DUMMY_KEY));
    const listed = await endpoints.list();
    assert.ok(!JSON.stringify(listed).includes(DUMMY_KEY));
    assert.equal(listed[0].keySaved, true);
    // A 401 shows the safe text and never the key.
    server.setAnswer(() => ({ status: 401, body: { error: { message: `bad key ${DUMMY_KEY}`, type: 'invalid_request_error' } } }));
    const text = await sendAndWait(opened, 'again', COMPAT('locked/qwen-test'));
    assert.match(text, /^OpenAI-compatible request failed \(401\)\. bad key \[redacted\] \(invalid_request_error\)$/);
    assert.ok(!JSON.stringify(opened.snapshot).includes(DUMMY_KEY));
    await endpoints.clearKey('locked');
    assert.equal(credentials.records.size, 0);
    assert.equal(await refused(opened.send('hello', COMPAT('locked/qwen-test'))), 'Save the API key for Locked first.');
  } finally {
    await opened.close();
    await runtime.close();
  }
  assert.ok(credentials.calls.every(([, name]) => name === 'locked'), 'only its own record names');
});

test('remote https endpoint: allow-listed, requests go through the session transport (engine-wrapped), removal cleans up', { skip, timeout: 60000 }, async () => {
  const credentials = fakeCredentials();
  const http = fakeHttp();
  const { runtime, adapter, endpoints } = await page({ via: 'lanes', credentials, http });
  const transport = hostTransport();
  const storage = keptStorage(deps.pd);
  const opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch, agentProviders: adapter });
  const pageFetch = globalThis.fetch;
  let pageCalls = 0;
  globalThis.fetch = (input, init) => { if (String(input).includes('llm.example.test')) pageCalls++; return pageFetch(input, init); };
  try {
    const added = await endpoints.add({ baseUrl: 'https://llm.example.test/v1', label: 'Remote', models: ['remote-model'], apiKey: DUMMY_KEY });
    assert.deepEqual({ slug: added.slug, transport: added.transport, models: added.models, keyRequired: added.keyRequired, keySaved: added.keySaved }, { slug: 'remote', transport: 'app network (allow-list)', models: ['remote/remote-model'], keyRequired: true, keySaved: true });
    assert.deepEqual(http.entries, ['https://llm.example.test/v1']);
    server.setAnswer(() => ({ frames: textFrames('r', ['Remote ', 'reply.']) }));
    assert.equal(await sendAndWait(opened, 'hello', COMPAT('remote/remote-model')), 'Remote reply.');
    assert.deepEqual(transport.calls.map(({ url, method, authorization }) => [url, method, authorization === `Bearer ${DUMMY_KEY}`]), [['https://llm.example.test/v1/chat/completions', 'POST', true]]);
    assert.equal(pageCalls, 0, 'remote endpoints never use the page fetch');
    assert.equal(server.chats().at(-1).body.model, 'remote-model');
    // Errors go through the engine's safeModelErrorResponse (label "Model" until model-error.js accepts contribution labels).
    server.setAnswer(() => ({ status: 429, body: { error: { message: `slow down ${DUMMY_KEY}`, code: 'rate_limit' } } }));
    // A rate limit is retryable: since 0.6.5 the reply keeps retrying (settings.retry, 1000 attempts) and the
    // snapshot's retry carries the redacted error; Stop ends it.
    await opened.send('again', COMPAT('remote/remote-model'));
    await until(() => opened.snapshot.retry !== undefined, 'again: no retry status', 20000);
    assert.match(opened.snapshot.retry.error, /(Model|OpenAI-compatible) request failed \(429\)\. slow down \[redacted\] \(rate_limit\)/);
    assert.ok(!JSON.stringify(opened.snapshot).includes(DUMMY_KEY));
    await opened.stop();
    await until(() => !opened.snapshot.busy, 'again: Stop did not end the retries', 20000);
    assert.deepEqual(await endpoints.remove('remote'), { removed: 'remote' });
    assert.deepEqual(http.entries, [], 'the allow-list entry it added is removed');
    assert.equal(credentials.records.size, 0, 'and its key');
  } finally {
    globalThis.fetch = pageFetch;
    await opened.close();
    await runtime.close();
  }
});

test('the endpoint tool (agent.extensions "openai-compatible") lists and adds endpoints, never keys', { skip, timeout: 30000 }, async () => {
  server.setModels([{ id: 'qwen-test' }]);
  const credentials = fakeCredentials();
  const { runtime, endpoints } = await page({ via: 'lanes', credentials });
  try {
    const [contribution] = runtime.contributions('agent.extensions').filter((entry) => entry.providerId === 'openai-compatible');
    assert.equal(contribution.value.name, 'openai-compatible');
    const tool = contribution.value.tools.find((item) => item.name === 'openai_compatible_endpoints');
    assert.ok(tool, 'tool present');
    assert.ok(!Object.keys(tool.parameters.properties).some((name) => /key/i.test(name) && name !== 'keyRequired'), 'no key parameter');
    const run = async (args) => JSON.parse((await tool.execute(args, {}, {})).output[0].text);
    assert.deepEqual(await run({ action: 'list' }), []);
    const added = await run({ action: 'add', baseUrl: server.base, label: 'llama' });
    assert.deepEqual(added.models, ['llama/qwen-test']);
    await endpoints.setKey('llama', DUMMY_KEY);
    const listed = await run({ action: 'list' });
    assert.equal(listed[0].keySaved, true);
    assert.ok(!JSON.stringify(listed).includes(DUMMY_KEY));
    assert.deepEqual(await run({ action: 'remove', slug: 'llama' }), { removed: 'llama' });
  } finally {
    await runtime.close();
  }
});

test('the host provides ctx.pi.ai; on an older host without it the plugin fails at setup naming the missing host exports; the built-ins keep working', { skip, timeout: 30000 }, async () => {
  assert.equal(typeof pluginPi.ai?.createAssistantMessageEventStream, 'function', 'plugin-pi.js exports the ai bag');
  const { runtime, adapter, errors } = await page({ ai: false });
  try {
    const record = runtime.list().find((item) => item.id === 'openai-compatible');
    assert.equal(record.state, 'failed');
    assert.match(record.reason, /does not give plugins the pi-ai functions .*ctx\.pi\.ai: createAssistantMessageEventStream, parseStreamingJson, calculateCost, resolveTranscript, resolveTranscriptTools, getDeclaredTools, getSystemMessageText, renderSystemMessageUpdate/);
    assert.ok(errors.some(([id]) => id === 'openai-compatible'));
    assert.deepEqual(adapter.describe().map((row) => row.mode).sort(), ['chatgpt', 'claude', 'offline', 'openai']);
  } finally {
    await runtime.close();
  }
});

test('saved work: a reply interrupted by closing resumes on reopen through the plugin provider', { skip, timeout: 60000 }, async () => {
  server.setModels([{ id: 'qwen-test' }]);
  let release;
  server.setAnswer(() => new Promise((resolve) => { release = () => resolve({ frames: textFrames('late', ['never']) }); }));
  const storage = keptStorage(deps.pd);
  const first = await page();
  await first.endpoints.add({ baseUrl: server.base, label: 'Local' });
  const config = globalThis.localStorage.getItem('self-forming.plugin.openai-compatible.v1');
  let opened = await openSession(deps, 'offline', storage, { fetch: hostTransport().fetch, agentProviders: first.adapter });
  const before = server.chats().length;
  try {
    await opened.send('Interrupted reply.', COMPAT('local/qwen-test'));
    await until(() => server.chats().length === before + 1 && typeof release === 'function', 'first request');
  } finally {
    await opened.close();
    await first.runtime.close();
    release?.();
  }
  // Reopen (a new page: the endpoint config persists in localStorage).
  server.setAnswer(() => ({ frames: textFrames('r', ['Recovered ', 'reply.']) }));
  const second = await page({ keepStorage: true });
  assert.equal(globalThis.localStorage.getItem('self-forming.plugin.openai-compatible.v1'), config, 'same endpoint config');
  opened = await openSession(deps, 'offline', storage, { fetch: hostTransport().fetch, agentProviders: second.adapter });
  try {
    await until(() => finished(opened, 1) && !opened.snapshot.paused, 'did not resume', 20000);
    assert.equal(opened.snapshot.messages.at(-1).text, 'Recovered reply.');
    assert.deepEqual(opened.snapshot.recoveryProviders, []);
    assert.equal(opened.snapshot.mode, 'openai-compatible');
  } finally {
    await opened.close();
    await second.runtime.close();
  }
  assert.deepEqual(await assistantModels(deps, storage), ['openai-compatible/openai-completions/local/qwen-test']);
});
