import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { SECTIONS, captureSection, loadDeps } from './plugin-p0-capture.mjs';
import { TOKENS } from './plugin-p0-support.mjs';

// Step P0 of docs/plugins-providers-agent-core.md: today's model provider behaviour
// (offline, openai, chatgpt, claude), pinned before provider code moves into the
// provider table (P1a), the session engine (P1b) and agent.providers (P2). Real
// session.js / model-error.js with the bundled pi-ai/pi-durable library, mocked hosts,
// fake credential controllers (dummy tokens) and fake fetch transports with local SSE
// fixtures; no network or account. plugin-p0-providers.snapshot.json was captured by
// tests/plugin-p0-capture.mjs from the pre-P1 code. It documents current behaviour as
// is. Regenerated on purpose once, in P3 (docs §B1b), for exactly these changes: unknown
// modes are kept and refused instead of coerced to offline (modelSettings.unknownMode,
// migration.unknownProvider, send.unknownMode), a refused send no longer saves its model
// settings first (send.*: the refused built-in sends keep the previous settings), and a
// model error shows its one clean message (send.*Unauthorized). Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
const SNAPSHOT = JSON.parse(await readFile(new URL('./plugin-p0-providers.snapshot.json', import.meta.url), 'utf8'));
let app, deps;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = await loadDeps(app);
});
after(async () => { await app?.remove(); });

test('the snapshot covers every section and holds no credential', () => {
  assert.deepEqual(Object.keys(SNAPSHOT), SECTIONS);
  const text = JSON.stringify(SNAPSHOT);
  for (const token of Object.values(TOKENS)) assert.ok(!text.includes(token) && !text.includes(token.slice(8)), 'a dummy token reached the snapshot');
  assert.ok(!/"leaked":true/.test(text), 'a dummy credential leaked into rendered or stored text');
});

for (const section of SECTIONS) {
  test(`provider behaviour is unchanged: ${section}`, { skip, timeout: 300000 }, async () => {
    const now = await captureSection(deps, section);
    assert.deepEqual(Object.keys(now), Object.keys(SNAPSHOT[section]), `${section}: keys`);
    for (const key of Object.keys(SNAPSHOT[section])) assert.deepEqual(now[key], SNAPSHOT[section][key], `${section}/${key}`);
  });
}

// A few readable anchors of the pinned behaviour (the snapshot holds the full detail).
test('anchors: defaults, mode mapping and unknown modes kept (P3)', { skip }, () => {
  const { static: fixed, modelSettings, migration, send } = SNAPSHOT;
  assert.equal(fixed.DEFAULT_OPENAI_MODEL, 'gpt-4.1-mini');
  assert.equal(fixed.DEFAULT_CLAUDE_MODEL, 'claude-sonnet-4-6');
  assert.deepEqual(send.chatgptDefault.agent, { model: { provider: 'openai-chatgpt', modelId: 'gpt-5' }, thinkingLevel: 'minimal' }, 'ChatGPT "" = first account model');
  assert.deepEqual(send.openaiDefault.agent.model, { provider: 'openai', modelId: 'gpt-4.1-mini' });
  assert.deepEqual(send.claudeDefault.agent.model, { provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
  // P3: unknown modes are never coerced to offline. A write is refused before anything is
  // stored (the previous choice stays); a pi.agent provider no row owns reads as the
  // display-only mode provider:<id>, unavailable, and is not stored in ThreadsDoc.
  assert.equal(modelSettings.unknownMode.refused, 'llama-local is not available. Enable its plugin or choose another model.');
  assert.equal(modelSettings.unknownMode.mode, modelSettings.claudeBogusEffort.mode, 'the previous choice stays');
  assert.equal(migration.unknownProvider.mode, 'provider:llama-local');
  assert.deepEqual(migration.unknownProvider.modelSettings, { mode: 'provider:llama-local', modelId: 'llama-3', thinkingEffort: 'high', available: false, label: 'llama-local' });
  assert.deepEqual(migration.unknownProvider.storedThreads, {});
  assert.equal(send.unknownMode.error, 'llama-local is not available. Enable its plugin or choose another model.');
  assert.equal(send.unknownMode.threads.mode, 'offline', 'nothing was written (the initial choice)');
  // A refused send does not save its settings first; a 401 shows one clean message.
  assert.deepEqual(send.openaiNoKey.threads, { mode: 'offline', modelId: 'faux-1', thinkingEffort: '' });
  assert.equal(send.openaiUnauthorized.messages[1], 'assistant!: OpenAI request failed (401). Incorrect API key provided: [redacted]. Header was [redacted]. (invalid_request_error; invalid_api_key)');
});
