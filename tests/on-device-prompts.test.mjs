import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { createModels, Type } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';

let createPromptExtension, PromptSelectionDoc, MAIN_PROMPT_SECTIONS;
before(async () => {
  await mkdir('.test-build', { recursive: true });
  const outfile = resolve('.test-build/on-device-prompts.mjs');
  await build({ entryPoints: ['apps/on-device/prompt-sections.js'], outfile, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', target: 'node24', plugins: [{ name: 'fixed-browser-imports', setup(builder) {
      builder.onResolve({ filter: /^\.\/library\// }, args => ({ path: '@earendil-works/' + args.path.slice('./library/'.length).replace(/\.js$/, ''), external: true }));
    } }] });
  ({ createPromptExtension, PromptSelectionDoc, MAIN_PROMPT_SECTIONS } = await import(pathToFileURL(outfile).href));
});

const context = BACKGROUND_CONTEXT;
const native = { cwd: '/workspace' };
const names = ['read', 'write', 'edit', 'bash', 'subagent', 'manage_server', 'app_update', 'app_install_apk'];
const mainKeys = ['device', 'app', 'self-rebuild', 'subagents', 'servers', 'agents-guide'];
async function fixture(t, options = {}) {
  const prompts = createPromptExtension({ nativeEnvironment: native, appRevision: {}, apkInstaller: {},
    projectGuide: 'Keep drafts and sign-ins. Never expose credentials.', ...options });
  const tools = names.map(name => defineTool({ name, description: name, parameters: Type.Object({}),
    execute: async () => { throw new Error('A prompt test must not execute a tool'); } }));
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'fixture-tools', tools }));
  registry.install(prompts.PromptExtension);
  const models = createModels();
  const provider = fauxProvider({ tokensPerSecond: 0 });
  const requests = [];
  const respond = transcript => {
    requests.push(structuredClone(transcript));
    provider.appendResponses([respond]);
    return fauxAssistantMessage('Done.');
  };
  provider.setResponses([respond]);
  models.setProvider(provider.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  t.after(() => harness.close(context));
  const main = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    init: (tx, id) => prompts.configurePrompt(tx, id) });
  return { ...prompts, harness, main, requests, tools };
}
async function send(conversation, content = 'Continue') {
  const settled = await (await conversation.submit({ type: 'input', content }, context)).wait(context);
  assert.equal(settled.status, 'done');
  assert.equal(settled.type, 'input');
  return settled;
}
function activeSections(transcript) {
  const sections = {};
  for (const message of transcript.messages) for (const [name, text] of Object.entries(message.sections ?? {})) {
    if (text === null) delete sections[name]; else sections[name] = text;
  }
  return sections;
}
const systemMessages = transcript => transcript.messages.filter(message => message.role === 'system');

test('main guidance uses native named sections, unchanged requests reuse them, changes become section patches', async t => {
  const { main, harness, configurePrompt, requests } = await fixture(t);
  await send(main);
  const first = activeSections(requests[0]);
  assert.deepEqual(Object.keys(first), mainKeys);
  assert.equal((await main.agent(context)).instructions, undefined);
  assert.match(first.device, /^<device>\n.*Ubuntu 24\.04/s);
  assert.match(first.app, /call app_update with action apply/);
  assert.match(first['self-rebuild'], /Install a finished APK with app_install_apk/);
  assert.match(first.subagents, /Pick a cheaper model/);
  assert.match(first.servers, /manage_server/);
  assert.match(first['agents-guide'], /Never expose credentials/);
  await send(main);
  assert.equal(systemMessages(requests[1]).length, systemMessages(requests[0]).length);
  await harness.commit(tx => configurePrompt(tx, main.id, { sections: ['device'] }), context);
  await send(main);
  assert.deepEqual(Object.keys(activeSections(requests[2])), ['device']);
  const patch = systemMessages(requests[2]).at(-1).sections;
  assert.equal(patch.app, null);
  assert.equal(patch.subagents, null);
  assert.equal(patch.device, undefined, 'unchanged text is not repeated');
});

