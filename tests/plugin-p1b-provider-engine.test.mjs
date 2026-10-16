import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { TOKENS, fakeFetch, keptStorage, openSession, unauthorized } from './plugin-p0-support.mjs';

// Step P1b of docs/plugins-providers-agent-core.md: the session provider engine
// (session-providers.js) and the rows' create(host). Behaviour is pinned end to end by
// plugin-p0-providers.test.mjs (must stay identical); this test adds what P1b promised on
// top: (1) the OpenAI key (secret/apiKey) never reaches a commit or a snapshot, checked
// by source scan AND by a runtime spy on storage.commit; (2) the ordering constraints:
// recovery.wait before credential resolution, transient keys cleared when the session
// goes idle and on close, recovery restored from credential subscribe and at startup
// for non-transient-key modes. Mocked hosts, dummy keys; not on-device verification.
const root = new URL('..', import.meta.url).pathname;
const source = (name) => readFile(join(root, name.startsWith('plugins/') ? '' : 'apps/common', name), 'utf8');
/** Source without comments (scans look at code, not at explanations). */
const code = async (name) => (await source(name)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-ai/pi-durable) is not present';
const KEY = TOKENS.openai;
const leaks = (text) => text.includes(KEY) || text.includes(KEY.slice(8));
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
let app, deps;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    env: await app.load('library/pi-durable/env.js')
  };
});
after(async () => { await app?.remove(); });

// ---- source scans --------------------------------------------------------------------
/** The balanced (...) argument text of every `name(` call in a source text. */
function callArguments(text, name) {
  const found = [];
  const pattern = new RegExp(String.raw`\b${name}\(`, 'g');
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    found.push(text.slice(start, i + 1));
  }
  return found;
}
const SECRET_WORDS = /apiKey|secret|[tT]ransientKey|\bkeys\.|\bsetTransient/;

test('session.js keeps no provider code and never handles the key itself', async () => {
  // session.js is split (C3a-c): the parts of the session engine are checked together.
  const text = (await Promise.all(['session.js', 'session-engine.js', 'plugins/core-conversations/web/session-tail.js', 'plugins/core-conversations/web/session-threads.js'].map((name) => code(name)))).join('\n');
  for (const gone of ['apiKey', 'secret', 'createProvider', 'fauxProvider', 'OPENAI_MODELS', 'ANTHROPIC_MODELS', 'safeModelErrorResponse',
    'streamClaude', 'installProvider', 'providerCatalog', 'chatgptModel', 'configureProvider', 'registerSavedProvider', 'restoreRecoveryAuth', 'offlineStep'])
    assert.ok(!new RegExp(String.raw`\b${gone}\b`).test(text), `session.js still has ${gone}`);
  for (const mode of ['"chatgpt"', '"claude"', '"openai"']) assert.ok(!text.includes(mode), `session.js still names the mode ${mode}`);
  assert.match(text, /import \{ createSessionProviders \} from "\.\/session-providers\.js";/);
  // Every commit callback and every snapshot assignment is free of key material.
  const commits = callArguments(text, 'commit');
  assert.ok(commits.length >= 10, `found ${commits.length} commits`);
  for (const body of commits) {
    assert.ok(!SECRET_WORDS.test(body), `a commit mentions key material:\n${body.slice(0, 300)}`);
    // A send's config (which may carry the typed key) is only written through the whitelist.
    assert.ok(!/\bconfig\b/.test(body.replaceAll('providers.normalize(config)', '')), `a commit writes a raw config:\n${body.slice(0, 300)}`);
  }
  for (const match of text.matchAll(/snapshot = \{[^;]*\};/gs)) assert.ok(!SECRET_WORDS.test(match[0]), `a snapshot mentions key material: ${match[0].slice(0, 200)}`);
  // What send writes to ThreadsDoc is the engine's whitelist normalizer.
  assert.match(text, /state\.threads\[String\(id\)\]\.modelSettings = providers\.normalize\(config\);/);
});

