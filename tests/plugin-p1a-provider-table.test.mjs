import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';

// Step P1a of docs/plugins-providers-agent-core.md: the static provider table
// (core-providers.js + core-provider-{offline,openai,chatgpt,claude}.js). Behaviour is
// pinned end to end by plugin-p0-providers.test.mjs; this test compares the table's pure
// functions with a verbatim copy of the pre-P1a session.js code over a wide input
// matrix (including the odd behaviour kept on purpose: unknown modes -> offline, chatgpt
// "" -> gpt-4.1-mini for static thinking lookups), and checks the module boundaries.
// Node only; not on-device verification.
const root = new URL('..', import.meta.url).pathname;
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai) is not present';
let app, ai, table, rows, session, OPENAI_MODELS, ANTHROPIC_MODELS, legacy;

/** Verbatim pre-P1a session.js (static part), parameterized with the library. */
function legacyFunctions({ getSupportedThinkingLevels, clampThinkingLevel }) {
  const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
  const CHATGPT_PROVIDER = 'openai-chatgpt';
  const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
  const CLAUDE_MODELS = Object.values(ANTHROPIC_MODELS).map(({ id, name }) => ({ id, name }));
  function catalogModel({ mode, modelId }) {
    if (mode === 'claude') return Object.values(ANTHROPIC_MODELS).find((model) => model.id === (modelId || DEFAULT_CLAUDE_MODEL));
    if (mode === 'openai' || mode === 'chatgpt') return Object.values(OPENAI_MODELS).find((model) => model.id === (modelId || DEFAULT_OPENAI_MODEL));
  }
  function getThinkingEfforts(config) {
    const model = catalogModel(config);
    return model?.reasoning ? getSupportedThinkingLevels(model) : [];
  }
  function thinkingFor(model, requested) {
    if (requested !== void 0 && requested !== '' && !getSupportedThinkingLevels(model).includes(requested))
      throw new Error('Choose a thinking effort supported by this model.');
    return clampThinkingLevel(model, requested || 'off');
  }
  function modelSettings(value = {}) {
    const mode = ['offline', 'openai', 'chatgpt', 'claude'].includes(value.mode) ? value.mode : 'offline';
    const modelId = mode === 'offline' ? 'faux-1' : typeof value.modelId === 'string' ? value.modelId.trim().slice(0, 300) : '';
    const thinkingEffort = typeof value.thinkingEffort === 'string' && getThinkingEfforts({ mode, modelId }).includes(value.thinkingEffort) ? value.thinkingEffort : '';
    return { mode, modelId, thinkingEffort };
  }
  function agentModelSettings(agent) {
    const provider = agent?.model?.provider;
    return modelSettings({
      mode: provider === CHATGPT_PROVIDER ? 'chatgpt' : provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'openai' : 'offline',
      modelId: agent?.model?.modelId,
      thinkingEffort: agent?.thinkingLevel
    });
  }
  const providerIdOf = (kind) => kind === 'claude' ? 'anthropic' : kind === 'chatgpt' ? CHATGPT_PROVIDER : kind === 'openai' ? 'openai' : 'faux';
  const kindOfProvider = (provider) => provider === 'anthropic' ? 'claude' : provider === CHATGPT_PROVIDER ? 'chatgpt' : provider === 'openai' ? 'openai' : 'offline';
  const updateMode = (agent) => agent?.model?.provider === CHATGPT_PROVIDER ? 'chatgpt' : agent?.model?.provider === 'anthropic' ? 'claude' : agent?.model?.provider === 'openai' ? 'openai' : 'offline';
  const fastModelOf = (kind, list) => {
    const preferred = kind === 'claude' ? ['claude-haiku-4-5'] : kind === 'openai' ? ['gpt-4.1-mini'] : [];
    return list.find((m) => preferred.includes(m.id)) ?? list.find((m) => /mini|nano|haiku|flash|small/i.test(m.id)) ?? list[0];
  };
  return { DEFAULT_OPENAI_MODEL, DEFAULT_CLAUDE_MODEL, CLAUDE_MODELS, catalogModel, getThinkingEfforts, thinkingFor, modelSettings, agentModelSettings, providerIdOf, kindOfProvider, updateMode, fastModelOf };
}

