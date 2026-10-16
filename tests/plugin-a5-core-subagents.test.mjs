import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';

// Track A step A5: the subagent tool is the essential built-in core-subagents
// (plugins/core-subagents), built per session from host.harness (agent.harness@1) and
// host.pi only. Real session.js / agent-extensions.js / plugin-runtime.js with the
// bundled pi-durable library, mocked hosts and a mocked ChatGPT endpoint.
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, chord, session, runtimeModule, agentModule, coreModule, piModule, subagentsRow;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  chord = await app.load('library/chord/context.js');
  session = await app.load('session.js');
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  coreModule = await app.load('core-agent-plugins.js');
  piModule = await app.load('plugin-pi.js');
  subagentsRow = (await app.load('builtin/core-subagents/web/index.js')).row;
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
  async getAccessToken() { return 'dummy-a5-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }]; },
  subscribe() { return () => {}; }
});

test('the row: permanent names, needs a shell, built once per session harness', { skip }, () => {
  assert.equal(subagentsRow.extension, 'self-forming-subagents');
  assert.deepEqual(subagentsRow.tools(), ['subagent']);
  assert.deepEqual(subagentsRow.tasks(), ['self-forming.subagent-anchor', 'self-forming.subagent-reporter', 'self-forming.subagent-stop']);
  assert.match(subagentsRow.unavailable({ executionEnv: false }), /execution environment/);
  assert.equal(subagentsRow.unavailable({ executionEnv: true }), undefined);
  assert.match(subagentsRow.unavailable({ executionEnv: true }, {}, { env: {} }), /agent\.harness@1/);
  const harness = {};
  const host = { env: {}, harness, pi: piModule.pluginPi };
  const first = subagentsRow.create(undefined, host);
  const second = subagentsRow.create(undefined, { ...host });
  assert.equal(first.tools[0].name, 'subagent');
  assert.equal(first.tools[0], second.tools[0], 'bundled and runtime copies share the tool of one session');
  assert.deepEqual(first.tasks.map((task) => task.definition.name), subagentsRow.tasks());
  first.tasks.forEach((task, index) => assert.equal(task, second.tasks[index]));
  assert.notEqual(subagentsRow.create(undefined, { ...host, harness: {} }).tools[0], first.tools[0], 'another session gets its own');
  assert.equal(subagentsRow.create(undefined, { harness, pi: piModule.pluginPi }), null, 'no shell: nothing');
  const definition = coreModule.createCoreAgentPlugins({ hostInfo: { capabilities: {} } }).find((item) => item.id === 'core-subagents');
  assert.ok(definition.essential && definition.unavailable, 'blocked with a reason without a shell');
});

test('spawn through the runtime copy: the child works, reports back and is named in the tree', { skip, timeout: 30000 }, async () => {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime);
  const bodies = { parent: [], child: [] };
  let parentCalls = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are the subagent/.test(JSON.stringify(item)));
    (child ? bodies.child : bodies.parent).push(body);
    if (child) return response('worker finished');
    parentCalls++;
    if (parentCalls === 1) return response('', { name: 'subagent', args: { action: 'spawn', name: 'worker', message: 'Look around.', tools: ['read'] } });
    return response('ok');
  };
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const opened = await session.openAppSession({ storage: new pd.MemoryStorage(), toolchain: false, ...options, chatgpt: auth(), fetch, agentExtensions });
  try {
    const sources = agentExtensions.list().accepted.filter((item) => item.pluginId === 'core-subagents').map((item) => [item.name, item.source]);
    assert.deepEqual(sources, [['self-forming-subagents', 'runtime']]);
    await opened.send('Spawn a worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => bodies.parent.some((body) => JSON.stringify(body.input).includes('[subagent worker answered] worker finished')), 'the report did not reach the main conversation', 20000);
    assert.deepEqual(bodies.child[0].tools.map((tool) => tool.name), ['read']);
    const tree = await opened.tree();
    const flat = (nodes) => nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
    const worker = flat(Array.isArray(tree) ? tree : tree.nodes ?? [tree]).find((node) => node.kind === 'subagent');
    assert.ok(worker, `a subagent node in the tree: ${JSON.stringify(tree).slice(0, 400)}`);
    assert.equal(worker.title, 'worker');
  } finally {
    await opened.close();
    globalThis.__piHostInfo = saved;
    await runtime.close();
  }
});

