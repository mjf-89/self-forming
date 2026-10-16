import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { libraryAvailable } from './plugin-agent-support.mjs';
import { DUMMY_KEY, collect, hostAi, importPlugin, root, startFixtureServer, textFrames, toolFrames } from './plugin-p5-support.mjs';

// Step P5: the plugin's port of pi-ai's openai-completions stream against a real HTTP
// server on 127.0.0.1 (node:http): SSE text streaming, a streamed function call and its
// replay (assistant tool_calls + tool message), usage, stop reasons, HTTP and in-stream
// errors (bounded and redacted, dummy key only), abort. Uses the bundled pi-ai's own
// exports as ctx.pi.ai. Node fetch stands in for the page fetch: not on-device.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai) is not present';
let server, api, ai, safePageResponse, store;
before(async () => {
  if (!available) return;
  ai = await import(pathToFileURL(join(root, 'dist/app/library/pi-ai.js')).href);
  const { createOpenAICompletions } = await importPlugin('openai-completions.js');
  ({ safePageResponse } = await importPlugin('provider.js'));
  const { createEndpointStore } = await importPlugin('endpoints.js');
  api = createOpenAICompletions(hostAi(ai), { errorPrefix: () => 'OpenAI-compatible API error' });
  server = await startFixtureServer();
  store = createEndpointStore();
  await store.add({ baseUrl: server.base, label: 'Fixture' });
});
after(async () => { await server?.close(); });

const TOOL = { name: 'workspace_write', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } };
const context = (...messages) => ({ messages: [{ role: 'system', content: 'You are a test.', toolsAdded: [TOOL], timestamp: 0 }, ...messages] });
const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const model = () => store.modelFor('fixture/qwen-test');
const pageFetch = async (input, init) => safePageResponse(await fetch(input, init), init);

test('the endpoint store lists the server models as <slug>/<id> pi-ai models', { skip }, async () => {
  const m = model();
  assert.equal(m.id, 'fixture/qwen-test');
  assert.equal(m.requestModelId, 'qwen-test');
  assert.equal(m.api, 'openai-completions');
  assert.equal(m.provider, 'openai-compatible');
  assert.equal(m.baseUrl, server.base);
  assert.equal(m.contextWindow, 65536, 'meta.n_ctx from the model list');
  assert.deepEqual((await store.list()).map(({ slug, models, modelSource, keyRequired }) => ({ slug, models, modelSource, keyRequired })),
    [{ slug: 'fixture', models: ['fixture/qwen-test'], modelSource: 'server', keyRequired: false }]);
});

test('text: streamed deltas, usage, stop; the request is a standard streaming chat completion without a key', { skip }, async () => {
  server.setAnswer((request, n) => ({ frames: textFrames(`c${n}`, ['Hel', 'lo ', 'there.']) }));
  const before = server.chats().length;
  const result = await collect(api.streamSimple(model(), context(user('Say hello.')), { fetch: pageFetch }));
  assert.deepEqual(result.events, ['start', 'text_start', 'text_delta', 'text_delta', 'text_delta', 'text_end', 'done']);
  const message = result.message;
  assert.equal(message.stopReason, 'stop');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello there.' }]);
  assert.equal(message.model, 'fixture/qwen-test');
  assert.equal(message.responseModel, 'served-model');
  assert.equal(message.usage.input, 120);
  assert.equal(message.usage.output, 7);
  assert.equal(message.usage.totalTokens, 127);
  const request = server.chats()[before];
  assert.equal(request.headers.authorization, undefined, 'no key, no Authorization header');
  assert.equal(request.headers['content-type'], 'application/json');
  const body = request.body;
  assert.equal(body.model, 'qwen-test', 'the server model id, without the endpoint slug');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(typeof body.max_tokens, 'number', 'generic servers get max_tokens');
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.store, undefined);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'You are a test.' }, { role: 'user', content: 'Say hello.' }]);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'workspace_write', description: 'Write a file.', parameters: TOOL.parameters } }]);
});

