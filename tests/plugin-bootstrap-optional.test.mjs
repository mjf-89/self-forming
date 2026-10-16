// plugin-bootstrap.js composes without the optional dev tools module (it is not part of every
// edition): a missing module is silent, a broken one is reported, neither stops composition.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { startPluginComposition } = await app.load('plugin-bootstrap.js');

const bridge = { call: async (method) => { throw new Error(`unexpected ${method}`); } };
async function compose(loadDevTools) {
  const reports = [];
  const composition = await startPluginComposition({
    bridge, hostInfo: { platform: 'android', capabilities: {} }, loadDevTools,
    openExecution: () => { throw new Error('no execution'); }, onError: (error, details) => reports.push([details?.phase, error.message])
  });
  const ids = composition.runtime.list().map((record) => record.id);
  await composition.runtime.close();
  return { composition, reports: reports.filter(([phase]) => phase === 'dev-tools'), ids };
}
const notFound = (message, code) => Object.assign(new TypeError(message), code ? { code } : {});

test('a missing optional module (Node, Chrome, Firefox, Safari wording) adds nothing and reports nothing', async () => {
  const baseline = await compose(async () => ({}));
  assert.deepEqual(baseline.reports, []);
  for (const error of [
    notFound("Cannot find module '/x/optional.js'", 'ERR_MODULE_NOT_FOUND'),
    notFound('Failed to fetch dynamically imported module: https://app/optional.js'),
    notFound('error loading dynamically imported module: https://app/optional.js'),
    notFound('Importing a module script failed.')
  ]) {
    const { composition, reports, ids } = await compose(async () => { throw error; });
    assert.deepEqual(reports, [], error.message);
    assert.equal(composition.devTools, undefined);
    assert.equal(ids[0], 'core-execution');
    assert.deepEqual(ids, baseline.ids, 'exactly the composition of an empty optional module');
    assert.ok(ids.includes('core-tools'), 'the core agent plugins are composed as usual');
  }
});

test('a present but broken optional module is reported; composition still completes', async () => {
  const broken = await compose(async () => { throw new SyntaxError('Unexpected token'); });
  assert.deepEqual(broken.reports, [['dev-tools', 'Unexpected token']]);
  assert.ok(broken.ids.includes('core-tools'));
  const throwing = await compose(async () => ({ createDevPlugins() { throw new Error('bad definitions'); } }));
  assert.deepEqual(throwing.reports, [['dev-tools', 'bad definitions']]);
  assert.ok(throwing.ids.includes('core-tools'));
});

test('an optional module contributes definitions and starts after the runtime', async () => {
  const order = [];
  const extra = { id: 'optional-extra', version: '1.0.0', provides: [], requires: [], uses: [], setup() { order.push('setup'); } };
  const { composition, reports, ids } = await compose(async () => ({
    createDevPlugins: ({ browser }) => { order.push(`create:${browser}`); return [extra]; },
    startDevTools: async ({ runtime }) => { order.push(`start:${runtime.list().find((record) => record.id === 'optional-extra').state}`); return 'tools'; }
  }));
  assert.deepEqual(reports, []);
  assert.deepEqual(order, ['create:false', 'setup', 'start:active']);
  assert.equal(composition.devTools, 'tools');
  assert.deepEqual(ids.slice(0, 2), ['core-execution', 'optional-extra']);
});