test('the engine no longer imports the subagent implementation', async () => {
  const engine = await readFile(new URL('../apps/common/session-engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(engine, /subagents\.js|createSubagentExtensions/);
  const entry = await readFile(new URL('../plugins/core-subagents/web/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entry.replace(/^\s*\/\/.*$/gm, ''), /library\/|session-engine|session\.js/);
});

// Archive (user decision): the `subagent` tool archives/unarchives only subagents of its own registry, and
// only idle ones (no run, no queued input, no pending reporter/stop task: pi-durable docs and tasks). The flag
// is a new field on the registry entry; `send` clears it in the same commit.
test('archive/unarchive: own idle subagents only; active ones are refused; send unarchives; another conversation cannot', { skip, timeout: 60000 }, async () => {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = true;
  const outputs = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are the subagent/.test(JSON.stringify(item)));
    if (child) {
      if (gated) await gate;
      return response('worker finished');
    }
    const last = body.input.at(-1);
    if (last.type === 'function_call_output') {
      outputs.push(String(typeof last.output === 'string' ? last.output : JSON.stringify(last.output)));
      return response('ok');
    }
    const command = /Do (\w+) (\w+)\./.exec(JSON.stringify(last));
    if (!command) return response('ok');
    const [, action, name] = command;
    return response('', { name: 'subagent', args: { action, name, ...action === 'spawn' ? { message: 'Look around.', tools: ['read'] } : {}, ...action === 'send' ? { message: 'More.' } : {} } });
  };
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const opened = await session.openAppSession({ storage: new pd.MemoryStorage(), toolchain: false, ...options, chatgpt: auth(), fetch, agentExtensions });
  const chat = { mode: 'chatgpt', modelId: 'gpt-4.1' };
  const worker = async () => (await opened.tree()).find((node) => node.title === 'worker');
  const call = async (text) => {
    const before = outputs.length;
    await opened.send(text, chat);
    await until(() => outputs.length > before && !opened.snapshot.busy, `no tool result for: ${text}`, 20000);
    return outputs.at(-1);
  };
  try {
    assert.match(await call('Do spawn worker.'), /Started worker/);
    await until(async () => (await worker())?.busy === true, 'worker never showed as working', 10000);
    // Active: its run is live and the reporter is delivering.
    const refused = await call('Do archive worker.');
    assert.match(refused, /Cannot archive worker while it is active/);
    assert.match(refused, /it is working/);
    assert.match(refused, /in progress/);
    assert.equal((await worker()).archived, false);
    // Idle and reported: now it can be archived (the reporter settles right after the report is posted).
    gated = false;
    release();
    await until(async () => (await worker())?.busy === false, 'worker still working', 20000);
    await until(() => !opened.snapshot.busy, 'main still busy', 20000);
    let archived;
    await until(async () => (archived = await call('Do archive worker.'), /^Archived worker/.test(archived)), `archive kept being refused: ${archived}`, 20000);
    assert.equal((await worker()).archived, true, 'the tree marks it archived');
    assert.match(await call('Do archive worker.'), /already archived/);
    assert.match(await call('Do status worker.'), /worker: idle .*archived/);
    assert.match(await call('Do unarchive worker.'), /^Unarchived worker/);
    assert.equal((await worker()).archived, false);
    assert.match(await call('Do unarchive worker.'), /not archived/);
    // send to an archived subagent unarchives it at once and proceeds.
    await call('Do archive worker.');
    assert.equal((await worker()).archived, true);
    assert.match(await call('Do send worker.'), /Sent to worker \(unarchived\)/);
    assert.equal((await worker()).archived, false);
    await until(() => !opened.snapshot.busy, 'main still busy', 20000);
    await until(async () => (await worker())?.busy === false, 'worker still working after send', 20000);
    // Another conversation has its own registry: it cannot archive this one's subagent.
    await call('Do archive worker.'); // archived again, so a wrong success would show in the flag
    const owner = opened.snapshot.conversation.id;
    await opened.newThread();
    const refusedOther = await call('Do archive worker.');
    assert.match(refusedOther, /No subagent named worker among the ones you spawned/);
    await opened.switchConversation(owner);
    assert.equal((await worker()).archived, true, 'still as the owner left it');
  } finally {
    gated = false;
    release();
    await opened.close();
    globalThis.__piHostInfo = saved;
    await runtime.close();
  }
});

// `status all` listed nothing ("No subagents.") because "all" was looked up as a name; the session's
// archiveConversation/unarchiveConversation (the drawer's buttons) archive a subagent by the tool's own rule,
// through core-subagents' additive hook (not reimplemented in the conversations plugin).
test('status all lists every subagent (archived marked); the session archives subagents by the tool rule', { skip, timeout: 60000 }, async () => {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = true;
  const outputs = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are the subagent/.test(JSON.stringify(item)));
    if (child) {
      if (gated && /You are the subagent \\"gated\\"/.test(JSON.stringify(body.input))) await gate;
      return response('finished');
    }
    const last = body.input.at(-1);
    if (last.type === 'function_call_output') {
      outputs.push(String(typeof last.output === 'string' ? last.output : JSON.stringify(last.output)));
      return response('ok');
    }
    const command = /Do (\w+) (\w+)\./.exec(JSON.stringify(last));
    if (!command) return response('ok');
    const [, action, name] = command;
    return response('', { name: 'subagent', args: { action, name: name === 'nobody' ? undefined : name, ...action === 'spawn' ? { message: 'Look around.', tools: ['read'] } : {}, ...action === 'send' ? { message: 'More.' } : {} } });
  };
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const opened = await session.openAppSession({ storage: new pd.MemoryStorage(), toolchain: false, ...options, chatgpt: auth(), fetch, agentExtensions });
  const chat = { mode: 'chatgpt', modelId: 'gpt-4.1' };
  const node = async (title) => (await opened.tree()).find((each) => each.title === title);
  const call = async (text) => {
    const before = outputs.length;
    await opened.send(text, chat);
    await until(() => outputs.length > before && !opened.snapshot.busy, `no tool result for: ${text}`, 20000);
    return outputs.at(-1);
  };
  try {
    assert.match(await call('Do status nobody.'), /^No subagents\.$/, 'no name and an empty registry');
    assert.match(await call('Do spawn done1.'), /Started done1/);
    assert.match(await call('Do spawn done2.'), /Started done2/);
    assert.match(await call('Do spawn gated.'), /Started gated/);
    await until(async () => (await node('done1'))?.busy === false && (await node('done2'))?.busy === false, 'done ones still working', 20000);
    await until(async () => (await node('gated'))?.busy === true, 'gated not working', 10000);
    await until(() => !opened.snapshot.busy, 'main still busy', 20000);
    // The drawer's path: refused while active, with the tool's message.
    const gatedId = (await node('gated')).id;
    await assert.rejects(opened.archiveConversation(gatedId), /Cannot archive gated while it is active.*it is working/);
    assert.equal((await node('gated')).archived, false);
    // Idle ones archive (retry: the reporter settles right after the report is posted).
    const done1 = (await node('done1')).id;
    await until(async () => { try { await opened.archiveConversation(done1); return true; } catch { return false; } }, 'done1 kept being refused', 20000);
    assert.equal((await node('done1')).archived, true);
    const all = await call('Do status all.');
    const lines = all.split('\n');
    assert.equal(lines.length, 3, all);
    assert.ok(lines.some((line) => /^done1: idle .*archived/.test(line)), all);
    assert.ok(lines.some((line) => /^done2: idle/.test(line) && !/archived/.test(line)), all);
    assert.ok(lines.some((line) => /^gated: working/.test(line)), all);
    assert.match(await call('Do status missing.'), /No subagent named missing\./);
    // Same registry flag as the tool; the tool sees it, and unarchive from the session clears it.
    assert.match(await call('Do archive done1.'), /already archived/);
    await opened.unarchiveConversation(done1);
    assert.equal((await node('done1')).archived, false);
    assert.match(await call('Do unarchive done1.'), /not archived/);
    // send unarchives (unchanged), also after a session-side archive.
    await opened.archiveConversation(done1);
    assert.match(await call('Do send done1.'), /Sent to done1 \(unarchived\)/);
    assert.equal((await node('done1')).archived, false);
    // The tool's task-owned run helpers and the main chat keep no archive path.
    await assert.rejects(opened.archiveConversation(pd.ROOT_CONVERSATION_ID), /main conversation/);
    await assert.rejects(opened.archiveConversation(987654), /Only conversations and spawned subagents/);
  } finally {
    gated = false;
    release();
    await opened.close();
    globalThis.__piHostInfo = saved;
    await runtime.close();
  }
});