const outcome = (fn) => {
  try { return { value: fn() }; } catch (error) { return { error: `${error?.constructor?.name}: ${error?.message}` }; }
};

before(async () => {
  if (!available) return;
  app = await assembleApp();
  ai = await app.load('library/pi-ai.js');
  ({ OPENAI_MODELS } = await app.load('library/pi-ai/providers/openai.models.js'));
  ({ ANTHROPIC_MODELS } = await app.load('library/pi-ai/providers/anthropic.models.js'));
  const providers = await app.load('core-providers.js');
  rows = await providers.loadCoreProviderRows();
  table = providers.createProviderTable(rows, ai);
  session = await app.load('session.js');
  legacy = legacyFunctions(ai);
});
after(async () => { await app?.remove(); });

const MODES = ['offline', 'openai', 'chatgpt', 'claude', '', 'bogus', 'Offline', 'provider:faux', '__proto__', 'toString', undefined, null, 7];
const PROVIDERS = ['faux', 'openai', 'openai-chatgpt', 'anthropic', '', 'OpenAI', 'llama-local', '__proto__', 'constructor', undefined, null];
const modelIds = () => [
  undefined, null, '', '   ', 7, 'faux-1', 'unknown-model', ' gpt-4.1-mini ', 'x'.repeat(400),
  ...Object.values(OPENAI_MODELS).map((model) => model.id), ...Object.values(ANTHROPIC_MODELS).map((model) => model.id),
  'gpt-account-only'
];
const EFFORTS = [undefined, null, '', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'bogus', 3];

