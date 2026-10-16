// Test support for step P5 (docs/plugins-providers-agent-core.md §D P5, decision §F.4):
// the installed plugin package examples/plugins/openai-compatible.
// - a real HTTP server on 127.0.0.1 (node:http) that speaks the OpenAI-compatible API:
//   GET /v1/models and streaming POST /v1/chat/completions (SSE), scripted per request;
// - the host's pi-ai bag for plugins (ctx.pi.ai) as plugin-pi.js is expected to export it
//   (plugin-pi.js does not have it yet: this is the proposed shape, built from the
//   bundled library);
// - fake plugin lanes (ctx.credentials, ctx.http) with dummy values only.
// No device, no real keys, no network beyond 127.0.0.1.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = new URL('..', import.meta.url).pathname;
export const PACKAGE = join(root, 'examples/plugins/openai-compatible');
export const DUMMY_KEY = 'dummy-test-key-not-real-0123456789';
export const importPlugin = (name = 'index.js') => import(pathToFileURL(join(PACKAGE, 'web', name)).href);

/** The proposed ctx.pi.ai bag: the host's own pi-ai exports (plugin-pi.js change, see report). */
export function hostAi(ai, extra = {}) {
  return Object.freeze({
    createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
    parseStreamingJson: ai.parseStreamingJson,
    calculateCost: ai.calculateCost,
    getSupportedThinkingLevels: ai.getSupportedThinkingLevels,
    clampThinkingLevel: ai.clampThinkingLevel,
    resolveTranscript: ai.resolveTranscript,
    resolveTranscriptTools: ai.resolveTranscriptTools,
    getDeclaredTools: ai.getDeclaredTools,
    getSystemMessageText: ai.getSystemMessageText,
    renderSystemMessageUpdate: ai.renderSystemMessageUpdate,
    ...extra
  });
}

/** A Storage-like map (the plugin keeps its endpoint config in localStorage). */
export function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: (key) => { values.delete(key); }, values };
}

/** Fake plugin credential lane (ctx.credentials): records by name, call log without values. */
export function fakeCredentials() {
  const records = new Map();
  const calls = [];
  return {
    records, calls,
    async load(name) { calls.push(['load', name]); return records.has(name) ? structuredClone(records.get(name)) : null; },
    async save(name, record) { calls.push(['save', name]); records.set(name, structuredClone(record)); return null; },
    async clear(name) { calls.push(['clear', name]); records.delete(name); return null; }
  };
}
/** Fake ctx.http lane: allow-list get/set (fetch optional). */
export function fakeHttp({ fetch } = {}) {
  let entries = [];
  const calls = [];
  return {
    calls,
    get entries() { return entries.slice(); },
    ...(fetch ? { fetch } : {}),
    allowList: {
      async get() { calls.push(['get']); return { entries: entries.slice(), max: 32 }; },
      async set({ entries: next }) { calls.push(['set', next.slice()]); entries = next.slice(); return { entries: entries.slice(), max: 32 }; }
    }
  };
}

const chunk = (id, delta, extra = {}) => ({ id, object: 'chat.completion.chunk', created: 1, model: 'served-model', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
/** SSE frames of a text answer split into pieces, then finish_reason stop and a usage chunk. */
export function textFrames(id, pieces, { usage = { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 }, finish = 'stop' } = {}) {
  return [
    chunk(id, { role: 'assistant', content: '' }),
    ...pieces.map((piece) => chunk(id, { content: piece })),
    { ...chunk(id, {}), choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ...(usage ? [{ id, object: 'chat.completion.chunk', created: 1, model: 'served-model', choices: [], usage }] : [])
  ];
}
/** SSE frames of one streamed function call (arguments split over several deltas). */
export function toolFrames(id, { callId = 'call_fixture_1', name, args }) {
  const json = JSON.stringify(args);
  const third = Math.ceil(json.length / 3);
  return [
    chunk(id, { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }),
    chunk(id, { tool_calls: [{ index: 0, function: { arguments: json.slice(0, third) } }] }),
    chunk(id, { tool_calls: [{ index: 0, function: { arguments: json.slice(third, 2 * third) } }] }),
    chunk(id, { tool_calls: [{ index: 0, function: { arguments: json.slice(2 * third) } }] }),
    { ...chunk(id, {}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { id, object: 'chat.completion.chunk', created: 1, model: 'served-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
  ];
}

/**
 * startFixtureServer({models, answer}) → {url, base, requests, close, setAnswer, setModels}.
 * answer(request, n) → {frames, delayMs?} | {status, body} | {status, text}. Default: "reply n".
 * requests: {method, path, headers (lowercase), body (parsed JSON)}. Frames are written
 * one by one with a short pause so the client really streams.
 */
export async function startFixtureServer({ models = [{ id: 'qwen-test', object: 'model', owned_by: 'fixture', meta: { n_ctx: 65536 } }], answer, port: listenPort = 0 } = {}) {
  const requests = [];
  let script = answer ?? ((request, n) => ({ frames: textFrames(`chatcmpl-${n}`, ['re', 'ply ', String(n)]) }));
  let listed = models;
  let chats = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const record = { method: req.method, path: req.url, headers: { ...req.headers }, body };
    requests.push(record);
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (typeof listed === 'number') { res.writeHead(listed, { 'content-type': 'application/json', ...cors }); res.end('{"error":{"message":"no"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ object: 'list', data: listed }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const step = await script(record, ++chats);
      if (res.destroyed || req.socket.destroyed) return; // the client went away (abort, closed session)
      if (step.status) {
        res.writeHead(step.status, { 'content-type': step.text !== undefined ? 'text/plain' : 'application/json', ...cors });
        res.end(step.text ?? JSON.stringify(step.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
      for (const frame of step.frames) {
        if (res.destroyed) return;
        res.write(typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, step.delayMs ?? 2));
      }
      if (!step.noDone) res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain', ...cors });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    chats: () => requests.filter((request) => request.path === '/v1/chat/completions'),
    setAnswer(next) { script = next; },
    setModels(next) { listed = next; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

/** Collects a pi-ai event stream: {events (types), message (final)}. */
export async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events: events.map((event) => event.type), all: events, message: await stream.result() };
}

/**
 * A scripted answer for manual/on-device checks (plugin-p5-fixture-server.mjs): after a
 * tool result → a text reply; a user message containing "tool" → one call of the
 * request's write tool (write or workspace_write, argument names from its schema);
 * otherwise an echo. Streams in small pieces.
 */
export function smartAnswer(request, n) {
  const messages = request.body?.messages ?? [];
  const last = messages.at(-1);
  if (last?.role === 'tool') return { frames: textFrames(`s${n}`, ['The tool ', 'result came back: ', String(last.content).slice(0, 80)]), delayMs: 40 };
  const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((part) => part.text ?? '').join(' ');
  const tool = (request.body?.tools ?? []).map((item) => item.function).find((fn) => fn?.name === 'write' || fn?.name === 'workspace_write');
  if (/\btool\b/i.test(text) && tool) {
    const properties = tool.parameters?.properties ?? {};
    const body = 'p5 fixture check\n';
    const args = { path: 'p5-fixture-check.txt', ...('content' in properties ? { content: body } : { text: body }) };
    return { frames: toolFrames(`s${n}`, { callId: `call_s${n}`, name: tool.name, args }) };
  }
  return { frames: textFrames(`s${n}`, ['Fixture ', 'reply ', `${n}: `, text.slice(0, 60)]), delayMs: 40 };
}
