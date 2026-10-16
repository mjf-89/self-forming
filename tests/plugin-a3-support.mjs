// Test support for Track A step A3 (prompt sections as the essential built-in plugin
// core-prompt): opens the real session.js (offline demo model, memory storage) in fixed
// host configurations and reads back the rendered system prompt of each model request:
// the ordered section keys with a hash of each section's text, as pi-durable stored
// them (pi.system entries, cumulative `sections` diffs).
// Scenarios: the main conversation; owned helper conversations (subagent-like) with a
// selected context, with a transcript, and an old helper with instructions and no
// selection (null); plus a real `subagent run` through the OpenAI provider fixture
// (native/browser), whose child request body carries the full system prompt text.
// Mocked hosts only: no Android device, network, account or real execution service.
import { createHash } from 'node:crypto';
import { until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS as A2_CONFIGURATIONS } from './plugin-a2-support.mjs';

// A fixed, clearly dummy project guide (self-forming/AGENTS.md through the bridge), so
// the agents-guide section is rendered in configurations that read it.
export const GUIDE = '# Test guide\n\nKeep things plain. Dummy guidance for the A3 prompt snapshot.';
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A2 configurations whose bridge also answers workspace.read for the project guide. */
export const CONFIGURATIONS = Object.fromEntries(Object.entries(A2_CONFIGURATIONS).map(([name, make]) => [name, () => {
  const configuration = make();
  const bridge = configuration.options.bridge;
  if (bridge) configuration.options.bridge = { ...bridge, async call(method, params) {
    if (method === 'workspace.read' && params?.path === 'self-forming/AGENTS.md') return { text: GUIDE };
    return bridge.call(method, params);
  } };
  return configuration;
}]));

const ROLE = 'You are a subagent helping the main assistant on the user\'s Android device. Do the task you are given and answer with a concise report of what you did and found. You cannot talk to the user.';
/**
 * Helper conversations, written as subagents.js / earlier app versions wrote them:
 * change = configure() input, prompt = configurePrompt() input (undefined: never adopted).
 */
export const HELPERS = {
  subagentSections: {
    change: { instructions: `${ROLE}\n\nCheck the files.`, extensions: { remove: [{ name: 'self-forming-subagents' }] }, tools: ['read', 'write', 'edit', 'bash', 'manage_server'].map((name) => ({ name })) },
    prompt: { sections: ['device', 'app', 'selfRebuild', 'servers', 'agentsGuide'] }
  },
  subagentTranscript: {
    change: { instructions: ROLE, extensions: { remove: [{ name: 'self-forming-subagents' }] } },
    prompt: { sections: ['device', 'transcript'], transcript: 'User: please tidy the notes\nAssistant: I will ask a helper.' }
  },
  subagentDefault: {
    change: { instructions: ROLE, extensions: { remove: [{ name: 'self-forming-subagents' }] } },
    prompt: { sections: ['device'] }
  },
  oldHelper: {
    // An earlier app version: complete prompt in instructions, no PromptSelectionDoc.
    change: { instructions: 'You are an old helper. Your whole prompt is here.', tools: ['read', 'workspace_read'].map((name) => ({ name })) },
    prompt: undefined
  }
};
export const SCENARIOS = ['main', ...Object.keys(HELPERS)];

/** Ordered rendered sections of every request of one conversation: [[[key, hash, length], ...], ...]. */
export async function renderedSections(storage, conversationId, context, { text = false } = {}) {
  const entries = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  entries.sort((a, b) => a.id - b.id);
  const sections = new Map();
  const requests = [];
  for (const record of entries) {
    if (record.kind !== 'pi.system') continue;
    const full = (await storage.entry?.(record.id, context))?.entry ?? record;
    let changed = false;
    for (const message of full.model ?? []) {
      if (message.role !== 'system' || message.sections === undefined) continue;
      changed = true;
      for (const [key, value] of Object.entries(message.sections)) value === null ? sections.delete(key) : sections.set(key, value);
    }
    if (!changed && requests.length) continue;
    requests.push([...sections].map(([key, value]) => text ? [key, value] : [key, sha(value), value.length]));
  }
  return requests;
}