test('restricted helpers receive only selected sections and guidance matches their actual tools', async t => {
  const { harness, requests, configurePrompt, tools } = await fixture(t);
  const child = await harness.createConversation({ ownership: { kind: 'ownerless' },
    agent: { model: { provider: 'faux', modelId: 'faux-1' }, tools: tools.filter(tool => ['read', 'write', 'bash'].includes(tool.name)),
      instructions: 'Implement the assigned module and report the result.' },
    init: (tx, id) => configurePrompt(tx, id, { sections: ['device', 'app', 'selfRebuild', 'subagents', 'servers', 'transcript'],
      transcript: 'User: Make the invitation shorter.' }) }, context);
  await send(child);
  const sections = activeSections(requests[0]);
  assert.deepEqual(Object.keys(sections), ['device', 'app', 'self-rebuild', 'transcript', 'instructions']);
  assert.match(sections.app, /main agent handles applying revisions/);
  assert.match(sections['self-rebuild'], /Return the finished APK path/);
  assert.doesNotMatch(sections.app + sections['self-rebuild'], /app_update|app_install_apk|subagent/);
  assert.doesNotMatch(sections.device, /available file tools are .*edit/);
  assert.match(sections.transcript, /Make the invitation shorter/);
  assert.match(sections.instructions, /Implement the assigned module/);

  await harness.commit(tx => configurePrompt(tx, child.id, { sections: ['device'] }), context);
  await send(child);
  assert.deepEqual(Object.keys(activeSections(requests[1])), ['device', 'instructions']);
  assert.equal((await harness.snapshot(PromptSelectionDoc, child.id, context)).transcript, '');
});

test('forks inherit section selection at the fork cutoff, not the latest parent settings', async t => {
  const { main, harness, configurePrompt, requests } = await fixture(t);
  const first = await send(main);
  await harness.commit(tx => configurePrompt(tx, main.id, { sections: ['device', 'transcript'], transcript: 'Later context' }), context);
  await send(main);
  const branch = await main.fork(first.answer, { ownership: { kind: 'ownerless' } }, context);
  const selection = await harness.snapshot(PromptSelectionDoc, branch.id, context);
  assert.deepEqual(selection.sections, MAIN_PROMPT_SECTIONS);
  assert.equal(selection.transcript, '');
  await send(branch);
  assert.deepEqual(Object.keys(activeSections(requests.at(-1))), mainKeys);
});

test('legacy helpers keep their saved instructions without receiving new main-agent context', async t => {
  const { harness, requests } = await fixture(t);
  for (const initialize of [false, true]) {
    const legacy = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: {
      model: { provider: 'faux', modelId: 'faux-1' }, instructions: 'Saved helper guidance, with its own selected context.'
    }, ...(initialize ? { init: (tx, id) => tx.doc(PromptSelectionDoc, id).then(() => {}) } : {}) }, context);
    await send(legacy);
    assert.deepEqual(Object.keys(activeSections(requests.at(-1))), ['instructions']);
  }
});

test('browser fallback omits unavailable guidance and empty selections emit no prompt sections', async t => {
  const { main, harness, requests, configurePrompt } = await fixture(t, {
    nativeEnvironment: undefined, appRevision: undefined, apkInstaller: undefined, projectGuide: ''
  });
  await main.configure({ tools: [] }, context);
  await send(main);
  const sections = activeSections(requests[0]);
  assert.deepEqual(Object.keys(sections), ['device']);
  assert.match(sections.device, /private to this app/);
  assert.match(sections.device, /No command execution tool/);
  assert.doesNotMatch(sections.device, /Ubuntu|Use bash/);
  await assert.rejects(harness.commit(tx => configurePrompt(tx, main.id, { sections: ['unknown'] }), context), /Unknown context sections/);
  await harness.commit(tx => configurePrompt(tx, main.id, { sections: [], transcript: 'must not leak' }), context);
  await send(main);
  assert.deepEqual(activeSections(requests[1]), {});
});

test('project guidance is retained for helpers with an explicit capability boundary', async t => {
  const guide = 'Use app_update to apply. Keep secrets out of logs.';
  const { main, requests } = await fixture(t, { projectGuide: guide });
  await main.configure({ tools: [] }, context);
  await send(main);
  const sections = activeSections(requests[0]);
  assert.match(sections['agents-guide'], /Operations involving subagent, app_update, app_install_apk belong to the main agent/);
  assert.ok(sections['agents-guide'].includes(guide));
});
