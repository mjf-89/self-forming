import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { keptStorage, openSession, waitForAbort } from './plugin-p0-support.mjs';

// Step C5 precondition (docs/plugins-providers-agent-core.md §C5): the scenario
// "app update commits while viewing a busy helper, then unfinished work resumes"
// from tests/on-device-recovery.test.mjs, ported to the Node-18 plugin harness so it
// really runs on the phone. Real session.js (served layout, bundled pi-durable),
// mocked native host, memory storage kept across close instead of SQLite, a mocked
// ChatGPT endpoint (local SSE fixture). Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, ai, chord, session;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  chord = await app.load('library/chord/context.js');
  session = await app.load('session.js');
});
after(async () => { await app?.remove(); });

let responseId = 0;
function response(text, tool) {
  const id = ++responseId;
  const item = tool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
    : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...tool ? [] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const auth = () => ({
  async getAccessToken() { return 'dummy-c5-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }, { id: 'gpt-4.1-mini', name: 'Helper model' }]; },
  subscribe() { return () => {}; }
});
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function inspect(storage) {
  const context = chord.BACKGROUND_CONTEXT;
  const harness = await pd.Harness.open(storage, { models: ai.createModels(), registry: pd.createRegistry() }, context);
  try {
    const scan = async (fn) => { const items = []; let cursor; do { const page = await fn(cursor); items.push(...page.items); cursor = page.next; } while (cursor !== undefined); return items; };
    return {
      inspected: await harness.inspect(context),
      entries: await scan((cursor) => storage.scanEntries({ conversationId: pd.ROOT_CONVERSATION_ID }, 100, cursor, context)),
      tasks: await scan((cursor) => storage.scanTasks({}, 100, cursor, context))
    };
  } finally { await harness.close(context); }
}

test('app update commits while viewing a busy helper, then unfinished work resumes from storage', { skip, timeout: 30000 }, async () => {
  const deps = { session };
  const storage = keptStorage(pd);
  const childStarted = Promise.withResolvers();
  const staging = Promise.withResolvers();
  const allowStage = Promise.withResolvers();
  const activation = Promise.withResolvers();
  let parentCalls = 0, stageCalls = 0, activations = 0, childInterrupted = false;
  const appRevision = {
    async info() { return { sourcePath: '/workspace/self-forming' }; },
    async stage() {
      stageCalls++;
      staging.resolve();
      await allowStage.promise;
      return { revision: 'saved-update' };
    },
    onStaged(revision) { activations++; activation.resolve(revision); }
  };
  let opened = await openSession(deps, 'native', storage, { appRevision, chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-4.1-mini') {
      childStarted.resolve();
      try { return await waitForAbort(init.signal); } finally { childInterrupted = true; }
    }
    if (++parentCalls === 1) return response('', { name: 'subagent', args: { action: 'spawn', name: 'worker',
      message: 'Keep working across the app update.', model: 'openai-chatgpt/gpt-4.1-mini', thinking: 'off', tools: [], context: ['device'] } });
    if (parentCalls === 2) return response('', { name: 'app_update', args: { action: 'apply' } });
    return response('The updated app received the helper report.');
  } });
  try {
    const mainId = opened.snapshot.conversation.id;
    await opened.send('Start a helper, then apply the app edits.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await bounded(Promise.all([childStarted.promise, staging.promise]), 'Helper or update did not start');
    assert.equal(activations, 0, 'Staging alone must never activate an update');
    const child = (await opened.tree()).find((item) => item.kind === 'subagent');
    assert.ok(child);
    await opened.switchConversation(child.id);
    assert.equal(opened.snapshot.busy, true);
    allowStage.resolve();
    assert.equal(await bounded(activation.promise, 'Update waited for the busy helper'), 'saved-update');
    assert.equal(opened.snapshot.conversation.id, child.id, 'Activation is independent of the selected conversation');
    assert.equal(opened.snapshot.busy, true);
    assert.equal(childInterrupted, false, 'Activation notification does not wait for child completion');
    const closing = opened; opened = undefined;
    await bounded(closing.close(), 'Session close deadlocked');
    assert.equal(childInterrupted, true, 'Closing interrupts the in-flight request');
    const before = await inspect(storage);
    const update = before.entries.find((entry) => entry.kind === 'pi.tool-result' && entry.model?.[0]?.toolName === 'app_update');
    assert.equal(update?.model[0].details?.revision, 'saved-update', 'The successful update result is durably saved before closing');
    assert.equal(update.model[0].isError, false);
    assert.equal(before.tasks.find((task) => task.id === update.byTaskId)?.state.status, 'terminal');
    assert.ok(before.inspected.tasks.some((task) => task.record.conversationId === child.id), 'Unfinished child stays durable');

    const recovered = [];
    opened = await openSession(deps, 'native', storage, { appRevision, chatgpt: auth(), fetch: async (_url, init) => {
      const body = JSON.parse(init.body); recovered.push(body);
      return response(body.model === 'gpt-4.1-mini' ? 'Helper finished after reload.' : 'The updated app received the helper report.');
    } });
    await opened.switchConversation(mainId);
    await until(() => opened.snapshot.messages.some((message) => message.text === 'The updated app received the helper report.'),
      'Helper did not resume and report after update reload', 10000);
    assert.equal(recovered.filter((body) => body.model === 'gpt-4.1-mini').length, 1);
    assert.equal(stageCalls, 1, 'The saved app_update tool does not execute again after reload');
    assert.equal(activations, 1, 'The committed update notifies exactly once');
    assert.equal(opened.snapshot.messages.filter((message) => message.text.startsWith('[subagent worker answered]')).length, 1);
  } finally {
    allowStage.resolve();
    await opened?.close();
  }
});

test('a failed app_update result never activates; Stop during staging never activates', { skip, timeout: 30000 }, async () => {
  const deps = { session };
  for (const variant of ['error', 'stop']) {
    const storage = keptStorage(pd);
    const staging = Promise.withResolvers();
    const allowStage = Promise.withResolvers();
    let activations = 0, parentCalls = 0;
    const appRevision = {
      async info() { return { sourcePath: '/workspace/self-forming' }; },
      async stage() {
        staging.resolve();
        await allowStage.promise;
        if (variant === 'error') throw new Error('Staging failed in the fixture.');
        return { revision: 'stopped-update' };
      },
      onStaged() { activations++; }
    };
    const opened = await openSession(deps, 'native', storage, { appRevision, chatgpt: auth(), fetch: async () => {
      if (++parentCalls === 1) return response('', { name: 'app_update', args: { action: 'apply' } });
      return response('Done.');
    } });
    try {
      await opened.send('Apply the edits.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
      await bounded(staging.promise, 'Update did not start');
      // Stop waits for the running tool, so the fixture lets staging finish after Stop began.
      const stopping = variant === 'stop' ? opened.stop() : undefined;
      allowStage.resolve();
      await bounded(Promise.resolve(stopping), `${variant}: Stop did not settle`);
      await until(() => !opened.snapshot.busy, `${variant}: reply did not settle`, 10000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(activations, 0, `${variant}: no activation`);
    } finally {
      allowStage.resolve();
      await opened.close();
    }
  }
});

// ---- C5: the handoff is owned by core-self-update ------------------------------------
async function composition(variant, hostInfo) {
  if (variant === 'bundled') return undefined;
  const [runtimeModule, agentModule, coreModule, piModule] = await Promise.all(['plugin-runtime.js', 'agent-extensions.js', 'core-agent-plugins.js', 'plugin-pi.js'].map((name) => app.load(name)));
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  const loadBuilders = variant === 'failed' ? async () => { throw new Error('builders unavailable'); } : undefined;
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo, ...loadBuilders ? { loadBuilders } : {} })) runtime.register(definition);
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime);
  return { agentExtensions, runtime };
}

