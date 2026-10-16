import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

let openAppSession, createServerExtension;
before(async () => {
  await mkdir('.test-build', { recursive: true });
  await build({ entryPoints: { 'recovery-session': 'apps/common/session.js', 'recovery-servers': 'plugins/core-servers/web/servers.js' },
    outdir: '.test-build', bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
    packages: 'external', target: 'node24', plugins: [{ name: 'fixed-browser-imports', setup(builder) {
      builder.onResolve({ filter: /^(\.\/|(\.\.\/)+)library\// }, args => ({ path: '@earendil-works/' + args.path.slice(args.path.indexOf('library/') + 8).replace(/\.js$/, ''), external: true }));
      builder.onResolve({ filter: /^\.\/native-host\.js$/ }, () => ({ path: resolve('packages/native-host/src/index.ts') }));
    } }] });
  ({ openAppSession } = await import(pathToFileURL(resolve('.test-build/recovery-session.mjs')).href));
  ({ createServerExtension } = await import(pathToFileURL(resolve('.test-build/recovery-servers.mjs')).href));
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(10);
  }
  assert.fail(message);
}
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

// The real Pi provider consumes this local SSE fixture. No account, socket, command, or network is used.
let responseId = 0;
function response(text, tool) {
  const id = ++responseId;
  const item = tool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: tool.name,
    arguments: JSON.stringify(tool.args), status: 'completed' } : {
    type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }]
  };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...tool ? [] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item],
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const auth = () => ({
  async getAccessToken() { return 'dummy-recovery-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }, { id: 'gpt-4.1-mini', name: 'Helper model' }]; },
  subscribe() { return () => {}; }
});
function fakeEnvironment() {
  return {
    cwd: '/workspace', backgroundExecution: true, sessions: new Set(), launches: 0, commands: [],
    async exec(command, options = {}, callContext = context) {
      callContext.abortSignal?.throwIfAborted();
      this.commands.push(command);
      const result = (exitCode = 0, output = '') => {
        if (output) options.onOutput?.(output);
        return { ok: true, value: { exitCode } };
      };
      const name = command.match(/(?:-t '=|-s ')(srv-\d+)'/)?.[1];
      if (command.includes('has-session')) return this.sessions.has(name) ? result() : result(1, `can't find session: ${name}`);
      if (command.includes('new-session')) {
        assert.ok(name); assert.ok(!this.sessions.has(name));
        this.sessions.add(name); this.launches++;
      }
      if (command.includes('kill-session')) this.sessions.delete(name);
      if (command.includes('secrets-wait') && command.startsWith('[ -f')) return result(1);
      return result();
    }
  };
}
async function fixture(t) {
  const directory = await mkdtemp(resolve('.test-build/recovery-'));
  const database = resolve(directory, 'session.sqlite');
  const env = fakeEnvironment();
  let session;
  t.after(async () => { await session?.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    database, env,
    async open(options = {}) {
      session = await openAppSession({ env, toolchain: false, demoTokensPerSecond: 0,
        fetch: () => { throw new Error('Unexpected model request'); }, ...options, storage: await openNodeSqliteStorage(database) });
      return session;
    },
    async close() { const current = session; session = undefined; await bounded(current.close(), 'Session close deadlocked'); },
    async inspect() {
      const storage = await openNodeSqliteStorage(database);
      const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
      try {
        return { inspected: await harness.inspect(context),
          conversations: (await storage.scanConversations({}, 100, undefined, context)).items,
          entries: (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, context)).items,
          tasks: (await storage.scanTasks({}, 100, undefined, context)).items };
      } finally { await harness.close(context); }
    },
    async seedServer() {
      let harness;
      const extension = createServerExtension({ rootConversationId: ROOT_CONVERSATION_ID,
        abortTask: (id, scope) => harness.abortTask(id, scope) });
      const registry = createRegistry(); registry.install(extension);
      harness = await Harness.open(await openNodeSqliteStorage(database), { models: createModels(), registry, env: () => env }, context);
      try {
        const root = await harness.root(context);
        const result = await extension.tools[0].execute({ action: 'start', name: 'saved-server', command: 'fake-serve' }, {
          env, agent: scope => root.agent(scope), snapshot: (doc, scope) => harness.snapshot(doc, scope),
          getTask: (id, scope) => harness.getTask(id, scope), waitForTask: (id, scope) => harness.waitForTask(id, scope),
          commit: (fn, scope) => harness.commit(fn, scope)
        }, context);
        return result.details.taskId;
      } finally { await harness.close(context); }
    }
  };
}

test('saved background helper resumes automatically despite its foreground generation flag', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
  const childStarted = Promise.withResolvers();
  let parentCalls = 0;
  let session = await saved.open({ chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.input.some(item => ['developer', 'system'].includes(item.role) && JSON.stringify(item).includes('You are the subagent'))) {
      assert.equal(body.model, 'gpt-4.1-mini');
      childStarted.resolve();
      return waitForAbort(init.signal);
    }
    if (++parentCalls === 1) return response('', { name: 'subagent', args: { action: 'spawn', name: 'worker',
      message: 'Finish the independent work.', model: 'openai-chatgpt/gpt-4.1-mini', thinking: 'off', tools: [], context: ['device'] } });
    return response('Main remains available.');
  } });
  await session.send('Delegate the independent work.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
  await bounded(childStarted.promise, 'Background helper did not request a model');
  await until(() => session.snapshot, state => !state.busy && state.messages.some(message => message.text === 'Main remains available.'), 'Main did not finish while helper was running');
  await saved.close();
  const before = await saved.inspect();
  const child = before.conversations.find(item => item.owner);
  assert.ok(child, 'Spawn created a durable child conversation');
  const generation = before.inspected.tasks.find(item => item.record.conversationId === child.id && item.record.kind === 'pi.generation');
  assert.ok(generation);
  assert.equal(generation.record.background, false, 'The generation itself is foreground inside its owned conversation');
  const owner = before.tasks.find(task => task.id === child.owner.taskId);
  assert.equal(owner.background, true, 'Its ownership anchor is background work');

  const recovered = [];
  session = await saved.open({ chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body); recovered.push(body);
    return response(body.model === 'gpt-4.1-mini' ? 'Background work recovered.' : 'Main received the background report.');
  } });
  await until(() => session.snapshot, state => state.messages.some(message => message.text === 'Main received the background report.'), 'Saved helper did not resume and report automatically');
  assert.equal(recovered.filter(body => body.model === 'gpt-4.1-mini').length, 1);
  assert.equal(recovered.filter(body => body.model === 'gpt-4.1').length, 1);
  assert.equal(session.snapshot.paused, false);
  const tree = await session.tree();
  assert.equal(tree.find(item => item.id === child.id).busy, false);
  assert.equal(tree.filter(item => item.kind === 'subagent').length, 1, 'Recovery does not duplicate the helper');
  assert.equal(session.snapshot.messages.filter(message => message.role === 'user' && message.text.startsWith('[subagent worker answered]')).length, 1);
});

