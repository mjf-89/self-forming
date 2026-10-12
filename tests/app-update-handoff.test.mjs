import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppUpdateHandoff } from '../apps/on-device/app-update-handoff.js';

const call = { taskId: 42, conversationId: 1, callId: 'update-call' };
const committed = (entry = {}, result = {}) => ({ changes: [{ type: 'entry', value: {
  kind: 'pi.tool-result', byTaskId: call.taskId, conversationId: call.conversationId,
  model: [{ role: 'toolResult', toolName: 'app_update', toolCallId: call.callId,
    isError: false, details: { action: 'apply', staged: true, revision: 'revision' }, ...result }], ...entry
} }] });

test('only the updating tool commit activates; notification leaves the commit observer and happens once', async () => {
  const ready = [];
  const handoff = createAppUpdateHandoff(revision => ready.push(revision));
  handoff.stage('revision', call);
  handoff.committed(committed({ byTaskId: 123 }));
  handoff.committed(committed({ conversationId: 123 }));
  handoff.committed(committed({}, { toolCallId: 'another-call' }));
  await Promise.resolve();
  assert.deepEqual(ready, []);
  handoff.committed(committed());
  handoff.committed(committed());
  assert.deepEqual(ready, [], 'No Session API may run inside the commit observer');
  await Promise.resolve();
  assert.deepEqual(ready, ['revision']);
  handoff.committed(committed());
  await Promise.resolve();
  assert.deepEqual(ready, ['revision']);
});

test('failed or changed results, Stop, close, and superseded staging never activate stale edits', async () => {
  for (const cancel of [
    handoff => handoff.committed(committed({}, { isError: true })),
    handoff => handoff.committed(committed({}, { details: { action: 'apply', staged: true, revision: 'other' } })),
    handoff => { handoff.committed(committed()); handoff.clear(); },
    handoff => { handoff.committed(committed()); handoff.close(); },
    handoff => { handoff.committed(committed()); handoff.stage('other', { ...call, taskId: 43 }); }
  ]) {
    const ready = [];
    const handoff = createAppUpdateHandoff(revision => ready.push(revision));
    handoff.stage('revision', call);
    cancel(handoff);
    await Promise.resolve();
    assert.deepEqual(ready, []);
  }
});