async function seedHelpers({ pd, ai, chord }, storage, configurePrompt, cwd, helpers) {
  const context = chord.BACKGROUND_CONTEXT;
  const Seed = pd.defineTask({
    name: 'plugin-a3.seed', version: 1, initial: () => ({ phase: 'done' }),
    phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  });
  const registry = pd.createRegistry();
  registry.install(pd.defineExtension({ name: 'plugin-a3-seed', tasks: [Seed] }));
  const seed = await pd.Harness.open(storage, { models: ai.createModels(), registry }, context);
  const root = await seed.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, ...(cwd ? { cwd } : {}), instructions: null } });
  const ids = {}, tasks = [];
  for (const [name, helper] of Object.entries(helpers)) {
    ids[name] = await seed.commit(async (tx) => {
      const task = await tx.createTask(Seed, null, { ownership: { kind: 'conversation' }, conversationId: root.id, background: true });
      tasks.push(task);
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task } });
      await pd.configure(tx, child.id, helper.change);
      if (helper.prompt) await configurePrompt(tx, child.id, helper.prompt);
      return child.id;
    }, context);
  }
  // The seed task (an anchor, as subagents.js uses) ends at once; the app never sees it running.
  for (const task of tasks) await seed.waitForTask(task, context);
  await seed.close(context);
  return ids;
}
/**
 * Opens session.js in one configuration and returns, per scenario, the rendered
 * sections of the first model request: {main: [[key, hash, length]...], subagentSections: ...}.
 */
export async function promptsFor(deps, name, { agentExtensions, onOpen, text = false, helpers = HELPERS } = {}) {
  const { pd, chord, session, prompts } = deps;
  const context = chord.BACKGROUND_CONTEXT;
  const { hostInfo, options } = CONFIGURATIONS[name]();
  const storage = new (class extends pd.MemoryStorage { async close() {} })();
  const { configurePrompt } = prompts.createPromptExtension({});
  const ids = await seedHelpers(deps, storage, configurePrompt, options.env?.cwd, helpers);
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  let opened;
  const result = {};
  try {
    opened = await session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, ...options, ...(agentExtensions ? { agentExtensions } : {}) });
    await onOpen?.(opened);
    const main = opened.snapshot.conversation.id;
    const before = opened.snapshot.messages.length;
    await opened.send('hello prompts');
    await until(() => !opened.snapshot.busy && opened.snapshot.messages.length > before + 1 && opened.snapshot.messages.at(-1)?.role === 'assistant', `main reply did not finish (${name})`);
    result.main = (await renderedSections(storage, main, context, { text }))[0];
    for (const [scenario, id] of Object.entries(ids)) {
      await opened.sendTo(id, `hello ${scenario}`);
      await until(async () => (await renderedSections(storage, id, context)).length > 0 && !opened.snapshot.anyBusy, `${scenario} reply did not finish (${name})`);
      result[scenario] = (await renderedSections(storage, id, context, { text }))[0];
    }
    return result;
  } finally {
    await opened?.close();
    globalThis.__piHostInfo = saved;
  }
}

// The real Pi OpenAI provider consumes this local SSE fixture (as in plugin-a2-core-tools).
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
  async getAccessToken() { return 'dummy-a3-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }]; },
  subscribe() { return () => {}; }
});
const systemText = (body) => body.input.filter((item) => ['developer', 'system'].includes(item.role))
  .map((item) => typeof item.content === 'string' ? item.content : item.content.map((part) => part.text ?? '').join('')).join('\n');

/**
 * A real subagent run (native/browser): the parent model calls subagent run with the
 * given context sections; returns hashes of the parent's and the child's system prompt
 * text exactly as sent to the provider, plus the child's section tags in order.
 */
export async function subagentRunFor(deps, name, { context: sections, agentExtensions, text = false, onOpen } = {}) {
  const { pd, session } = deps;
  const { hostInfo, options } = CONFIGURATIONS[name]();
  const bodies = { parent: [], child: [] };
  let parentCalls = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are (the|a) subagent/.test(JSON.stringify(item)));
    (child ? bodies.child : bodies.parent).push(body);
    if (child) return response('child done');
    parentCalls++;
    if (parentCalls === 1) return response('', { name: 'subagent', args: { action: 'run', message: 'Check the files.', context: sections } });
    return response('done');
  };
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const opened = await session.openAppSession({ storage: new pd.MemoryStorage(), toolchain: false, ...options, chatgpt: auth(), fetch, ...(agentExtensions ? { agentExtensions } : {}) });
  try {
    await onOpen?.(opened);
    await opened.send('Delegate this.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => parentCalls >= 2 && !opened.snapshot.busy, `subagent run did not finish (${name})`, 20000);
    const describe = (body) => {
      const prompt = systemText(body);
      const tags = [...prompt.matchAll(/^<([a-z][a-z0-9_-]*)>$/gm)].map((match) => match[1]);
      return text ? { tags, prompt } : { tags, hash: sha(prompt), length: prompt.length };
    };
    return { parent: describe(bodies.parent[0]), child: describe(bodies.child[0]) };
  } finally {
    await opened.close();
    globalThis.__piHostInfo = saved;
  }
}
