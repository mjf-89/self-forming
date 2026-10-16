import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';

// Durable generation retries (pi-durable README "Settings", spec §8.3) as the app configures them
// (session-engine.js RETRY_SETTINGS): retryable errors are retried far beyond upstream's default 3,
// with upstream's backoff; a non-retryable error still ends the run; while the run waits,
// pi.live.generation.retry is the snapshot's `retry` (the chat's one status line). Failed attempts stay
// in the transcript but not in the model context. Real Harness + faux provider. No device or network.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, engine, pd, ai, faux, chord;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  engine = await app.load('session-engine.js');
  pd = await app.load('library/pi-durable.js');
  ai = await app.load('library/pi-ai.js');
  faux = await app.load('library/pi-ai/providers/faux.js');
  chord = await app.load('library/chord/context.js');
});
after(async () => { await app?.remove(); });

test('the app retry policy: 1000 retries, upstream backoff (2 s doubling), capped at 60 s', { skip }, () => {
  assert.deepEqual({ ...engine.RETRY_SETTINGS }, { maxRetries: 1000, maxAgentDelayMs: 60000 });
  const policy = { ...pd.DEFAULT_RETRY_POLICY, ...engine.RETRY_SETTINGS };
  assert.equal(policy.enabled, true);
  assert.equal(policy.baseDelayMs, 2000, 'upstream base delay kept');
  assert.deepEqual([1, 2, 3, 6, 7, 50].map((attempt) => ai.retryDelayMs(policy, attempt)), [2000, 4000, 8000, 60000, 60000, 60000]);
});

async function run(errors, { retryable = true } = {}) {
  const ctx = chord.BACKGROUND_CONTEXT;
  const models = ai.createModels();
  const provider = faux.fauxProvider({ tokensPerSecond: 0 });
  models.setProvider(provider.provider);
  const message = retryable ? 'Connection error.' : 'Invalid API key';
  provider.setResponses([...Array.from({ length: errors }, () => faux.fauxAssistantMessage('', { stopReason: 'error', errorMessage: message })), faux.fauxAssistantMessage('recovered')]);
  const registry = pd.createRegistry();
  // The app's policy with a short base delay so the test does not wait minutes; maxRetries is the app's.
  const harness = await pd.Harness.open(new pd.MemoryStorage(), { models, registry, settings: { retry: { ...engine.RETRY_SETTINGS, baseDelayMs: 5 } } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const retries = [];
  const watch = await root.watch(ctx);
  watch.start(async (value) => {
    const snap = engine.retrySnapshot(value.docs['pi.live']);
    if (snap.retry) retries.push(snap.retry);
  });
  const settled = await (await root.submit({ type: 'input', content: 'hi' }, ctx)).wait(ctx);
  await watch.stop();
  const view = await root.context(ctx);
  const entries = (await root.entries({}, 100, undefined, ctx)).items;
  await harness.close(ctx);
  return { settled, retries, view, entries };
}

test('six retryable failures in a row: the run keeps retrying and answers; the failures are not model context', { skip }, async () => {
  const { settled, retries, view, entries } = await run(6);
  assert.equal(settled.status, 'done', 'not ended by a transient error (upstream default would stop after 3)');
  const attempts = [...new Set(retries.map((retry) => retry.attempt))];
  assert.deepEqual(attempts, [1, 2, 3, 4, 5, 6], 'one retry status per failed attempt');
  assert.ok(retries.every((retry) => retry.error === 'Connection error.' && typeof retry.at === 'number'));
  const errorEntries = entries.filter((entry) => entry.kind === 'pi.assistant' && entry.model?.[0]?.stopReason === 'error');
  assert.equal(errorEntries.length, 6, 'each failed attempt is an error entry in the transcript (the chat collapses them)');
  assert.ok(!view.messages.some((message) => message.role === 'assistant' && message.stopReason === 'error'), 'error replies are not sent to the model');
  assert.equal(engine.retrySnapshot({ generation: { attempt: 2, retry: { at: 5, error: 'x' } } }).retry, undefined, 'no run, no retry line');
});

test('a non-retryable error still ends the run at once', { skip }, async () => {
  const { settled, retries } = await run(1, { retryable: false });
  assert.equal(settled.status, 'unanswered');
  assert.equal(settled.reason, 'model_error');
  assert.equal(retries.length, 0);
});