test('app update commits while viewing a busy helper, then unfinished work resumes from SQLite', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
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
  let session = await saved.open({ appRevision, chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-4.1-mini') {
      childStarted.resolve();
      try { return await waitForAbort(init.signal); }
      finally { childInterrupted = true; }
    }
    if (++parentCalls === 1) return response('', { name: 'subagent', args: { action: 'spawn', name: 'worker',
      message: 'Keep working across the app update.', model: 'openai-chatgpt/gpt-4.1-mini', thinking: 'off', tools: [], context: ['device'] } });
    if (parentCalls === 2) return response('', { name: 'app_update', args: { action: 'apply' } });
    return response('The updated app received the helper report.');
  } });
  const mainId = session.snapshot.conversation.id;
  await session.send('Start a helper, then apply the app edits.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
  await bounded(Promise.all([childStarted.promise, staging.promise]), 'Helper or update did not start');
  assert.equal(activations, 0, 'Staging alone must never activate an update');
  const child = (await session.tree()).find(item => item.kind === 'subagent');
  assert.ok(child);
  await session.switchConversation(child.id);
  assert.equal(session.snapshot.busy, true);
  allowStage.resolve();
  assert.equal(await bounded(activation.promise, 'Update waited for the busy helper'), 'saved-update');
  assert.equal(session.snapshot.conversation.id, child.id, 'Activation is independent of the selected conversation');
  assert.equal(session.snapshot.busy, true);
  assert.equal(childInterrupted, false, 'Activation notification does not wait for child completion');
  await saved.close();
  assert.equal(childInterrupted, true, 'Closing interrupts the in-flight request');
  const before = await saved.inspect();
  const update = before.entries.find(entry => entry.kind === 'pi.tool-result' && entry.model?.[0]?.toolName === 'app_update');
  assert.equal(update?.model[0].details?.revision, 'saved-update', 'The successful update result is durably saved before closing');
  assert.equal(update.model[0].isError, false);
  assert.equal(before.tasks.find(task => task.id === update.byTaskId)?.state.status, 'terminal');
  assert.ok(before.inspected.tasks.some(task => task.record.conversationId === child.id), 'Unfinished child stays durable');

  const recovered = [];
  session = await saved.open({ appRevision, chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body); recovered.push(body);
    return response(body.model === 'gpt-4.1-mini' ? 'Helper finished after reload.' : 'The updated app received the helper report.');
  } });
  await session.switchConversation(mainId);
  await until(() => session.snapshot, state => state.messages.some(message => message.text === 'The updated app received the helper report.'),
    'Helper did not resume and report after update reload');
  assert.equal(recovered.filter(body => body.model === 'gpt-4.1-mini').length, 1);
  assert.equal(stageCalls, 1, 'The saved app_update tool does not execute again after reload');
  assert.equal(activations, 1, 'The committed update notifies exactly once');
  assert.equal(session.snapshot.messages.filter(message => message.text.startsWith('[subagent worker answered]')).length, 1);
});