test('the engine and the rows never touch storage, and the key stays in the engine', async () => {
  for (const name of ['session-providers.js', 'core-providers.js', 'plugins/core-providers-offline/web/provider.js', 'plugins/core-providers-openai/web/provider.js', 'plugins/core-providers-chatgpt/web/provider.js', 'plugins/core-providers-claude/web/provider.js']) {
    const text = await code(name);
    for (const word of ['commit(', 'tx.doc', 'configure(tx', 'harness.', 'storage.', 'Storage', 'console.'])
      assert.ok(!text.includes(word), `${name} uses ${word}`);
  }
  const engine = await code('session-providers.js');
  // The key Map is only set, cleared and read; never passed on as a whole.
  assert.deepEqual([...new Set([...engine.matchAll(/\bkeys\.(\w+)/g)].map((m) => m[1]))].sort(), ['clear', 'get', 'set']);
  const bare = [...engine.matchAll(/(?<!\.)\bkeys\b(?!\.)/g)].map((m) => engine.slice(m.index - 6, m.index + 16));
  assert.deepEqual(bare, ['const keys = new Map()'], 'the key Map escapes as a value');
  // Rows only learn whether a key is held (no key value), except choose() which reads the typed one.
  assert.match(engine, /hasTransientKey: Boolean\(keys\.get\(mode\)\)/);
  const openai = await source('plugins/core-providers-openai/web/provider.js');
  assert.deepEqual([...openai.matchAll(/apiKey/g)].length, 2, 'the openai row reads config.apiKey only in choose()');
});