test('tool call: streamed arguments are parsed; the round trip replays tool_calls and the tool result', { skip }, async () => {
  server.setAnswer((request, n) => n % 2 ? { frames: toolFrames(`c${n}`, { callId: 'call_A1', name: 'workspace_write', args: { path: 'note.txt', text: 'from compat' } }) } : { frames: textFrames(`c${n}`, ['Saved.']) });
  // Make the next request odd-numbered for the tool call.
  if (server.chats().length % 2 === 1) await collect(api.stream(model(), context(user('pad')), { fetch: pageFetch }));
  const first = await collect(api.stream(model(), context(user('Write a note.')), { fetch: pageFetch, apiKey: DUMMY_KEY }));
  assert.deepEqual(first.events.filter((type) => type.startsWith('toolcall')), ['toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_delta', 'toolcall_delta', 'toolcall_end'], 'one delta per tool_calls chunk (the first has empty arguments), as upstream');
  assert.equal(first.message.stopReason, 'toolUse');
  assert.deepEqual(first.message.content, [{ type: 'toolCall', id: 'call_A1', name: 'workspace_write', arguments: { path: 'note.txt', text: 'from compat' } }]);
  assert.equal(server.chats().at(-1).headers.authorization, `Bearer ${DUMMY_KEY}`, 'a given key goes into the header');
  const result = { role: 'toolResult', toolCallId: 'call_A1', toolName: 'workspace_write', content: [{ type: 'text', text: 'Wrote note.txt' }], isError: false, timestamp: 3 };
  const second = await collect(api.stream(model(), context(user('Write a note.'), first.message, result), { fetch: pageFetch }));
  assert.equal(second.message.stopReason, 'stop');
  assert.deepEqual(second.message.content, [{ type: 'text', text: 'Saved.' }]);
  assert.deepEqual(server.chats().at(-1).body.messages.slice(1), [
    { role: 'user', content: 'Write a note.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_A1', type: 'function', function: { name: 'workspace_write', arguments: '{"path":"note.txt","text":"from compat"}' } }] },
    { role: 'tool', content: 'Wrote note.txt', tool_call_id: 'call_A1' }
  ]);
});

test('reasoning_content (llama.cpp) becomes a thinking block', { skip }, async () => {
  server.setAnswer((request, n) => ({ frames: [
    { id: `c${n}`, choices: [{ index: 0, delta: { reasoning_content: 'Think' } }] },
    { id: `c${n}`, choices: [{ index: 0, delta: { reasoning_content: 'ing.' } }] },
    ...textFrames(`c${n}`, ['Answer.'])
  ] }));
  const { message } = await collect(api.stream(model(), context(user('q')), { fetch: pageFetch }));
  assert.deepEqual(message.content, [{ type: 'thinking', thinking: 'Thinking.', thinkingSignature: 'reasoning_content' }, { type: 'text', text: 'Answer.' }]);
});

test('stop reasons: length, content_filter, missing finish_reason, in-stream error', { skip }, async () => {
  const run = async (frames, extra = {}) => { server.setAnswer(() => ({ frames, ...extra })); return (await collect(api.stream(model(), context(user('q')), { fetch: pageFetch }))).message; };
  assert.equal((await run(textFrames('a', ['cut'], { finish: 'length' }))).stopReason, 'length');
  const filtered = await run(textFrames('b', ['no'], { finish: 'content_filter' }));
  assert.equal(filtered.stopReason, 'error');
  assert.equal(filtered.errorMessage, 'Provider finish_reason: content_filter');
  const unfinished = await run(textFrames('c', ['half']).filter((frame) => !frame.choices?.[0]?.finish_reason));
  assert.equal(unfinished.stopReason, 'error');
  assert.equal(unfinished.errorMessage, 'Stream ended without finish_reason');
  const broken = await run([textFrames('d', ['x'])[1], { error: { message: 'context size exceeded', type: 'exceed_context_size_error', code: 400 } }]);
  assert.equal(broken.stopReason, 'error');
  assert.match(broken.errorMessage, /context size exceeded/);
});

test('HTTP errors: bounded, redacted, shown as "OpenAI-compatible request failed (<status>)"', { skip }, async () => {
  server.setAnswer(() => ({ status: 401, body: { error: { message: `Invalid API key ${DUMMY_KEY} (Bearer ${DUMMY_KEY})`, type: 'authentication_error' } } }));
  const { message } = await collect(api.stream(model(), context(user('q')), { fetch: pageFetch, apiKey: DUMMY_KEY }));
  assert.equal(message.stopReason, 'error');
  assert.ok(!JSON.stringify(message).includes(DUMMY_KEY), 'the key never reaches the message');
  assert.match(message.errorMessage, /^OpenAI-compatible API error \(401\): \{/);
  const inner = JSON.parse(message.errorMessage.replace(/^[^{]*/, ''));
  assert.match(inner.message, /^OpenAI-compatible request failed \(401\)\. Invalid API key \[redacted\]/);
  server.setAnswer(() => ({ status: 503, text: '<html>busy</html>' }));
  const html = (await collect(api.stream(model(), context(user('q')), { fetch: pageFetch }))).message;
  assert.match(html.errorMessage, /OpenAI-compatible request failed \(503\)\. Check the server, the model name and the API key\./);
});

test('abort: the stream ends as aborted', { skip }, async () => {
  server.setAnswer((request, n) => ({ frames: [...textFrames(`c${n}`, Array.from({ length: 200 }, () => 'x '))] }));
  const controller = new AbortController();
  const stream = api.stream(model(), context(user('long')), { fetch: pageFetch, signal: controller.signal });
  const seen = [];
  for await (const event of stream) {
    seen.push(event.type);
    if (event.type === 'text_delta' && seen.filter((type) => type === 'text_delta').length === 3) controller.abort();
  }
  const message = await stream.result();
  assert.equal(message.stopReason, 'aborted');
  assert.equal(seen.at(-1), 'error');
});