test('missing API key leaves saved work pending until Resume without blocking a saved server', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
  const started = Promise.withResolvers();
  let session = await saved.open({ fetch: async (_url, init) => { started.resolve(); return waitForAbort(init.signal); } });
  await session.send('Continue after restart.', { mode: 'openai', apiKey: 'dummy-key-before-close' });
  await bounded(started.promise, 'Initial model request did not start');
  await saved.close();
  const serverTask = await saved.seedServer();
  let requests = 0;
  session = await saved.open({ fetch: async () => { requests++; return response('Recovered with the new key.'); } });
  await until(() => session.snapshot, state => state.paused && state.recoveryProviders.includes('openai'), 'Missing credentials did not wait');
  await until(() => saved.env.launches, count => count === 1, 'Server supervisor did not resume while the model awaited credentials');
  assert.equal(requests, 0, 'No model request is sent without restored credentials');
  assert.equal(saved.env.sessions.has(`srv-${serverTask}`), true);
  assert.equal(session.snapshot.messages.some(message => message.error), false);
  await session.resume({ mode: 'openai', apiKey: 'dummy-key-after-close' });
  await until(() => session.snapshot, state => !state.busy && state.messages.some(message => message.text === 'Recovered with the new key.'), 'Resume did not release the stored generation');
  assert.equal(requests, 1);
  assert.equal(session.snapshot.paused, false);
  assert.equal(session.snapshot.messages.filter(message => message.role === 'user' && message.text === 'Continue after restart.').length, 1);
});

test('closing a credential wait preserves it and Stop settles it without a model request or deadlock', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
  const started = Promise.withResolvers();
  let session = await saved.open({ fetch: async (_url, init) => { started.resolve(); return waitForAbort(init.signal); } });
  await session.send('Pause me across restarts.', { mode: 'openai', apiKey: 'dummy-key' });
  await bounded(started.promise, 'Initial request did not start');
  await saved.close();
  session = await saved.open();
  await until(() => session.snapshot.paused, Boolean, 'Reopened input did not wait for credentials');
  await saved.close();
  assert.ok((await saved.inspect()).inspected.tasks.some(item => item.record.kind === 'pi.generation'), 'Closing an auth wait preserves the generation');
  session = await saved.open();
  await until(() => session.snapshot.paused, Boolean, 'Saved input did not wait on the second reopen');
  await bounded(session.stop(), 'Stop deadlocked on a credential wait');
  await until(() => session.snapshot, state => !state.busy && !state.paused, 'Stop did not settle saved work');
  await saved.close();
  const after = await saved.inspect();
  assert.equal(after.inspected.tasks.length, 0);
  assert.equal(after.inspected.submissions.length, 0);
  session = await saved.open();
  assert.equal(session.snapshot.busy, false);
  assert.equal(session.snapshot.paused, false);
});