test('ordering: recovery.wait comes before any credential in the composed resolve', async () => {
  const engine = await source('session-providers.js');
  const at = engine.indexOf('resolve: async ({ signal }) => {');
  assert.ok(at > 0, 'resolve moved');
  const body = engine.slice(at, engine.indexOf('} } },', at));
  const wait = body.indexOf('await recovery.wait(mode, signal);');
  assert.ok(wait > 0, 'resolve awaits recovery.wait');
  for (const after of ['keys.get(mode)', 'instance.credential(signal)']) assert.ok(body.indexOf(after) > wait, `${after} before recovery.wait`);
  // Clearing points in session.js: idle (refreshActivity) and close, right after harness.close starts.
  const text = await source('session-engine.js');
  assert.equal([...text.matchAll(/providers\.clearTransientKeys\(\)/g)].length, 2);
  assert.match(text, /if \(!next && !queued && !sending\) providers\.clearTransientKeys\(\);/);
  assert.match(text, /const closing = harness\.close\(context\);\n\s+providers\.clearTransientKeys\(\);/);
  // Restore: from credential subscribe (engine) and at startup for non transient-key modes (session.js).
  assert.match(engine, /instance\.subscribe\?\.\(\(state\) => \{\n\s+if \(state\.signedIn\) void restore\(mode\);/);
  assert.match(text, /for \(const mode of providers\.recovering\) if \(providers\.rowOf\(mode\)\.auth !== "transient-key"\) void providers\.restore\(mode\);/);
  // The subscriptions are made after the startup holds (the immediate callback must find them).
  const registerSaved = engine.slice(engine.indexOf('const registerSaved = (refs) => {'));
  assert.ok(registerSaved.indexOf('registerSavedMode(mode, list)') < registerSaved.indexOf('instance.subscribe?.('));
});

// ---- runtime: the engine alone with fake rows --------------------------------------------
async function engineFixture() {
  const { createSessionProviders } = await app.load('session-providers.js');
  const { createRecoveryGate } = await app.load('recovery.js');
  const { providerRow: offline } = await app.load('builtin/core-providers-offline/web/provider.js');
  const log = [];
  const installed = new Map();
  const listeners = new Set();
  const model = (id, provider) => ({ id, name: id, api: 'openai-responses', provider, reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const base = { catalogModel: () => undefined, thinkingEfforts: () => [], fastModel: () => undefined, listed: true, defaultModelId: 'm1' };
  const account = Object.freeze({ ...base, mode: 'acct', providerIds: ['acct-id'], label: 'Acct', requestLabel: 'ChatGPT', waitingLabel: 'Acct', auth: 'account', order: 10,
    catalog: () => [model('m1', 'acct-id')],
    create: () => ({
      subscribe: (listener) => { listeners.add(listener); listener({ signedIn: false }); return () => listeners.delete(listener); },
      credential: async () => { log.push('credential'); return { auth: { apiKey: 'acct-token-not-real' } }; },
      models: async () => { log.push('models'); return [model('m1', 'acct-id')]; },
      savedModels: () => [model('m1', 'acct-id')],
      choose: async () => ({ model: model('m1', 'acct-id'), list: [model('m1', 'acct-id')] }),
      streams: { stream: () => {}, streamSimple: () => {} }
    }) });
  const keyed = Object.freeze({ ...base, mode: 'keyed', providerIds: ['keyed-id'], label: 'Keyed', requestLabel: 'OpenAI', waitingLabel: 'Keyed', auth: 'transient-key', order: 20,
    catalog: () => [model('m1', 'keyed-id')],
    create: () => ({
      models: async (signal, { hasTransientKey }) => { if (!hasTransientKey) throw new Error('no key'); return [model('m1', 'keyed-id')]; },
      savedModels: () => [model('m1', 'keyed-id')],
      choose: async (config) => ({ model: model('m1', 'keyed-id'), list: [model('m1', 'keyed-id')], key: config.apiKey.trim() }),
      streams: { stream: () => {}, streamSimple: () => {} }
    }) });
  const recovery = createRecoveryGate(() => {});
  const wait = recovery.wait;
  recovery.wait = (mode, signal) => { log.push(`wait:${mode}`); return wait(mode, signal); };
  const stored = new Map();
  const providers = createSessionProviders({
    models: { setProvider: (provider) => installed.set(provider.id, provider) },
    rows: [offline, account, keyed],
    recovery,
    host: { transport: () => async () => new Response('{}'), credentials: {}, messages: { textOf: () => '', attachedUserPresentation: () => undefined } },
    storedModel: async (id) => stored.get(id)
  });
  const resolve = (id) => installed.get(id).auth.apiKey.resolve({ signal: new AbortController().signal });
  return { providers, recovery, installed, log, listeners, stored, resolve };
}

test('engine: recovery.wait resolves before the credential; restore follows subscribe; close stops it', { skip }, async () => {
  const { providers, recovery, installed, log, listeners, resolve } = await engineFixture();
  assert.ok(installed.has('faux'), 'the offline demo is installed at once');
  providers.registerSaved([{ provider: 'acct-id', modelId: 'm1' }, { provider: 'faux', modelId: 'faux-1' }, { provider: 'keyed-id', modelId: 'm1' }]);
  assert.deepEqual(providers.recovering, ['acct', 'keyed']);
  assert.ok(recovery.has('acct') && recovery.has('keyed'));
  assert.equal(listeners.size, 1, 'subscribed after the holds');
  const pending = resolve('acct-id');
  await settle(20);
  assert.deepEqual(log, ['wait:acct'], 'no credential while held');
  for (const listener of listeners) listener({ signedIn: true });
  assert.deepEqual(await pending, { auth: { apiKey: 'acct-token-not-real' } });
  assert.deepEqual(log, ['wait:acct', 'models', 'credential'], 'restore (models) released the hold, then the credential was read');
  assert.ok(!recovery.has('acct'));
  // The keyed hold is only released by a key.
  assert.ok(recovery.has('keyed'));
  providers.close();
  assert.equal(listeners.size, 0, 'close unsubscribes');
  recovery.hold('acct');
  await providers.restore('acct');
  assert.ok(recovery.has('acct'), 'no restore after close');
});

test('engine: the transient key is used by resolve only, and cleared keys are gone', { skip }, async () => {
  const { providers, resolve, stored, recovery } = await engineFixture();
  const result = await providers.configure({ mode: 'keyed', modelId: 'm1', apiKey: ` ${KEY} ` });
  assert.ok(!leaks(JSON.stringify(result)), 'configure returns no key');
  assert.ok(!leaks(JSON.stringify(providers)) && !leaks(JSON.stringify(Object.keys(providers))), 'the engine object exposes no key');
  assert.deepEqual(await resolve('keyed-id'), { auth: { apiKey: KEY } }, 'trimmed key in the auth resolve');
  providers.clearTransientKeys();
  assert.equal(await resolve('keyed-id'), undefined, 'no key after clearing');
  // ensureStored: a stored keyed conversation without a key is held, with a key released.
  stored.set(5, { provider: 'keyed-id', modelId: 'm1' });
  await providers.ensureStored(5, {});
  assert.ok(recovery.has('keyed'));
  await providers.ensureStored(5, { apiKey: KEY });
  assert.ok(!recovery.has('keyed'));
  assert.deepEqual(await resolve('keyed-id'), { auth: { apiKey: KEY } });
  providers.close();
});

// ---- runtime: the real session with a storage.commit spy ---------------------------------
/** Kept memory storage that records every commit argument (JSON, binary-safe). */
function spyStorage() {
  const storage = keptStorage(deps.pd);
  const commits = [];
  const commit = storage.commit.bind(storage);
  storage.commit = async (...args) => {
    const seen = new WeakSet();
    commits.push(JSON.stringify(args, (key, value) => {
      if (typeof value === 'bigint') return String(value);
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[seen]';
        seen.add(value);
      }
      return value;
    }));
    return commit(...args);
  };
  return { storage, commits };
}
/** Every published snapshot, as JSON. */
function watchSnapshots(opened) {
  const seen = [];
  opened.subscribe((snapshot) => seen.push(JSON.stringify(snapshot)));
  return seen;
}
const idle = (opened) => !opened.snapshot.busy && !opened.snapshot.anyBusy && opened.snapshot.messages.at(-1)?.role === 'assistant' && !opened.snapshot.messages.at(-1)?.pending;
function assertClean(name, commits, snapshots) {
  assert.ok(commits.length > 0, `${name}: the spy saw commits`);
  assert.ok(commits.some((text) => text.includes('"mode":"openai"')), `${name}: the spy sees document writes`);
  for (const text of commits) assert.ok(!leaks(text), `${name}: a commit carries the key`);
  for (const text of snapshots) assert.ok(!leaks(text), `${name}: a snapshot carries the key`);
}

test('runtime: sends with the key, idle clearing, sendTo with a key, refused sends and errors never commit it', { skip, timeout: 120000 }, async () => {
  const { storage, commits } = spyStorage();
  const transport = fakeFetch(({ body }) => {
    const text = JSON.stringify(body.input ?? []);
    if (text.includes('echo the key')) return unauthorized(KEY);
    return undefined;
  });
  const opened = await openSession(deps, 'offline', storage, { fetch: transport.fetch });
  const snapshots = watchSnapshots(opened);
  try {
    await opened.send('hello key', { mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: ` ${KEY} ` });
    await until(() => transport.requests.length === 1 && idle(opened), 'the keyed reply did not finish');
    assert.equal(transport.requests[0].values.authorization, 'Bearer <openai-token>', 'the key was used for the request');
    // Idle: refreshActivity clears the key; a stored-provider send without a key waits for one.
    await settle(600);
    await opened.sendTo(1, 'without key', {});
    await until(() => opened.snapshot.paused === true, 'a send without the cleared key did not wait');
    assert.deepEqual(opened.snapshot.recoveryProviders, ['openai']);
    assert.equal(transport.requests.length, 1, 'no request without a key');
    await opened.sendTo(1, 'with key', { apiKey: KEY });
    await until(() => transport.requests.length >= 2 && idle(opened) && !opened.snapshot.paused, 'the keyed sendTo did not run');
    assert.equal(transport.requests[1].values.authorization, 'Bearer <openai-token>');
    await settle(600);
    // Refused after the key was taken (bad thinking effort): settings are saved first, never the key.
    await assert.rejects(opened.send('bad effort', { mode: 'openai', modelId: 'gpt-4.1-mini', thinkingEffort: 'high', apiKey: KEY }), /thinking effort/);
    // A provider error that echoes the key is stored redacted.
    const before = transport.requests.length;
    await opened.send('echo the key', { mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: KEY });
    await until(() => transport.requests.length > before && idle(opened) && opened.snapshot.messages.at(-1).error, 'the 401 error reply did not finish');
    assert.match(opened.snapshot.messages.at(-1).text, /OpenAI request failed \(401\)/);
  } finally {
    await opened.close();
  }
  assertClean('sends', commits, snapshots);
});

test('runtime: recovery after close needs the key again; resume with it never commits it', { skip, timeout: 120000 }, async () => {
  const { storage, commits } = spyStorage();
  const first = fakeFetch(() => 'hang');
  let opened = await openSession(deps, 'offline', storage, { fetch: first.fetch });
  const snapshots = watchSnapshots(opened);
  try {
    await opened.send('Interrupted reply.', { mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: KEY });
    await until(() => first.requests.length === 1, 'the first request was not made');
  } finally {
    await opened.close();
  }
  const second = fakeFetch(() => ({ text: 'Recovered reply.' }));
  opened = await openSession(deps, 'offline', storage, { fetch: second.fetch });
  snapshots.push(...watchSnapshots(opened));
  try {
    await until(() => opened.snapshot.paused === true, 'did not pause without a key');
    await settle(100);
    assert.equal(second.requests.length, 0, 'close dropped the key: nothing runs before it is typed again');
    await assert.rejects(opened.resume({ mode: 'openai', modelId: 'gpt-4.1-mini' }), /Enter your OpenAI API key/);
    await opened.resume({ mode: 'openai', modelId: 'gpt-4.1-mini', apiKey: KEY });
    await until(() => second.requests.length === 1 && idle(opened) && !opened.snapshot.paused, 'did not resume with the key');
    assert.equal(second.requests[0].values.authorization, 'Bearer <openai-token>');
  } finally {
    await opened.close();
  }
  assertClean('recovery', commits, snapshots);
});
