import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { keptStorage, openSession, waitForAbort } from './plugin-p0-support.mjs';
import { KEY, deliverFollowUp, markActivated, recordStaged } from '../apps/common/app-update-followup.js';

const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map }; };
const call = { taskId: 't1', conversationId: 'c1', callId: 'call1' };
const fakeSession = () => { const sent = []; const seen = new Set(); return { sent, async sendTo(id, text, config, options) { if (!seen.has(options.requestId)) { seen.add(options.requestId); sent.push({ id, text, options }); } } }; };

test('success: one follow-up to the applying conversation, then the record is cleared', async () => {
  const store = memory(), session = fakeSession();
  recordStaged('rev-2', call, store);
  assert.equal(await deliverFollowUp(session, 'rev-2', store), false, 'not activated: the reload did not happen, nothing is sent');
  assert.ok(store.map.has(KEY));
  markActivated('rev-2', store);
  assert.equal(await deliverFollowUp(session, 'rev-2', store), true);
  assert.deepEqual(session.sent, [{ id: 'c1', text: '[app updated to rev-2; startup OK. You can continue working.]',
    options: { whenBusy: 'follow-up', requestId: 'app-update:rev-2' } }]);
  assert.equal(store.map.has(KEY), false);
  assert.equal(await deliverFollowUp(session, 'rev-2', store), false, 'a second reload sends nothing');
  assert.equal(session.sent.length, 1);
});

test('restored: the previous revision is active, the message says so', async () => {
  const store = memory(), session = fakeSession();
  recordStaged('rev-2', call, store); markActivated('rev-2', store);
  assert.equal(await deliverFollowUp(session, 'rev-1', store), true);
  assert.equal(session.sent[0].text, '[app update rev-2 failed to start; the previous revision rev-1 was restored.]');
  assert.equal(store.map.has(KEY), false);
});

test('a crash before the record is cleared never delivers twice (stable requestId)', async () => {
  const store = memory(), session = fakeSession();
  recordStaged('rev-3', call, store); markActivated('rev-3', store);
  const kept = store.getItem(KEY);
  await deliverFollowUp(session, 'rev-3', store);
  store.setItem(KEY, kept); // clearing was lost
  await deliverFollowUp(session, 'rev-3', store);
  assert.equal(session.sent.length, 1);
});

const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, ai, chord, session;
before(async () => { if (!available) return; app = await assembleApp(); pd = await app.load('library/pi-durable.js'); ai = await app.load('library/pi-ai.js'); session = await app.load('session.js'); });
after(async () => { await app?.remove(); });

let n = 0;
const reply = (text) => { const id = ++n; const item = { type: 'message', id: `m${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [{ type: 'response.created', response: { id: `r${id}`, status: 'in_progress' } }, { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: text }, { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `r${id}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); };
const auth = () => ({ async getAccessToken() { return 'dummy-token'; }, async listModels() { return [{ id: 'gpt-4.1', name: 'Main' }]; }, subscribe() { return () => {}; } });

test('real session: a busy conversation queues the follow-up; the same requestId is not delivered twice', { skip, timeout: 30000 }, async () => {
  const storage = keptStorage(pd);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const prompts = [];
  const opened = await openSession({ session }, 'native', storage, { chatgpt: auth(), fetch: async (_url, init) => {
    prompts.push(JSON.stringify(JSON.parse(init.body).input));
    if (prompts.length === 1) { started.resolve(); await release.promise; return reply('first done'); }
    return reply('follow-up handled');
  } });
  try {
    const id = opened.snapshot.conversation.id;
    await opened.send('Do the work.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await started.promise;
    await until(() => opened.snapshot.busy, 'conversation did not become busy', 5000);
    const store = memory();
    recordStaged('rev-9', { ...call, conversationId: id }, store); markActivated('rev-9', store);
    assert.equal(await deliverFollowUp(opened, 'rev-9', store), true, 'busy conversation: submitted without error');
    await opened.sendTo(id, '[app updated to rev-9; startup OK. You can continue working.]', {}, { whenBusy: 'follow-up', requestId: 'app-update:rev-9' });
    assert.equal(prompts.length, 1, 'queued behind the running reply, not steered into it');
    release.resolve();
    await until(() => opened.snapshot.messages.some((m) => m.text === 'follow-up handled'), 'follow-up was not processed after the reply', 10000);
    const delivered = opened.snapshot.messages.filter((m) => m.text.startsWith('[app updated to rev-9'));
    assert.equal(delivered.length, 1, 'delivered exactly once');
    assert.equal(prompts.length, 2);
  } finally { release.resolve(); await opened.close(); }
});
