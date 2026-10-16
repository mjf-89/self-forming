import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import * as piDurable from '@earendil-works/pi-durable';
const { AgentDoc, Harness, MemoryStorage, createRegistry, defineDoc, defineExtension } = piDurable;

const context = BACKGROUND_CONTEXT;
// A5: the core-subagents plugin's implementation takes pi-durable/pi-ai as its pi bag (host.pi).
const source = await readFile(new URL('../plugins/core-subagents/web/subagents.js', import.meta.url), 'utf8');
const pi = { ...piDurable, Type };
const { createSubagentExtensions } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const Prompt = defineDoc({ kind: 'test.subagent-prompt', version: 1, scope: 'conversation', initial: () => ({}) });
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
const isChild = transcript => transcript.messages.some(message => message.role === 'system' && JSON.stringify(message).includes('You are a subagent')) ||
  transcript.messages.some(message => message.role === 'system' && JSON.stringify(message).includes('You are the subagent'));
const waitForAbort = signal => new Promise((_, reject) => {
  const rejectAbort = () => reject(signal.reason ?? new Error('Aborted'));
  if (signal.aborted) rejectAbort();
  else signal.addEventListener('abort', rejectAbort, { once: true });
});
async function until(predicate) {
  for (let count = 0; count < 500; count++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for local fixture');
}

async function fixture(t, { commands, child, intercept, delayReporter, afterAbortTask } = {}) {
  // Preserve the backend's durable records across independent Harness instances.
  class ReopenableMemoryStorage extends MemoryStorage { async close() {} }
  const storage = new ReopenableMemoryStorage();
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 0 });
  models.setProvider(faux.provider);
  let harness, root, extension;
  const childRequests = [];
  const respond = async (transcript, options) => {
    faux.appendResponses([respond]);
    if (isChild(transcript)) {
      childRequests.push(transcript);
      return child ? child(transcript, options, childRequests.length) : fauxAssistantMessage('Child completed');
    }
    const latestUser = transcript.messages.findLastIndex(message => message.role === 'user');
    const command = textOf(transcript.messages[latestUser]);
    const args = commands?.[command];
    if (args && !transcript.messages.slice(latestUser + 1).some(message => message.role === 'toolResult')) {
      return fauxAssistantMessage(fauxToolCall('subagent', args), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Parent completed');
  };
  faux.setResponses([respond]);
  const { SubagentTools, Subagents } = createSubagentExtensions({
    getTool: name => extension.tools.find(tool => tool.name === name),
    toolNames: () => extension.tools.map(tool => tool.name),
    resolveModel: async spec => spec === 'explicit' ? { provider: 'faux', modelId: 'faux-1' } : undefined,
    listModels: async () => 'same',
    clampThinking: (_model, level) => level,
    configurePrompt: async (tx, id, selection) => Object.assign(await tx.doc(Prompt, id), selection),
    abortTask: async (id, scope) => {
      const result = await harness.abortTask(id, scope);
      if (afterAbortTask) await afterAbortTask(id, scope);
      return result;
    },
    abortSubmission: (id, scope, conversationId) => harness.abortSubmission(id, scope, conversationId)
  }, pi);
  const tool = SubagentTools.tools[0];
  extension = defineExtension({ ...SubagentTools,
    tools: [{ ...tool, execute: async (args, api, scope) => {
      const result = await tool.execute(args, api, scope);
      if (intercept) await intercept(args, result, scope);
      return result;
    } }],
    tasks: SubagentTools.tasks.map(task => {
      if (!delayReporter || task.definition.name !== 'self-forming.subagent-reporter') return task;
      return { definition: { ...task.definition, phases: { ...task.definition.phases,
        deliver: async (running, runtime, scope) => {
          await delayReporter(running, scope);
          return task.definition.phases.deliver(running, runtime, scope);
        }
      } } };
    })
  });
  const registry = createRegistry(); registry.install(extension);
  const open = async () => {
    harness = await Harness.open(storage, { models, registry, settings: { extensions: [extension] } }, context);
    root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' } });
  };
  await open();
  t.after(() => harness.close(context));
  return {
    storage, childRequests,
    get harness() { return harness; },
    get root() { return root; },
    async registry() { return await harness.snapshot(Subagents, root.id, context); },
    async send(command) { return root.submit({ type: 'input', content: command }, context); },
    async restart() { await harness.close(context); await open(); harness.resume(); },
    async finished(id) {
      const settled = await (await harness.submission(id, context)).wait(context);
      assert.equal(settled.status, 'done');
      const entries = (await root.entries({}, 100, undefined, context)).items;
      for (const entry of entries) for (const message of entry.model ?? []) {
        if (message.role === 'toolResult') assert.equal(Boolean(message.isError), false, JSON.stringify(entry));
      }
      return settled;
    }
  };
}

test('foreground run resumes its original owned child and preserves model, thinking and prompt selection', async t => {
  let interrupted = true;
  const saved = await fixture(t, {
    commands: { run: { action: 'run', message: 'Do the child task', tools: [], context: ['device', 'transcript'], instructions: 'Extra guidance' } },
    child: async (_transcript, options) => {
      if (interrupted) return waitForAbort(options.signal);
      return fauxAssistantMessage('Resumed child answer');
    }
  });
  const submitted = await saved.send('run');
  await until(() => saved.childRequests.length === 1);
  const before = (await saved.storage.scanConversations({}, 100, undefined, context)).items.filter(record => record.owner);
  assert.equal(before.length, 1);
  const childId = before[0].id;
  const agent = await saved.harness.snapshot(AgentDoc, childId, context);
  assert.deepEqual(agent.model, { provider: 'faux', modelId: 'faux-1' });
  assert.equal(agent.thinkingLevel, 'high');
  assert.deepEqual(agent.tools, []);
  assert.match(agent.instructions, /Extra guidance/);
  assert.doesNotMatch(agent.instructions, /Recent conversation|User: run/);
  const prompt = await saved.harness.snapshot(Prompt, childId, context);
  assert.deepEqual(prompt.sections, ['device', 'transcript']);
  assert.match(prompt.transcript, /User: run/);
  interrupted = false;
  await saved.restart();
  await saved.finished(submitted.id);
  const after = (await saved.storage.scanConversations({}, 100, undefined, context)).items.filter(record => record.owner);
  assert.deepEqual(after.map(record => record.id), [childId]);
  const entries = (await saved.storage.scanEntries({ conversationId: childId }, 100, undefined, context)).items;
  assert.equal(entries.filter(entry => entry.kind === 'pi.user').length, 1);
  assert.equal(saved.childRequests.length, 2);
});

test('spawn and send admission receipts prevent duplicate background messages after restart', async t => {
  let pauseAction = 'spawn';
  let admitted = false;
  const saved = await fixture(t, {
    commands: {
      spawn: { action: 'spawn', name: 'worker', message: 'First request', tools: [] },
      send: { action: 'send', name: 'worker', message: 'Second request', followUp: true }
    },
    intercept: async (args, _result, scope) => {
      if (args.action === pauseAction) { admitted = true; await waitForAbort(scope.abortSignal); }
    }
  });
  for (const command of ['spawn', 'send']) {
    pauseAction = command; admitted = false;
    const submitted = await saved.send(command);
    await until(() => admitted);
    pauseAction = undefined;
    await saved.restart();
    await saved.finished(submitted.id);
    await until(async () => Object.keys((await saved.registry()).reporters).length === 0);
  }
  const agents = (await saved.registry()).agents;
  assert.deepEqual(Object.keys(agents), ['worker']);
  const entries = (await saved.storage.scanEntries({ conversationId: agents.worker.conversationId }, 100, undefined, context)).items;
  assert.deepEqual(entries.filter(entry => entry.kind === 'pi.user').map(entry => textOf(entry.model[0])).sort(), ['First request', 'Second request']);
  assert.equal(saved.childRequests.length, 2);
});

test('Stop cancels a reporter before delivery and a later send can start fresh work', async t => {
  let waiting = false;
  const saved = await fixture(t, {
    commands: {
      spawn: { action: 'spawn', name: 'worker', message: 'Old request', tools: [] },
      stop: { action: 'stop', name: 'worker' },
      send: { action: 'send', name: 'worker', message: 'New request' }
    },
    delayReporter: async (task, scope) => {
      if (task.input.message === 'Old request') { waiting = true; await waitForAbort(scope.abortSignal); }
    }
  });
  await saved.finished((await saved.send('spawn')).id);
  await until(() => waiting);
  await saved.finished((await saved.send('stop')).id);
  assert.equal(saved.childRequests.length, 0);
  assert.equal(Object.keys((await saved.registry()).reporters).length, 0);
  await saved.finished((await saved.send('send')).id);
  await until(() => saved.childRequests.length === 1);
  const childId = (await saved.registry()).agents.worker.conversationId;
  const entries = (await saved.storage.scanEntries({ conversationId: childId }, 100, undefined, context)).items;
  assert.deepEqual(entries.filter(entry => entry.kind === 'pi.user').map(entry => textOf(entry.model[0])), ['New request']);
});

test('replaying a completed Stop cannot abort newer work in the same child', async t => {
  let pauseStop = true, stopped = false, resumeChild = false;
  const saved = await fixture(t, {
    commands: {
      spawn: { action: 'spawn', name: 'worker', message: 'Initial request', tools: [] },
      stop: { action: 'stop', name: 'worker' }
    },
    child: async (transcript, options) => {
      if (transcript.messages.some(message => message.role === 'user' && textOf(message) === 'New direct request') && !resumeChild) return waitForAbort(options.signal);
      return fauxAssistantMessage('Child completed');
    },
    intercept: async (args, _result, scope) => {
      if (args.action === 'stop' && pauseStop) { stopped = true; await waitForAbort(scope.abortSignal); }
    }
  });
  await saved.finished((await saved.send('spawn')).id);
  await until(async () => Object.keys((await saved.registry()).reporters).length === 0);
  const stopping = await saved.send('stop');
  await until(() => stopped);
  const childId = (await saved.registry()).agents.worker.conversationId;
  const child = await saved.harness.conversation(childId, context);
  const newer = await child.submit({ type: 'input', content: 'New direct request' }, context);
  await until(() => saved.childRequests.length === 2);
  pauseStop = false; resumeChild = true;
  await saved.restart();
  await saved.finished(stopping.id);
  await saved.finished(newer.id);
  assert.equal(saved.childRequests.length, 3);
});

test('an interrupted Stop resumes captured cancellation without stopping a newer direct request', async t => {
  let cancelling = false, pauseCancellation = true, resumeChild = false;
  const saved = await fixture(t, {
    commands: {
      spawn: { action: 'spawn', name: 'worker', message: 'Initial request', tools: [] },
      stop: { action: 'stop', name: 'worker' }
    },
    child: async (transcript, options) => {
      if (transcript.messages.some(message => message.role === 'user' && /direct request/.test(textOf(message))) && !resumeChild) return waitForAbort(options.signal);
      return fauxAssistantMessage('Child completed');
    },
    afterAbortTask: async (_id, scope) => {
      if (pauseCancellation) { cancelling = true; await waitForAbort(scope.abortSignal); }
    }
  });
  await saved.finished((await saved.send('spawn')).id);
  await until(async () => Object.keys((await saved.registry()).reporters).length === 0);
  const childId = (await saved.registry()).agents.worker.conversationId;
  const child = await saved.harness.conversation(childId, context);
  const old = await child.submit({ type: 'input', content: 'Old direct request' }, context);
  await until(() => saved.childRequests.length === 2);
  const stopping = await saved.send('stop');
  await until(() => cancelling);
  assert.equal((await old.wait(context)).status, 'unanswered');
  const newer = await child.submit({ type: 'input', content: 'New direct request' }, context);
  await until(() => saved.childRequests.length === 3);
  pauseCancellation = false; resumeChild = true;
  await saved.restart();
  await saved.finished(stopping.id);
  await saved.finished(newer.id);
  assert.equal(saved.childRequests.length, 4);
});