test('core-self-update owns the handoff: the engine no longer builds it; one per session harness', { skip }, async () => {
  const { readFile } = await import('node:fs/promises');
  const engine = await readFile(new URL('../apps/common/session-engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /createAppUpdateHandoff|\bharness\.subscribeCommits\(|import[^\n]*app-update-handoff/, 'the session engine has no handoff wiring');
  const entry = await app.load('builtin/core-self-update/web/index.js');
  const subscriptions = [], stops = [], closes = [];
  const harness = { subscribeCommits(fn) { subscriptions.push(fn); return () => subscriptions.splice(subscriptions.indexOf(fn), 1); },
    onStop(fn) { stops.push(fn); return () => stops.splice(stops.indexOf(fn), 1); }, onClose(fn) { closes.push(fn); return () => {}; } };
  const revisions = [];
  const host = { env: {}, harness, appRevision: { onStaged: (revision) => revisions.push(revision) } };
  const staged = entry.appUpdateStaged(host);
  assert.equal(entry.appUpdateStaged({ ...host }), staged, 'bundled and runtime copies share one handoff per session');
  assert.notEqual(entry.appUpdateStaged({ ...host, harness: { subscribeCommits() { return () => {}; } } }), staged, 'another session gets its own');
  assert.equal(entry.appUpdateStaged({ env: {}, appRevision: host.appRevision }), undefined, 'no harness handle: no handoff');
  assert.equal(entry.appUpdateStaged({ env: {}, harness }), undefined, 'no app revision host: no handoff');
  assert.equal(subscriptions.length, 0, 'no commit subscription before an update is staged');
  const call = { taskId: 't1', conversationId: 1, callId: 'c1' };
  const result = (details, extra = {}) => ({ changes: [{ type: 'entry', value: { kind: 'pi.tool-result', byTaskId: 't1', conversationId: 1,
    model: [{ role: 'toolResult', toolName: 'app_update', toolCallId: 'c1', isError: false, details, ...extra }] } }] });
  staged(undefined); staged('r1', call);
  assert.equal(subscriptions.length, 1);
  subscriptions[0](result({ action: 'apply', staged: true, revision: 'other' }));
  await Promise.resolve();
  assert.deepEqual(revisions, [], 'a different revision never activates');
  staged('r1', call);
  subscriptions[0](result({ action: 'apply', staged: true, revision: 'r1' }));
  assert.deepEqual(revisions, [], 'never inside the commit observer');
  await Promise.resolve();
  assert.deepEqual(revisions, ['r1'], 'deferred onStaged for the exact successful result');
  staged('r2', call);
  stops[0]();
  subscriptions[0](result({ action: 'apply', staged: true, revision: 'r2' }));
  await Promise.resolve();
  assert.deepEqual(revisions, ['r1'], 'Stop clears a staged update');
  staged('r3', call);
  closes[0]();
  assert.equal(subscriptions.length, 0, 'closing unsubscribes');
  assert.equal(stops.length, 0, 'closing removes the stop hook');
  staged('r3', call);
  assert.equal(subscriptions.length, 0, 'nothing after close');
});

for (const variant of ['runtime', 'failed']) {
  test(`app_update activates through the ${variant === 'runtime' ? 'runtime copy of core-self-update' : 'bundled copy when composition fails'}`, { skip, timeout: 30000 }, async () => {
    const { CONFIGURATIONS } = await import('./plugin-a2-support.mjs');
    const page = await composition(variant, CONFIGURATIONS.native().hostInfo);
    const revisions = [];
    let calls = 0;
    const appRevision = { async info() { return { sourcePath: '/src' }; }, async stage() { return { revision: `${variant}-update` }; }, onStaged: (revision) => revisions.push(revision) };
    const opened = await openSession({ session }, 'native', keptStorage(pd), { appRevision, chatgpt: auth(), agentExtensions: page?.agentExtensions,
      fetch: async () => ++calls === 1 ? response('', { name: 'app_update', args: { action: 'apply' } }) : response('Done.') });
    try {
      if (variant === 'failed') assert.ok(page.runtime.list().every((record) => record.state === 'failed'), 'composition failed');
      else assert.equal(page.runtime.list().find((record) => record.id === 'core-self-update')?.state, 'active');
      await opened.send('Apply the edits.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
      await until(() => revisions.length > 0, `${variant}: the committed update did not activate`, 10000);
      assert.deepEqual(revisions, [`${variant}-update`], 'notified exactly once');
    } finally {
      await opened.close();
      await page?.runtime.close?.();
    }
  });
}
