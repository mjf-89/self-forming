// Test support for Track A step A4 (supervised servers as the essential built-in
// core-servers, servers@1). Mocked hosts only: the execution environment is an
// in-memory fake whose exec() answers the tmux/curl/tail protocol of servers.js in
// JavaScript. No process is started, no tmux server (and never the real
// "sf-servers" socket), network, account or device is used.
import { CONFIGURATIONS } from './plugin-a2-support.mjs';

/**
 * Turns an execution environment into a tmux fake. Sessions live in `state.sessions`
 * (only on the shared "-L sf-servers" socket, as servers.js launches them); every
 * command is recorded. curl health checks answer while the server's session exists.
 */
export function tmuxFake(env) {
  const state = { sessions: new Set(), launches: [], kills: [], commands: [], logText: 'line one\nline two\n' };
  env.exec = async (command, options = {}, callContext) => {
    callContext?.abortSignal?.throwIfAborted?.();
    state.commands.push(command);
    const out = (exitCode = 0, text = '') => {
      if (text) options.onOutput?.(text);
      return { ok: true, value: { exitCode } };
    };
    // Never a real process: this fake is the only exec of the environment.
    const session = command.match(/(?:-t '=|-s ')(srv-[^'\s]+)'/)?.[1];
    const shared = command.includes('-L sf-servers');
    if (command.includes('has-session')) {
      return shared && state.sessions.has(session) ? out() : out(1, `can't find session: ${session}`);
    }
    if (command.includes('kill-session')) {
      if (shared && state.sessions.delete(session)) state.kills.push(session);
      return out();
    }
    if (command.includes('new-session')) {
      state.sessions.add(session);
      state.launches.push(session);
      return out();
    }
    if (command.startsWith('curl ')) return out(state.sessions.size ? 0 : 7);
    if (command.startsWith('[ -f')) return out(1); // no secrets wait file
    if (command.includes('tail -n')) return out(0, state.logText);
    return out(); // tmux install check, launcher script write, mkdir, skill mirror, ...
  };
  return state;
}

/** The native configuration of plugin-a2-support.mjs with a tmux fake as its environment. */
export function nativeWithServers() {
  const configuration = CONFIGURATIONS.native();
  const tmux = tmuxFake(configuration.options.env);
  return { ...configuration, tmux };
}

/**
 * Seeds `storage` the way an app version before A4 left it: servers.js's own
 * extension in a plain registry, servers started with the manage_server tool while the
 * scheduler never ran, so their Server tasks are persisted as pending.
 * Returns {[name]: taskId}.
 */
export async function seedPendingServers({ pd, ai, chord, servers }, storage, env, names) {
  const context = chord.BACKGROUND_CONTEXT;
  const registry = pd.createRegistry();
  let harness;
  const extension = servers.createServerExtension({ rootConversationId: pd.ROOT_CONVERSATION_ID, abortTask: (id, ctx) => harness.abortTask(id, ctx) });
  registry.install(extension);
  harness = await pd.Harness.open(storage, { models: ai.createModels(), registry, env: () => env }, context);
  const root = await harness.root(context, { agent: { cwd: env.cwd } });
  const ids = {};
  try {
    for (const name of names) {
      const result = await extension.tools[0].execute({ action: 'start', name, command: `serve-${name}`, startGraceSeconds: 0 }, {
        env, agent: (ctx) => root.agent(ctx),
        snapshot: (doc, ctx) => harness.snapshot(doc, ctx),
        getTask: (id, ctx) => harness.getTask(id, ctx),
        waitForTask: (id, ctx) => harness.waitForTask(id, ctx),
        commit: (fn, ctx) => harness.commit(fn, ctx)
      }, context);
      ids[name] = result.details.taskId;
    }
    for (const id of Object.values(ids)) {
      const record = await harness.getTask(id, context);
      if (record.state.status !== 'pending' || record.kind !== 'self-forming.server') throw new Error(`seed task ${id} is not a pending Server task`);
    }
  } finally {
    await harness.close(context);
  }
  return ids;
}

/** Waits until the stored task satisfies predicate; returns the record. */
export async function taskWhen(storage, context, id, predicate, message, ms = 8000) {
  const deadline = Date.now() + ms;
  let record;
  while (Date.now() < deadline) {
    record = await storage.task(id, context);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(record?.state)}`);
}
export const healthy = (record) => record.state.status === 'running' && record.state.checkpoint?.phase === 'watch' && record.state.checkpoint.healthyAt !== undefined;

// The real Pi OpenAI provider consumes this local SSE fixture (as in plugin-a2-core-tools.test.mjs).
let responseId = 0;
export function response(text, tool) {
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
export const auth = () => ({
  async getAccessToken() { return 'dummy-a4-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }]; },
  subscribe() { return () => {}; }
});