test('the table matches the pre-P1a static functions', { skip }, () => {
  let checked = 0;
  for (const mode of MODES) for (const modelId of modelIds()) {
    const config = { mode, modelId };
    assert.deepEqual(table.catalogModel(config), legacy.catalogModel(config), `catalogModel ${mode}/${modelId}`);
    assert.deepEqual(table.getThinkingEfforts(config), legacy.getThinkingEfforts(config), `getThinkingEfforts ${mode}/${modelId}`);
    for (const thinkingEffort of EFFORTS) {
      const value = { mode, modelId, thinkingEffort };
      assert.deepEqual(outcome(() => table.modelSettings(value)), outcome(() => legacy.modelSettings(value)), `modelSettings ${JSON.stringify(value)}`);
      checked++;
    }
  }
  for (const value of [undefined, {}, null, { mode: 'claude' }, { mode: 'chatgpt', thinkingEffort: 'high' }])
    assert.deepEqual(outcome(() => table.modelSettings(value)), outcome(() => legacy.modelSettings(value)), `modelSettings ${JSON.stringify(value)}`);
  for (const config of [undefined, null])
    assert.deepEqual(outcome(() => table.getThinkingEfforts(config)).error !== undefined, outcome(() => legacy.getThinkingEfforts(config)).error !== undefined, 'getThinkingEfforts throws alike');
  for (const provider of PROVIDERS) {
    assert.equal(table.modeOf(provider), legacy.kindOfProvider(provider), `modeOf ${provider}`);
    for (const modelId of modelIds()) for (const thinkingLevel of EFFORTS) {
      const agent = { model: { provider, modelId }, thinkingLevel };
      assert.deepEqual(table.agentModelSettings(agent), legacy.agentModelSettings(agent), `agentModelSettings ${JSON.stringify(agent)}`);
      assert.equal(table.modeOf(agent?.model?.provider), legacy.updateMode(agent), 'update() mode');
    }
  }
  for (const agent of [undefined, null, {}, { model: null }, { thinkingLevel: 'high' }]) {
    assert.deepEqual(table.agentModelSettings(agent), legacy.agentModelSettings(agent), `agentModelSettings ${JSON.stringify(agent)}`);
    assert.equal(table.modeOf(agent?.model?.provider), legacy.updateMode(agent), 'update() mode');
  }
  for (const mode of MODES) assert.equal(table.providerIdOf(mode), legacy.providerIdOf(mode), `providerIdOf ${mode}`);
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('thinkingFor and fastModelOf match the pre-P1a code', { skip }, () => {
  const all = [...Object.values(OPENAI_MODELS), ...Object.values(ANTHROPIC_MODELS)];
  for (const model of all) for (const requested of EFFORTS)
    assert.deepEqual(outcome(() => table.thinkingFor(model, requested)), outcome(() => legacy.thinkingFor(model, requested)), `thinkingFor ${model.id}/${requested}`);
  const lists = [
    Object.values(OPENAI_MODELS), Object.values(ANTHROPIC_MODELS), [...Object.values(ANTHROPIC_MODELS)].reverse(), [...Object.values(OPENAI_MODELS)].reverse(),
    [{ id: 'faux-1', name: 'Offline demo' }], [], [{ id: 'gpt-5' }, { id: 'gpt-4.1-mini' }, { id: 'gpt-account-only' }],
    [{ id: 'big' }, { id: 'Small-one' }], [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1-mini', name: 'second' }], [{ id: 'claude-haiku-4-5' }, { id: 'gpt-4.1-mini' }]
  ];
  for (const mode of MODES) for (const list of lists)
    assert.equal(table.fastModelOf(mode, list), legacy.fastModelOf(mode, list), `fastModelOf ${mode}/${list.map((m) => m.id)}`);
});

test('session.js keeps its exports and uses the table', { skip }, async () => {
  assert.deepEqual(Object.keys(session).sort(), ['CLAUDE_MODELS', 'DEFAULT_CLAUDE_MODEL', 'DEFAULT_OPENAI_MODEL', 'getThinkingEfforts', 'openAppSession']);
  assert.equal(session.DEFAULT_OPENAI_MODEL, legacy.DEFAULT_OPENAI_MODEL);
  assert.equal(session.DEFAULT_CLAUDE_MODEL, legacy.DEFAULT_CLAUDE_MODEL);
  assert.deepEqual(session.CLAUDE_MODELS, legacy.CLAUDE_MODELS);
  for (const mode of MODES) for (const modelId of modelIds())
    assert.deepEqual(session.getThinkingEfforts({ mode, modelId }), legacy.getThinkingEfforts({ mode, modelId }));
  const source = await readFile(join(root, 'apps/common/session-engine.js'), 'utf8');
  for (const gone of ['function catalogModel', 'function modelSettings', 'function agentModelSettings', 'const fastModelOf', '["offline", "openai", "chatgpt", "claude"]'])
    assert.ok(!source.includes(gone), `session.js still has ${gone}`);
  // The static rows session.js imports are exactly the table's built-in rows.
  const imported = [...source.matchAll(/import \{ providerRow as \w+ \} from "\.\/builtin\/core-providers-(\w+)\/web\/provider\.js";/g)].map((m) => m[1]).sort();
  assert.deepEqual(imported, ['chatgpt', 'claude', 'offline', 'openai']);
});

test('rows: permanent identifiers, order and shape', { skip }, () => {
  assert.deepEqual(table.modes, ['offline', 'claude', 'chatgpt', 'openai']);
  assert.deepEqual(rows.map((row) => [row.mode, [...row.providerIds], row.auth, row.defaultModelId, row.requestLabel, row.order, row.listed]), [
    ['offline', ['faux'], 'none', 'faux-1', 'Offline demo', 0, false],
    ['claude', ['anthropic'], 'account', 'claude-sonnet-4-6', 'Claude', 10, true],
    ['chatgpt', ['openai-chatgpt'], 'account', '', 'ChatGPT', 20, true],
    ['openai', ['openai'], 'transient-key', 'gpt-4.1-mini', 'OpenAI', 30, true]
  ]);
  for (const row of rows) {
    assert.ok(Object.isFrozen(row) && Object.isFrozen(row.providerIds), `${row.mode} is frozen`);
    for (const key of ['catalog', 'catalogModel', 'thinkingEfforts', 'fastModel']) assert.equal(typeof row[key], 'function', `${row.mode}.${key}`);
    // catalog() returns a fresh array each time (callers may push saved models into it).
    assert.notEqual(row.catalog(), row.catalog());
    assert.ok(/^[a-z][a-z0-9-]{1,63}$/.test(row.mode));
  }
  // Settings option texts and recovery names match index.html / app.js renderAuth today.
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.mode, row.label])), { offline: 'Offline demo', claude: 'Claude Code', chatgpt: 'ChatGPT', openai: 'OpenAI API key' });
  assert.deepEqual(Object.fromEntries(rows.filter((row) => row.listed).map((row) => [row.mode, row.waitingLabel])), { claude: 'Claude Code', chatgpt: 'ChatGPT', openai: 'OpenAI API key' });
});

