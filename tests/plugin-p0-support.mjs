// Test support for step P0 of docs/plugins-providers-agent-core.md: pins today's model
// provider behaviour (offline, openai, chatgpt, claude) of the real session.js and
// model-error.js before any provider code moves (P1a/P1b/P2/P3).
// Mocked hosts only (A2 CONFIGURATIONS): fake credential controllers with clearly dummy
// tokens and fake fetch transports that answer with local SSE fixtures (OpenAI Responses
// and Anthropic Messages). No Android device, network, account or real credential.
// Everything recorded is deterministic: no timestamps, random ids, entry ids or prompt
// texts (prompts and tools are pinned by A2/A3; here only their shape is recorded).
import { until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';

// Clearly dummy credentials. The Claude one has the OAuth prefix the real controller's
// tokens carry, so the Anthropic client takes the same (OAuth) path as on the phone.
export const TOKENS = {
  chatgpt: 'test-token-not-real-chatgpt-0001',
  claude: 'sk-ant-oat01-test-token-not-real-claude-0001',
  openai: 'sk-test-key-not-real-openai-0001'
};
export const CHATGPT_MODELS = [{ id: 'gpt-5', name: 'Main model' }, { id: 'gpt-4.1-mini', name: 'Helper model' }, { id: 'gpt-account-only', name: 'Account only' }];
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * A fake page-owned credential controller (the shape of native-host createChatGPTAuth /
 * createClaudeAuth as session.js uses it). Signed out: getAccessToken throws like the real
 * controller ("throw") or resolves undefined ("empty"). subscribe calls the listener at
 * once with the current state, as the real controllers do.
 */
export function fakeAccount(kind, { signedIn = true, signedOut = 'throw', models = CHATGPT_MODELS } = {}) {
  const listeners = new Set();
  let state = signedIn;
  const label = kind === 'claude' ? 'Claude' : 'ChatGPT';
  return {
    async getAccessToken() {
      if (state) return TOKENS[kind];
      if (signedOut === 'throw') throw new Error(`Sign in with ${label} before sending a message.`);
      return undefined;
    },
    async listModels() { return models.map((model) => ({ ...model })); },
    subscribe(listener) { listeners.add(listener); listener({ signedIn: state, busy: false }); return () => listeners.delete(listener); },
    signIn() { state = true; for (const listener of [...listeners]) listener({ signedIn: true, busy: false }); },
    get listeners() { return listeners.size; }
  };
}

// ---- fixtures: SSE answers -------------------------------------------------------
function sse(events, named) {
  const text = events.map((event) => `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
/** OpenAI Responses answer: text, or one function call ({name, args}). */
export function openaiAnswer(n, text, tool) {
  const item = tool ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
    : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...tool ? [] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }
  ], false);
}
/** Anthropic Messages answer: text, or one tool_use block ({name, args}). */
export function anthropicAnswer(n, text, tool, model = 'claude-sonnet-4-6') {
  const block = tool ? { type: 'tool_use', id: `toolu_${n}`, name: tool.name, input: {} } : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text };
  return sse([
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  ], true);
}
const isAnthropic = (url) => String(url).includes('anthropic.com');
const answer = (url, n, text, tool, model) => isAnthropic(url) ? anthropicAnswer(n, text, tool, model) : openaiAnswer(n, text, tool);
/** A 401 with a JSON error that echoes the credential (as some APIs do). */
export function unauthorized(token) {
  return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${token}. Header was Bearer ${token}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }),
    { status: 401, headers: { 'content-type': 'application/json' } });
}
export function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

// ---- request records -------------------------------------------------------------
// Header values that vary per run or per machine: names are kept, values are not.
const VOLATILE_HEADERS = /^(session_id|x-client-request-id|x-stainless-.*|user-agent)$/;
const VOLATILE_BODY = new Set(['prompt_cache_key', 'metadata']);
const mask = (value) => {
  let text = String(value);
  for (const [kind, token] of Object.entries(TOKENS)) text = text.split(token).join(`<${kind}-token>`);
  return text;
};
const textParts = (content) => typeof content === 'string' ? 'text' : (content ?? []).map((part) => part.type).join('+');
const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";
/** {url, method, headers (names), values (stable headers, credentials masked), body (shape)}. */
export function requestRecord(url, init = {}) {
  const headers = new Headers(init.headers);
  const names = [...headers.keys()].sort();
  const values = Object.fromEntries(names.filter((name) => !VOLATILE_HEADERS.test(name)).map((name) => [name, mask(headers.get(name))]));
  const raw = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  const body = {};
  if (raw) for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (VOLATILE_BODY.has(key)) body[key] = `<${typeof value}>`;
    else if (key === 'input' || key === 'messages') body[key] = value.map((item) => `${item.role ?? item.type}:${textParts(item.content)}`);
    else if (key === 'system') body[key] = (typeof value === 'string' ? [{ text: value }] : value).map((part) => part.text === CLAUDE_CODE ? part.text : `<prompt${part.cache_control ? ' cached' : ''}>`);
    else if (key === 'instructions') body[key] = '<prompt>';
    else if (key === 'tools') body[key] = value.map((tool) => tool.name);
    else body[key] = value;
  }
  return { url: String(url), method: init.method ?? 'GET', headers: names, values, body: JSON.parse(mask(JSON.stringify(body))) };
}
const leaks = (value) => Object.values(TOKENS).some((token) => JSON.stringify(value).includes(token) || JSON.stringify(value).includes(token.slice(8)));

/**
 * Fake model transport: records every request and answers through script(request, n)
 * -> Response | {text} | {tool} | 'hang'. Default: a text answer "reply n".
 */
export function fakeFetch(script = () => undefined) {
  const requests = [];
  let n = 0;
  const fetch = async (url, init = {}) => {
    const record = requestRecord(url, init);
    const raw = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    requests.push(record);
    const index = ++n;
    const step = await script({ url: String(url), init, body: raw, record }, index);
    if (step instanceof Response) return step;
    if (step === 'hang') return waitForAbort(init.signal);
    return answer(url, index, step?.text ?? `reply ${index}`, step?.tool, raw.model);
  };
  return { fetch, requests };
}

// ---- sessions and stored docs ----------------------------------------------------
/** Memory storage that survives session close (for reopening). */
export function keptStorage(pd) {
  return new (class extends pd.MemoryStorage { async close() {} })();
}
/**
 * An A2 configuration whose memory env readers also offer scanLines (the native env's
 * reader has it; the native read tool uses it), so file reads in the offline demo
 * work under the native configuration instead of failing in the fixture.
 */
function configuration(deps, name) {
  const made = CONFIGURATIONS[name]();
  const env = made.options.env;
  if (env && deps.env) {
    const open = env.openBinaryReader.bind(env);
    env.openBinaryReader = async (path, ...rest) => {
      const opened = await open(path, ...rest);
      if (!opened.ok) return opened;
      const reader = opened.value;
      return { ok: true, value: { ...reader, async scanLines(range) {
        const scanner = new deps.env.LineScanner(range.startLine, range.endLine);
        const read = await reader.read(0, 1024 * 1024);
        if (!read.ok) return read;
        scanner.push(read.value);
        return { ok: true, value: scanner.finish() };
      } } };
    };
  }
  return made;
}
/** Opens session.js in one A2 configuration with extra options. */
export async function openSession(deps, name, storage, options = {}) {
  const { hostInfo, options: base } = configuration(deps, name);
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  try {
    return await deps.session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, ...base, ...options });
  } finally {
    globalThis.__piHostInfo = saved;
  }
}
/** Reads stored docs with a bare Harness after the session closed. */
export async function storedDocs({ pd, ai, chord }, storage, ids = [1]) {
  const context = chord.BACKGROUND_CONTEXT;
  const ThreadsDoc = pd.defineDoc({ kind: 'self-forming.threads', version: 1, scope: 'session', initial: () => ({ selectedId: 1, nextThread: 1, threads: {} }) });
  const harness = await pd.Harness.open(storage, { models: ai.createModels(), registry: pd.createRegistry() }, context);
  try {
    const threads = await harness.snapshot(ThreadsDoc, context);
    const agents = {};
    for (const id of ids) {
      const agent = await harness.snapshot(pd.AgentDoc, id, context);
      agents[id] = agent ? { model: agent.model, thinkingLevel: agent.thinkingLevel } : null;
    }
    const conversations = [];
    let cursor;
    do {
      const page = await storage.scanConversations({}, 100, cursor, context);
      conversations.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    const owned = {};
    for (const record of conversations.filter((item) => item.owner).sort((a, b) => a.id - b.id)) {
      const agent = await harness.snapshot(pd.AgentDoc, record.id, context);
      owned[record.id] = { model: agent?.model, thinkingLevel: agent?.thinkingLevel };
    }
    return { modelSettings: Object.fromEntries(Object.entries(threads?.threads ?? {}).map(([id, thread]) => [id, thread.modelSettings])), agents, owned: Object.values(owned) };
  } finally {
    await harness.close(context);
  }
}
/** provider/api/model of every assistant message stored in one conversation, oldest first. */
export async function assistantModels({ chord }, storage, conversationId = 1) {
  const context = chord.BACKGROUND_CONTEXT;
  const entries = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  entries.sort((a, b) => a.id - b.id);
  const result = [];
  for (const record of entries) {
    const full = (await storage.entry?.(record.id, context))?.entry ?? record;
    for (const message of full.model ?? []) if (message.role === 'assistant') result.push(`${message.provider}/${message.api}/${message.model}${message.stopReason === 'error' ? '!' : ''}`);
  }
  return result;
}
/** Seeds a stored pi.agent for the main conversation (an earlier app version, no ThreadsDoc). */
export async function seedAgent({ pd, ai, chord }, storage, agent) {
  const context = chord.BACKGROUND_CONTEXT;
  const seed = await pd.Harness.open(storage, { models: ai.createModels(), registry: pd.createRegistry() }, context);
  const root = await seed.root(context);
  await root.configure(agent, context);
  await seed.close(context);
}
const view = (snapshot) => ({ mode: snapshot.mode, modelId: snapshot.modelId, thinkingEffort: snapshot.thinkingEffort, modelSettings: snapshot.modelSettings, paused: snapshot.paused, recoveryProviders: snapshot.recoveryProviders });
const messagesOf = (snapshot) => snapshot.messages.map((message) => `${message.role}${message.toolName ? `:${message.toolName}` : ''}${message.error ? '!' : ''}: ${mask(message.text)}`);
const errorText = (error) => mask(error instanceof Error ? error.message : String(error));
const finished = (opened, before) => !opened.snapshot.busy && !opened.snapshot.anyBusy && opened.snapshot.messages.length > before && opened.snapshot.messages.at(-1)?.role === 'assistant' && !opened.snapshot.messages.at(-1)?.pending;

// ---- static behaviour ------------------------------------------------------------
/** Exports, catalogs and the getThinkingEfforts matrix (no session). */
export async function staticBehaviour({ session, openaiModels, anthropicModels }) {
  const openai = Object.values(openaiModels.OPENAI_MODELS);
  const claude = Object.values(anthropicModels.ANTHROPIC_MODELS);
  const efforts = (mode, modelId) => session.getThinkingEfforts({ mode, modelId }).join(',') || '-';
  const matrix = {};
  for (const [mode, ids] of [
    ['offline', ['', 'faux-1', 'gpt-5']],
    ['openai', ['', ...openai.map((model) => model.id), 'unknown-model', ' gpt-5 ']],
    ['chatgpt', ['', ...openai.map((model) => model.id), 'gpt-account-only']],
    ['claude', ['', ...claude.map((model) => model.id), 'unknown-model']],
    ['llama-local', ['', 'gpt-5', 'claude-sonnet-4-6']],
    [undefined, ['', 'gpt-5']]
  ]) matrix[String(mode)] = Object.fromEntries(ids.map((id) => [id === '' ? '(empty)' : id, efforts(mode, id)]));
  return {
    exports: Object.keys(session).sort(),
    DEFAULT_OPENAI_MODEL: session.DEFAULT_OPENAI_MODEL,
    DEFAULT_CLAUDE_MODEL: session.DEFAULT_CLAUDE_MODEL,
    CLAUDE_MODELS: session.CLAUDE_MODELS,
    openaiCatalog: openai.map((model) => `${model.id}|${model.api}|${model.provider}|${model.reasoning ? 'reasoning' : '-'}`),
    claudeCatalog: claude.map((model) => `${model.id}|${model.api}|${model.provider}|${model.reasoning ? 'reasoning' : '-'}`),
    thinkingEfforts: matrix
  };
}

// ---- modelSettings normalization (setModelSettings, snapshot, ThreadsDoc) ---------
export const SETTINGS_INPUTS = {
  offlineWithExtras: { mode: 'offline', modelId: 'gpt-5', thinkingEffort: 'high' },
  openaiDefault: { mode: 'openai', modelId: '', thinkingEffort: '' },
  openaiReasoning: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: 'high' },
  openaiTrimmed: { mode: 'openai', modelId: '  gpt-5  ', thinkingEffort: 'minimal' },
  openaiBadEffort: { mode: 'openai', modelId: 'gpt-4.1-mini', thinkingEffort: 'high' },
  openaiUnknownModel: { mode: 'openai', modelId: 'not-a-model', thinkingEffort: 'high' },
  chatgptDefault: { mode: 'chatgpt', modelId: '', thinkingEffort: 'high' },
  chatgptReasoning: { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: 'low' },
  chatgptAccountOnly: { mode: 'chatgpt', modelId: 'gpt-account-only', thinkingEffort: 'low' },
  claudeDefault: { mode: 'claude', modelId: '', thinkingEffort: 'high' },
  claudeHaiku: { mode: 'claude', modelId: 'claude-haiku-4-5', thinkingEffort: 'medium' },
  claudeBogusEffort: { mode: 'claude', modelId: 'claude-sonnet-4-6', thinkingEffort: 'ultra' },
  unknownMode: { mode: 'llama-local', modelId: 'llama-3', thinkingEffort: 'high' },
  missingMode: { modelId: 'gpt-5', thinkingEffort: 'high' },
  nonStringModel: { mode: 'openai', modelId: 42, thinkingEffort: 'high' },
  longModelId: { mode: 'chatgpt', modelId: `x${'y'.repeat(400)}`, thinkingEffort: '' },
  extraFields: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: 'high', apiKey: TOKENS.openai, label: 'ignored' },
  empty: {}
};
export async function modelSettingsBehaviour(deps) {
  const storage = keptStorage(deps.pd);
  const result = {};
  let opened = await openSession(deps, 'offline', storage);
  try {
    result.initial = view(opened.snapshot);
    for (const [name, input] of Object.entries(SETTINGS_INPUTS)) {
      const optimistic = opened.setModelSettings(input);
      const immediate = opened.snapshot.modelSettings;
      // P3: a mode no provider row owns is refused before anything is written (the
      // settings stay those of the previous input).
      let refused;
      try { await optimistic; } catch (error) { refused = errorText(error); }
      const settings = opened.snapshot.modelSettings;
      result[name] = { ...settings, ...settings.modelId.length > 40 ? { modelId: `${settings.modelId.slice(0, 8)}…(${settings.modelId.length})` } : {}, sameWhilePending: JSON.stringify(immediate) === JSON.stringify(settings), snapshotMode: opened.snapshot.mode, ...refused === undefined ? {} : { refused } };
    }
    await opened.setModelSettings(SETTINGS_INPUTS.claudeHaiku);
    await opened.close();
    result.stored = (await storedDocs(deps, storage)).modelSettings;
    opened = await openSession(deps, 'offline', storage);
    result.reopened = view(opened.snapshot);
    result.leaked = leaks(result);
  } finally {
    await opened.close();
  }
  return result;
}

// ---- migration of an earlier pi.agent into ThreadsDoc and the snapshot mapping ----
export const STORED_AGENTS = {
  faux: { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' },
  openai: { model: { provider: 'openai', modelId: 'gpt-5' }, thinkingLevel: 'high' },
  openaiUnknownEffort: { model: { provider: 'openai', modelId: 'gpt-4.1-mini' }, thinkingLevel: 'high' },
  chatgpt: { model: { provider: 'openai-chatgpt', modelId: 'gpt-account-only' }, thinkingLevel: 'off' },
  claude: { model: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' }, thinkingLevel: 'medium' },
  unknownProvider: { model: { provider: 'llama-local', modelId: 'llama-3' }, thinkingLevel: 'high' }
};
export async function migrationBehaviour(deps) {
  const result = {};
  for (const [name, agent] of Object.entries(STORED_AGENTS)) {
    const storage = keptStorage(deps.pd);
    await seedAgent(deps, storage, agent);
    const opened = await openSession(deps, 'offline', storage);
    try {
      result[name] = view(opened.snapshot);
    } finally {
      await opened.close();
    }
    result[name].storedThreads = (await storedDocs(deps, storage)).modelSettings;
  }
  return result;
}

// ---- send: configureProvider results, requests, stored docs, errors --------------
export const SENDS = {
  offline: { config: { mode: 'offline', modelId: 'gpt-5', thinkingEffort: 'high' } },
  openaiDefault: { config: { mode: 'openai', modelId: '', thinkingEffort: '', apiKey: ` ${TOKENS.openai} ` } },
  openaiReasoning: { config: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: 'high', apiKey: TOKENS.openai } },
  openaiReasoningNoEffort: { config: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: '', apiKey: TOKENS.openai } },
  openaiNoKey: { config: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: '' } },
  openaiUnknownModel: { config: { mode: 'openai', modelId: 'not-a-model', apiKey: TOKENS.openai } },
  openaiBadEffort: { config: { mode: 'openai', modelId: 'gpt-4.1-mini', thinkingEffort: 'high', apiKey: TOKENS.openai } },
  chatgptDefault: { config: { mode: 'chatgpt', modelId: '', thinkingEffort: '' }, chatgpt: {} },
  chatgptReasoning: { config: { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: 'high' }, chatgpt: {} },
  chatgptAccountOnly: { config: { mode: 'chatgpt', modelId: 'gpt-account-only', thinkingEffort: '' }, chatgpt: {} },
  chatgptAccountOnlyEffort: { config: { mode: 'chatgpt', modelId: 'gpt-account-only', thinkingEffort: 'high' }, chatgpt: {} },
  chatgptNotInAccount: { config: { mode: 'chatgpt', modelId: 'gpt-4.1' }, chatgpt: {} },
  chatgptNoController: { config: { mode: 'chatgpt', modelId: 'gpt-5' } },
  chatgptSignedOut: { config: { mode: 'chatgpt', modelId: 'gpt-5' }, chatgpt: { signedIn: false } },
  chatgptSignedOutEmpty: { config: { mode: 'chatgpt', modelId: 'gpt-5' }, chatgpt: { signedIn: false, signedOut: 'empty' } },
  claudeDefault: { config: { mode: 'claude', modelId: '', thinkingEffort: '' }, claude: {} },
  claudeThinking: { config: { mode: 'claude', modelId: 'claude-sonnet-4-6', thinkingEffort: 'high' }, claude: {} },
  claudeHaiku: { config: { mode: 'claude', modelId: 'claude-haiku-4-5', thinkingEffort: 'low' }, claude: {} },
  claudeUnknownModel: { config: { mode: 'claude', modelId: 'claude-unknown' }, claude: {} },
  claudeNoController: { config: { mode: 'claude', modelId: '' } },
  claudeSignedOut: { config: { mode: 'claude', modelId: '' }, claude: { signedIn: false } },
  claudeSignedOutEmpty: { config: { mode: 'claude', modelId: '' }, claude: { signedIn: false, signedOut: 'empty' } },
  unknownMode: { config: { mode: 'llama-local', modelId: 'llama-3' } },
  // send() merges the stored per-chat settings under the given config.
  storedSettingsOnly: { before: { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: 'medium' }, config: {}, chatgpt: {} },
  // 401 with a JSON error echoing the credential: rendered text, redaction.
  openaiUnauthorized: { config: { mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: TOKENS.openai }, reply: 'unauthorized' },
  chatgptUnauthorized: { config: { mode: 'chatgpt', modelId: 'gpt-5' }, chatgpt: {}, reply: 'unauthorized' },
  claudeUnauthorized: { config: { mode: 'claude', modelId: '' }, claude: {}, reply: 'unauthorized' }
};
export async function sendBehaviour(deps, name) {
  const scenario = SENDS[name];
  const storage = keptStorage(deps.pd);
  const transport = fakeFetch(({ init }) => {
    if (scenario.reply !== 'unauthorized') return undefined;
    const headers = new Headers(init.headers);
    return unauthorized((headers.get('authorization') ?? headers.get('x-api-key') ?? '').replace(/^Bearer\s+/, ''));
  });
  const options = { fetch: transport.fetch };
  if (scenario.chatgpt) options.chatgpt = fakeAccount('chatgpt', scenario.chatgpt);
  if (scenario.claude) options.claude = fakeAccount('claude', scenario.claude);
  const opened = await openSession(deps, 'offline', storage, options);
  const result = {};
  try {
    if (scenario.before) await opened.setModelSettings(scenario.before);
    const before = opened.snapshot.messages.length;
    try {
      await opened.send('hello providers', scenario.config);
      await until(() => finished(opened, before + 1), `${name}: the reply did not finish`);
      result.outcome = 'sent';
    } catch (error) {
      result.outcome = 'refused';
      result.error = errorText(error);
      await settle();
    }
    result.snapshot = view(opened.snapshot);
    result.messages = messagesOf(opened.snapshot);
    if (opened.snapshot.error) result.snapshotError = mask(opened.snapshot.error);
  } finally {
    await opened.close();
  }
  const docs = await storedDocs(deps, storage);
  result.threads = docs.modelSettings[1];
  result.agent = docs.agents[1];
  result.requests = transport.requests;
  result.assistant = await assistantModels(deps, storage);
  result.leaked = leaks({ ...result, requests: undefined }) || leaks(await assistantTexts(deps, storage));
  return result;
}
async function assistantTexts({ chord }, storage) {
  const context = chord.BACKGROUND_CONTEXT;
  const page = await storage.scanEntries({ conversationId: 1 }, 200, undefined, context);
  const texts = [];
  for (const record of page.items) {
    const full = (await storage.entry?.(record.id, context))?.entry ?? record;
    for (const message of full.model ?? []) if (message.role === 'assistant') texts.push(message.errorMessage ?? '', JSON.stringify(message.content));
  }
  return texts;
}

// ---- resume() when nothing is paused, and the transient key ---------------------
export async function idleResumeBehaviour(deps) {
  const transport = fakeFetch();
  const opened = await openSession(deps, 'offline', keptStorage(deps.pd), { fetch: transport.fetch });
  try {
    const result = {};
    for (const config of [undefined, { mode: 'openai' }, { mode: 'chatgpt' }, { mode: 'llama-local' }]) {
      try {
        await opened.resume(config);
        result[config?.mode ?? 'default'] = 'resolved (not paused: no-op)';
      } catch (error) { result[config?.mode ?? 'default'] = `throws: ${errorText(error)}`; }
    }
    result.requests = transport.requests.length;
    result.snapshot = view(opened.snapshot);
    return result;
  } finally {
    await opened.close();
  }
}

// ---- subagent model API: models action, run with same/fast/provider ids -----------
const SUBAGENT_STEPS = {
  chatgpt: [
    { action: 'models' },
    { action: 'run', message: 'fast helper', model: 'fast', thinking: 'high' },
    { action: 'run', message: 'same helper', model: 'same', thinking: 'high' },
    { action: 'run', message: 'default helper' },
    { action: 'run', message: 'claude helper', model: 'anthropic/claude-haiku-4-5', thinking: 'high' },
    { action: 'run', message: 'chatgpt helper', model: 'openai-chatgpt/gpt-4.1-mini', thinking: 'medium' },
    { action: 'run', message: 'unknown provider', model: 'mistral/large' },
    { action: 'run', message: 'no slash', model: 'gpt-5' },
    { action: 'run', message: 'missing model', model: 'openai-chatgpt/gpt-unknown' },
    { action: 'run', message: 'key model without key', model: 'openai/gpt-4.1-mini' },
    { action: 'run', message: 'offline helper', model: 'faux/faux-1', thinking: 'high' }
  ],
  claude: [
    { action: 'models' },
    { action: 'run', message: 'fast helper', model: 'fast', thinking: 'medium' },
    { action: 'run', message: 'same helper', model: 'same', thinking: 'high' },
    { action: 'run', message: 'clamped helper', model: 'anthropic/claude-opus-5-5', thinking: 'minimal' },
    { action: 'run', message: 'chatgpt while signed out', model: 'openai-chatgpt/gpt-5' },
    { action: 'run', message: 'openai without key', model: 'openai/gpt-5' }
  ],
  openai: [
    { action: 'models' },
    { action: 'run', message: 'fast helper', model: 'fast', thinking: 'high' },
    { action: 'run', message: 'same helper', model: 'same', thinking: 'low' },
    { action: 'run', message: 'openai by id', model: 'openai/gpt-5', thinking: 'minimal' },
    { action: 'run', message: 'clamped helper', model: 'openai/gpt-5-pro', thinking: 'low' },
    { action: 'run', message: 'same clamped', model: 'same', thinking: 'off' },
    { action: 'run', message: 'claude while signed out', model: 'anthropic/claude-haiku-4-5' }
  ]
};
const PARENTS = {
  chatgpt: { config: { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: 'low' }, chatgpt: {}, claude: {} },
  claude: { config: { mode: 'claude', modelId: 'claude-sonnet-4-6', thinkingEffort: '' }, claude: {}, chatgpt: { signedIn: false } },
  openai: { config: { mode: 'openai', modelId: 'gpt-5', thinkingEffort: 'medium', apiKey: TOKENS.openai } }
};
const SUBAGENT_ROLE = /You are (the|a) subagent/;
// The system prompt text of one request: Responses developer/system input items, the
// Anthropic system field, and Anthropic in-conversation system messages (models with
// mid-conversation system support carry the prompt there).
const systemOf = (body) => [
  ...[...body.input ?? [], ...body.messages ?? []].filter((item) => ['developer', 'system'].includes(item.role)).map((item) => JSON.stringify(item.content)),
  ...(typeof body.system === 'string' ? [body.system] : (body.system ?? []).map((part) => part.text))
].join('\n');
export async function subagentBehaviour(deps, parent) {
  const steps = SUBAGENT_STEPS[parent];
  const scenario = PARENTS[parent];
  const storage = keptStorage(deps.pd);
  const children = [];
  let parentCalls = 0;
  const transport = fakeFetch(({ body, record }) => {
    if (SUBAGENT_ROLE.test(systemOf(body))) {
      children.push({ url: record.url, model: body.model, reasoning: body.reasoning, thinking: body.thinking, auth: record.values.authorization ?? record.values['x-api-key'] });
      return { text: 'child done' };
    }
    const step = steps[parentCalls++];
    return step ? { tool: { name: 'subagent', args: { ...step, context: ['device'] } } } : { text: 'parent done' };
  });
  const options = { fetch: transport.fetch };
  if (scenario.chatgpt) options.chatgpt = fakeAccount('chatgpt', scenario.chatgpt);
  if (scenario.claude) options.claude = fakeAccount('claude', scenario.claude);
  const opened = await openSession(deps, 'native', storage, options);
  const result = {};
  try {
    await opened.send('Delegate.', scenario.config);
    await until(() => parentCalls > steps.length && finished(opened, 2), `subagents (${parent}) did not finish`, 60000);
    result.toolResults = opened.snapshot.messages.filter((message) => message.role === 'tool').map((message) => `${message.error ? 'error' : 'ok'}: ${mask(message.text)}`);
    result.final = opened.snapshot.messages.at(-1).text;
  } finally {
    await opened.close();
  }
  const docs = await storedDocs(deps, storage);
  result.parentAgent = docs.agents[1];
  result.children = docs.owned;
  result.childRequests = children.map((child) => JSON.parse(mask(JSON.stringify(child))));
  result.leaked = leaks({ ...result, childRequests: undefined });
  return result;
}

// ---- recovery: a reply interrupted by close, reopened signed out / without key -----
export const RECOVERY = {
  chatgpt: { config: { mode: 'chatgpt', modelId: 'gpt-5', thinkingEffort: 'low' }, account: 'chatgpt' },
  claude: { config: { mode: 'claude', modelId: '', thinkingEffort: '' }, account: 'claude' },
  openai: { config: { mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: TOKENS.openai } },
  // A ChatGPT model that only the account lists (not in the bundled OpenAI catalog).
  chatgptAccountModel: { config: { mode: 'chatgpt', modelId: 'gpt-account-only' }, account: 'chatgpt' },
  chatgptSignedIn: { config: { mode: 'chatgpt', modelId: 'gpt-5' }, account: 'chatgpt', signedInAtReopen: true },
  claudeSignedIn: { config: { mode: 'claude', modelId: 'claude-haiku-4-5', thinkingEffort: 'low' }, account: 'claude', signedInAtReopen: true }
};
export async function recoveryBehaviour(deps, name) {
  const scenario = RECOVERY[name];
  const storage = keptStorage(deps.pd);
  const first = fakeFetch(() => 'hang');
  const account = () => scenario.account ? { [scenario.account]: fakeAccount(scenario.account) } : {};
  let opened = await openSession(deps, 'offline', storage, { fetch: first.fetch, ...account() });
  const result = {};
  try {
    await opened.send('Interrupted reply.', scenario.config);
    await until(() => first.requests.length === 1, `${name}: the first request was not made`);
  } finally {
    await opened.close();
  }
  const second = fakeFetch(() => ({ text: 'Recovered reply.' }));
  const credentials = scenario.account ? fakeAccount(scenario.account, { signedIn: Boolean(scenario.signedInAtReopen) }) : undefined;
  opened = await openSession(deps, 'offline', storage, { fetch: second.fetch, ...credentials ? { [scenario.account]: credentials } : {} });
  try {
    if (scenario.signedInAtReopen) {
      await until(() => second.requests.length === 1 && finished(opened, 1), `${name}: did not resume`);
      result.reopened = view(opened.snapshot);
    } else {
      await until(() => opened.snapshot.paused === true, `${name}: did not pause`);
      await settle();
      result.reopened = { ...view(opened.snapshot), requests: second.requests.length };
      if (scenario.account) {
        credentials.signIn();
      } else {
        try { await opened.resume({ mode: 'offline' }); result.resumeOffline = { ...view(opened.snapshot), requests: second.requests.length }; } catch (error) { result.resumeOffline = errorText(error); }
        try { await opened.resume({ mode: 'openai', modelId: 'gpt-4.1-mini' }); } catch (error) { result.resumeWithoutKey = errorText(error); }
        await opened.resume({ mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: TOKENS.openai });
      }
      await until(() => second.requests.length === 1 && finished(opened, 1) && !opened.snapshot.paused, `${name}: did not resume after credentials returned`);
      result.released = view(opened.snapshot);
    }
    result.messages = messagesOf(opened.snapshot);
    result.request = second.requests[0];
  } finally {
    await opened.close();
  }
  result.assistant = await assistantModels(deps, storage);
  return result;
}

// ---- offline demo ----------------------------------------------------------------
export async function offlineDemoBehaviour(deps, name) {
  const opened = await openSession(deps, name, keptStorage(deps.pd));
  try {
    await opened.send('hello demo');
    await until(() => finished(opened, 2), `offline demo (${name}) did not finish`);
    return { snapshot: view(opened.snapshot), messages: messagesOf(opened.snapshot) };
  } finally {
    await opened.close();
  }
}

// ---- model-error.js mapping --------------------------------------------------------
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const SECRET = 'test-secret-not-real-1234567890';
export const MODEL_ERRORS = {
  ok: () => [new Response('fine', { status: 200, headers: { 'content-type': 'text/plain' } }), { provider: 'OpenAI' }],
  openai401: () => [json(401, { error: { message: `Incorrect API key provided: ${SECRET}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }), { provider: 'OpenAI', init: { headers: { authorization: `Bearer ${SECRET}` } } }],
  chatgpt429: () => [json(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' } }), { provider: 'ChatGPT' }],
  claude400: () => [json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }), { provider: 'Claude' }],
  claudeApiKeyHeader: () => [json(403, { error: { message: `key ${SECRET} is not allowed`, type: 'permission_error' } }), { provider: 'Claude', init: { headers: { 'x-api-key': SECRET } } }],
  unknownLabel: () => [json(500, { error: { message: 'Server exploded.', code: 'server_error' } }), { provider: 'Local llama' }],
  noLabel: () => [json(502, { error: { message: 'Bad gateway.' } }), {}],
  nonJson: () => [new Response('<html>oops</html>', { status: 503, headers: { 'content-type': 'text/html' } }), { provider: 'OpenAI' }],
  noContentType: () => [new Response(JSON.stringify({ error: { message: 'Plain body.' } }), { status: 500 }), { provider: 'ChatGPT' }],
  invalidJson: () => [json(500, '{"error": '), { provider: 'Claude' }],
  errorNotObject: () => [json(500, { error: 'just a string' }), { provider: 'OpenAI' }],
  tooLarge: () => [json(500, { error: { message: 'x' } }, { 'content-length': String(64 * 1024) }), { provider: 'OpenAI' }],
  longMessage: () => [json(400, { error: { message: `Long ${'word '.repeat(200)}end.` } }), { provider: 'OpenAI' }],
  overLimitMessage: () => [json(400, { error: { message: 'm'.repeat(9000), type: 't' } }), { provider: 'OpenAI' }],
  skPattern: () => [json(401, { error: { message: 'Bad key sk-proj-abcdefghijklmnop and sk-...wxyz.' } }), { provider: 'OpenAI' }],
  jwtPattern: () => [json(401, { error: { message: 'Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl expired.' } }), { provider: 'ChatGPT' }],
  bearerPattern: () => [json(401, { error: { message: 'Header Authorization: Bearer abc.def-ghi rejected.' } }), { provider: 'Claude' }],
  escapedSecret: () => [json(401, { error: { message: `Escaped ${SECRET.replace('secret', '\\u0073ecret')} and ${encodeURIComponent(SECRET).replace('-', '%2D')}.` } }), { provider: 'OpenAI', init: { headers: { authorization: `Bearer ${SECRET}` } } }],
  maskedSecret: () => [json(401, { error: { message: `Key test-s...7890 and ${SECRET.slice(0, 12)}**** were rejected.` } }), { provider: 'OpenAI', init: { headers: { authorization: `Bearer ${SECRET}` } } }],
  fragment: () => [json(401, { error: { message: `Part ${SECRET.slice(5, 20)} leaked.` } }), { provider: 'OpenAI', init: { headers: { authorization: `Bearer ${SECRET}` } } }],
  requestInput: () => [json(401, { error: { message: `Bad ${SECRET}` } }), { provider: 'Claude', input: new Request('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': SECRET } }) }],
  controlChars: () => [json(400, { error: { message: 'Line one\nline\u0000two\u202e\t tabs', code: 'bad\u200bcode' } }), { provider: 'OpenAI' }],
  notModified: () => [new Response(null, { status: 304 }), { provider: 'OpenAI' }],
  typeTooLong: () => [json(400, { error: { message: 'Fine.', type: 't'.repeat(200), code: 'same' } }), { provider: 'OpenAI' }],
  typeEqualsCode: () => [json(400, { error: { message: 'Dup.', type: 'same', code: 'same' } }), { provider: 'OpenAI' }]
};
export async function modelErrorBehaviour({ modelError }) {
  const result = {};
  for (const [name, make] of Object.entries(MODEL_ERRORS)) {
    const [response, options] = make();
    const mapped = await modelError.safeModelErrorResponse(response, options);
    const passthrough = mapped === response;
    const text = passthrough ? undefined : await mapped.text();
    result[name] = {
      status: mapped.status, passthrough, contentType: mapped.headers.get('content-type'),
      ...text === undefined ? {} : { body: text ? JSON.parse(text) : null },
      leaked: (text ?? '').includes(SECRET) || (text ?? '').includes(SECRET.slice(5, 20))
    };
  }
  return result;
}