test('a chat awaiting an API key does not block a different chat using restored ChatGPT credentials', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
  const started = Promise.withResolvers();
  let session = await saved.open({ fetch: async (_url, init) => { started.resolve(); return waitForAbort(init.signal); } });
  const waitingId = session.snapshot.conversation.id;
  await session.send('Keep the original request saved.', { mode: 'openai', apiKey: 'dummy-old-key' });
  await bounded(started.promise, 'Original API-key request did not start');
  await saved.close();

  const requests = [];
  session = await saved.open({ chatgpt: auth(), fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    assert.equal(body.model, 'gpt-4.1', 'The old API-key request must not be sent');
    return response('The independent chat completed.');
  } });
  await until(() => session.snapshot, state => state.paused && state.recoveryProviders.includes('openai'), 'Original chat did not wait for its key');
  await session.newThread();
  const activeId = session.snapshot.conversation.id;
  assert.notEqual(activeId, waitingId);
  assert.equal(session.snapshot.busy, false);
  await session.send('Answer this independent question.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
  await until(() => session.snapshot, state => !state.busy && state.messages.some(message => message.text === 'The independent chat completed.'), 'A credential wait in another chat blocked the independent reply');
  assert.equal(requests.length, 1);
  assert.equal(session.snapshot.paused, true, 'The global credential notice still reflects the original pending request');
  assert.deepEqual(session.snapshot.recoveryProviders, ['openai']);
  const tree = await session.tree();
  assert.equal(tree.find(item => item.id === waitingId).busy, true);
  assert.equal(tree.find(item => item.id === activeId).busy, false);
  await saved.close();
  const after = await saved.inspect();
  assert.ok(after.inspected.tasks.some(item => item.record.conversationId === waitingId && item.record.kind === 'pi.generation'), 'Independent work must preserve the original saved generation');
  assert.equal(after.inspected.tasks.some(item => item.record.conversationId === activeId), false);
});

test('an idle saved helper accepts a new key after reopening and sendTo waits for credentials without changing its model', { timeout: 20000 }, async t => {
  const saved = await fixture(t);
  let parentCalls = 0;
  let session = await saved.open({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-4.1-mini') return response('Initial helper work completed.');
    if (++parentCalls === 1) return response('', { name: 'subagent', args: { action: 'spawn', name: 'saved-helper',
      message: 'Finish the original assignment.', model: 'openai/gpt-4.1-mini', thinking: 'off', tools: [], context: ['device'] } });
    return response('Main received the result.');
  } });
  await session.send('Create a helper for later follow-ups.', { mode: 'openai', modelId: 'gpt-4.1', apiKey: 'dummy-initial-key' });
  await until(() => session.snapshot, state => !state.busy && state.messages.some(message => message.role === 'user' && message.text.startsWith('[subagent saved-helper answered]')), 'Original helper did not complete and report');
  const child = (await session.tree()).find(item => item.kind === 'subagent');
  assert.ok(child);
  assert.equal(child.busy, false);
  assert.equal(child.model, 'openai/gpt-4.1-mini');
  await saved.close();
  assert.equal((await saved.inspect()).inspected.tasks.length, 0, 'No pending request should register this model automatically on reopen');

  const direct = [];
  session = await saved.open({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body); direct.push(body);
    return response('Owned conversation follow-up completed.');
  } });
  await session.switchConversation(child.id);
  await session.send('Use the newly supplied credential.', {
    mode: 'openai', modelId: 'gpt-4.1', apiKey: 'dummy-follow-up-key'
  });
  await until(() => session.snapshot, state => !state.busy && state.messages.some(message => message.text === 'Owned conversation follow-up completed.'), 'Reopened idle helper could not use the supplied key');
  assert.equal(direct.length, 1);
  assert.equal(direct[0].model, 'gpt-4.1-mini', 'Credential configuration must not replace the helper model');
  assert.equal(session.snapshot.modelId, 'gpt-4.1-mini');
  await saved.close();

  const resumed = [];
  session = await saved.open({ fetch: async (_url, init) => {
    const body = JSON.parse(init.body); resumed.push(body);
    return response('Queued helper follow-up resumed.');
  } });
  await session.sendTo(child.id, 'Wait for a new key before answering.');
  await until(() => session.snapshot, state => state.paused && state.recoveryProviders.includes('openai'), 'sendTo did not wait for the missing key');
  assert.equal(resumed.length, 0);
  assert.equal((await session.tree()).find(item => item.id === child.id).busy, true);
  await session.resume({ mode: 'openai', modelId: 'gpt-4.1', apiKey: 'dummy-resumed-key' });
  await until(() => session.tree(), tree => !tree.find(item => item.id === child.id).busy, 'Resume did not continue the saved helper input');
  await session.switchConversation(child.id);
  await until(() => session.snapshot, state => state.messages.some(message => message.text === 'Queued helper follow-up resumed.'), 'Resumed helper answer was not committed');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].model, 'gpt-4.1-mini');
  assert.equal(session.snapshot.paused, false);
  assert.equal(session.snapshot.messages.some(message => message.error), false);
});
