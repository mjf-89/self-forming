import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { promptsFor, subagentRunFor } from './plugin-a3-support.mjs';

// Subagents can select the `plugins` section: stored helper selections, a real `subagent run` with context
// ["device","plugins"], and the tool description / option list. Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, deps;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    prompts: await app.load('builtin/core-prompt/web/prompt-sections.js')
  };
});
after(async () => { await app?.remove(); });

const ROLE = 'You are a subagent helping the main assistant on the user\'s Android device. Do the task you are given and answer with a concise report of what you did and found. You cannot talk to the user.';
const helper = (sections) => ({ change: { instructions: ROLE, extensions: { remove: [{ name: 'self-forming-subagents' }] } }, prompt: { sections } });

test('helper selection: plugins only when the helper was given the section', { skip, timeout: 120000 }, async () => {
  const result = await promptsFor(deps, 'native', { text: true, helpers: { chosen: helper(['device', 'plugins']), notChosen: helper(['device', 'app']) } });
  assert.deepEqual(result.chosen.map(([key]) => key), ['device', 'skills', 'plugins', 'instructions']);
  assert.match(result.chosen.find(([key]) => key === 'plugins')[1], /plugins tool/);
  assert.deepEqual(result.notChosen.map(([key]) => key), ['device', 'app', 'skills', 'instructions']);
});

test('a real subagent run with context [device, plugins] gets the section; the default does not', { skip, timeout: 120000 }, async () => {
  const chosen = await subagentRunFor(deps, 'native', { context: ['device', 'plugins'] });
  assert.ok(chosen.child.tags.includes('plugins'), chosen.child.tags.join());
  const normal = await subagentRunFor(deps, 'native', {});
  assert.ok(!normal.child.tags.includes('plugins'));
});

test('context option list and tool description name it; unknown names are still refused', { skip }, async () => {
  const source = await readFile(new URL('../plugins/core-subagents/web/subagents.js', import.meta.url), 'utf8');
  assert.match(source, /var SECTIONS = \[[^\]]*"servers", "plugins", "agentsGuide"/);
  assert.match(source, /context: sections of your instructions to give it:[^`]*plugins \(grow the app through plugins/);
  const { configurePrompt } = deps.prompts.createPromptExtension({});
  const tx = { doc: async () => ({}) };
  await configurePrompt(tx, 'c', { sections: ['device', 'plugins'] });
  await assert.rejects(() => configurePrompt(tx, 'c', { sections: ['nope'] }), /Use: device, app, selfRebuild, subagents, servers, plugins, agentsGuide, transcript/);
});