test('createProviderTable rejects duplicates and needs the fallback row', { skip }, async () => {
  const [offline, claude] = rows;
  const { createProviderTable } = await app.load('core-providers.js');
  assert.throws(() => createProviderTable([offline, offline], ai), /Duplicate model provider mode "offline"/);
  assert.throws(() => createProviderTable([offline, claude, { ...claude, mode: 'claude2' }], ai), /Duplicate model provider id "anthropic"/);
  assert.throws(() => createProviderTable([claude], ai), /needs the "offline" row/);
});

test('core-providers.js loads without the bundled library or the row files', async () => {
  const source = await readFile(join(root, 'apps/common/core-providers.js'), 'utf8');
  // Its only import is the generated registry; the rows are loaded lazily by each plugin's entry.
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ['./builtin-plugins.js']);
  assert.ok(!/import\("/.test(source), 'core-providers.js imports a row module itself');
  const bare = await assembleApp({ withLibrary: false });
  try {
    const module = await bare.load('core-providers.js');
    assert.deepEqual(module.CORE_PROVIDER_ROWS.map((row) => [row.id, row.mode, row.order]), [
      ['core-providers-offline', 'offline', 0], ['core-providers-claude', 'claude', 10],
      ['core-providers-chatgpt', 'chatgpt', 20], ['core-providers-openai', 'openai', 30]
    ]);
    assert.equal(module.UNKNOWN_MODE_FALLBACK, 'offline');
  } finally {
    await bare.remove();
  }
  // Each plugin entry loads its row lazily; the offline row needs no library at all, the others
  // import only the pi-ai catalogs/helpers (the served path of the library is ../../../library/).
  for (const name of ['offline', 'openai', 'chatgpt', 'claude']) {
    const entry = await readFile(join(root, `plugins/core-providers-${name}/web/index.js`), 'utf8');
    // X4: the Claude entry also lazy-loads its sign-in (claude-auth.js) with native-host.js as last resort.
    // X4b: the ChatGPT entry does the same with chatgpt-auth.js.
    assert.deepEqual([...entry.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]), name === 'claude' ? ['./provider.js', './claude-auth.js', '../../../native-host.js'] : name === 'chatgpt' ? ['./provider.js', './chatgpt-auth.js', '../../../native-host.js'] : ['./provider.js'], `core-providers-${name} entry`);
    // S1a: the only static import is the DOM-only Settings panel (offline has none), which
    // imports only provider-panels.js (no library, no row).
    assert.deepEqual([...entry.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), name === 'offline' ? [] : ['./settings-panel.js'], `core-providers-${name} entry static imports`);
    if (name !== 'offline') {
      const panel = await readFile(join(root, `plugins/core-providers-${name}/web/settings-panel.js`), 'utf8');
      assert.deepEqual([...panel.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ['../../../provider-panels.js'], `core-providers-${name} panel imports`);
    }
    const text = await readFile(join(root, `plugins/core-providers-${name}/web/provider.js`), 'utf8');
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    const expected = name === 'offline' ? [] : ['../../../library/pi-ai.js', `../../../library/pi-ai/providers/${name === 'claude' ? 'anthropic' : 'openai'}.models.js`];
    assert.deepEqual(imports, expected, `core-providers-${name}/web/provider.js imports`);
  }
});
