import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Step C0 (docs/plugins-providers-agent-core.md §B2/§D): static checks that the
// agent.sessions@1 / agent.harness@1 contracts in apps/common/agent-contracts.js
// cover every use of the session object and of the harness pieces in today's code.
// Grep-style scans: a new call site that the contract does not list fails here.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = (name) => readFile(`${root}apps/common/${name}`, 'utf8');
// Code only: string literal contents and line comments blanked (line numbers kept), so
// "./session.js" or a comment mentioning session.tree() is not taken for a call.
const code = async (name) => (await source(name))
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (literal) => literal[0] + ' '.repeat(literal.length - 2) + literal[0])
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const { AGENT_SESSIONS_V1: S, AGENT_HARNESS_V1: H, AGENT_CONTRACTS, SESSION_NOT_OPEN_MESSAGE } =
  await import(new URL('../apps/common/agent-contracts.js', import.meta.url));

// The conversations drawer is core-conversations since C7b.
const DRAWER = '../../plugins/core-conversations/web/conversations.js';
const sorted = (values) => [...new Set(values)].sort();
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('the contract module is plain frozen data without imports', async () => {
  const text = await source('agent-contracts.js');
  assert.doesNotMatch(text, /^\s*import\b|\bimport\s*\(/m, 'agent-contracts.js imports nothing');
  assert.ok(Object.isFrozen(S) && Object.isFrozen(S.methods) && Object.isFrozen(S.snapshot.required) && Object.isFrozen(H.storage) && Object.isFrozen(H.models));
  assert.deepEqual(Object.keys(AGENT_CONTRACTS).sort(), ['agent.harness@1', 'agent.sessions@1']);
  assert.equal(S.id, `${S.service}@${S.version}`);
  assert.equal(H.id, `${H.service}@${H.version}`);
  // groups == getters + methods, no duplicates, every method has a documented signature.
  const grouped = Object.values(S.groups).flat();
  assert.equal(new Set(grouped).size, grouped.length, 'a member is listed in two groups');
  assert.deepEqual(sorted(grouped), sorted([...S.getters, ...S.methods]));
  assert.deepEqual(sorted(Object.keys(S.signatures)), sorted(S.methods));
  for (const name of [...Object.keys(S.excluded), ...Object.keys(S.planned)]) assert.ok(!grouped.includes(name), `${name} is both in and out of the contract`);
  for (const name of H.forbidden) {
    assert.ok(![...H.values, ...H.methods, ...H.storage].includes(name), `${name} must never be on the harness handle`);
  }
  assert.equal(SESSION_NOT_OPEN_MESSAGE, S.notOpenMessage);
});

test('conversations.js throws the facade message while no session is open', async () => {
  const text = await source(DRAWER);
  assert.ok(text.includes(JSON.stringify(S.notOpenMessage)), 'the not-open text is conversations.js ready() text');
});

// --- Session consumers -----------------------------------------------------------------
// Identifiers that hold the session object in each consumer: names assigned from the
// session variable, getSession(), ready()/need() or openAppSession(), or given it as a
// parameter default. Names that hold a snapshot (`x = session?.snapshot`) are tracked so a
// snapshot read through them is checked against the snapshot keys instead.
const SESSION_SOURCES = String.raw`(?:session|getSession\??\.?\(\)|options\.getSession\(\)|ready\(\)|need\(\)|await openAppSession\()`;
function sessionAliases(text) {
  const aliases = new Set(['session']);
  const declared = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${SESSION_SOURCES}\s*(?:[;,\n)]|$)`, 'g');
  for (const match of text.matchAll(declared)) aliases.add(match[1]);
  for (const match of text.matchAll(/[(,]\s*(\w+)\s*=\s*session\s*[),]/g)) aliases.add(match[1]); // saveDraft(current = session)
  for (const match of text.matchAll(/\b(\w+)\s*=\s*await openAppSession\(/g)) aliases.add(match[1]);
  for (const match of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*session;/g)) aliases.add(match[1]);
  // Functions handed the session explicitly (app-revisions closeSession(current), sessionOpened(current), queue(opened, …)).
  for (const match of text.matchAll(/\b(?:async\s+)?(?:closeSession|sessionOpened|applyQueued|queue|close)\s*\((\w+)/g)) {
    if (/^(current|opened|previous|expected)$/.test(match[1])) aliases.add(match[1]);
  }
  const snapshotAliases = new Set();
  for (const match of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*\w+\??\.snapshot\s*;/g)) snapshotAliases.add(match[1]);
  return { aliases, snapshotAliases };
}

/** Members used on session aliases: [{name, call, line}] (first member after the alias only). */
function sessionMembers(text) {
  const { aliases, snapshotAliases } = sessionAliases(text);
  const uses = [];
  const pattern = /(^|[^.\w$])(\w+)\??\.(\w+)(\??\.?\()?/g;
  for (const match of text.matchAll(pattern)) {
    const [, , owner, name, call] = match;
    if (!aliases.has(owner)) continue;
    uses.push({ owner, name, call: Boolean(call), line: lineOf(text, match.index), snapshotAlias: snapshotAliases.has(owner) });
  }
  // Direct use of a getter's result: ready().newThread(), getSession()?.plugins?.(), options.getSession()?.snapshot.
  for (const match of text.matchAll(/\b(ready|need|getSession\??\.?)\(\)\??\.(\w+)(\??\.?\()?/g)) {
    uses.push({ owner: `${match[1]}()`, name: match[2], call: Boolean(match[3]), line: lineOf(text, match.index), snapshotAlias: false });
  }
  return uses;
}

/** Snapshot fields read in a consumer: `<alias>.snapshot.x`, a bare `snapshot.x` (render(snapshot)), and snapshot aliases. */
function snapshotReads(text) {
  const { aliases, snapshotAliases } = sessionAliases(text);
  const reads = [];
  for (const match of text.matchAll(/(^|[^.\w$])(\w+)\??\.snapshot\??\.(\w+)/g)) {
    if (aliases.has(match[2])) reads.push({ name: match[3], line: lineOf(text, match.index), via: `${match[2]}.snapshot` });
  }
  for (const match of text.matchAll(/(^|[^.\w$])snapshot\??\.(\w+)/g)) reads.push({ name: match[2], line: lineOf(text, match.index), via: 'snapshot' });
  for (const match of text.matchAll(/(^|[^.\w$])(\w+)\??\.(\w+)/g)) {
    if (snapshotAliases.has(match[2]) && !aliases.has(match[2])) reads.push({ name: match[3], line: lineOf(text, match.index), via: match[2] });
  }
  return reads;
}

const SNAPSHOT_KEYS = [...S.snapshot.required, ...S.snapshot.optional];
const allowedMember = (use) => S.methods.includes(use.name) || S.getters.includes(use.name) || use.name in S.excluded
  // `const current = session?.snapshot` reuses a session alias name in another function.
  || use.snapshotAlias && SNAPSHOT_KEYS.includes(use.name);

// The doc's consumers (§A2 "Consumers of the session object") plus the modules that
// receive getSession/getSnapshot today.
// provider-settings.js (P4) reads session.providers() for Settings. Since C7 the chat
// (render, composer, model settings) is plugins/core-chat/web/chat.js.
const CHAT = '../../plugins/core-chat/web/chat.js';
const CONSUMERS = ['app.js', CHAT, DRAWER, '../../plugins/core-plugin-management/web/plugin-settings.js', 'settings.js', 'app-revisions.js', '../../plugins/core-chat/web/chat-controls.js', '../../plugins/core-chat/web/provider-settings.js'];

test('every member the consumers use on the session object is in agent.sessions@1 (or explicitly excluded)', async () => {
  const used = {};
  for (const file of CONSUMERS) {
    const text = await code(file);
    const uses = sessionMembers(text);
    const unknown = uses.filter((use) => !allowedMember(use)).map((use) => `${file}:${use.line} ${use.owner}.${use.name}`);
    assert.deepEqual(unknown, [], `session members missing from agent.sessions@1:\n${unknown.join('\n')}`);
    used[file] = sorted(uses.filter((use) => !use.snapshotAlias || !SNAPSHOT_KEYS.includes(use.name)).map((use) => use.name));
  }
  // The scan really sees the call sites the doc lists (guards against a scan that matches nothing).
  const expectAll = (file, names) => { for (const name of names) assert.ok(used[file].includes(name), `${file} no longer uses session.${name}? update the C0 scan expectations`); };
  // close: since C3d only core-agent's opener (plugins/core-agent/web/open-sessions.js) and the lifecycle close sessions.
  expectAll(CHAT, ['snapshot', 'subscribe', 'send', 'resume', 'stop', 'setDraft', 'setModelSettings', 'addAttachments', 'removeAttachment']);
  expectAll(DRAWER, ['tree', 'switchConversation', 'newThread', 'forkThread', 'archiveConversation', 'unarchiveConversation', 'renameConversation', 'snapshot']);
  expectAll('../../plugins/core-plugin-management/web/plugin-settings.js', ['plugins', 'setPluginEnabled', 'pendingWorkFor', 'snapshot']);
  expectAll('app-revisions.js', ['snapshot', 'close']);
  expectAll('../../plugins/core-chat/web/provider-settings.js', ['providers']);
  assert.deepEqual(used['settings.js'], [], 'settings.js does not touch the session');
  // Only lifecycle code uses the excluded members.
  for (const [file, names] of Object.entries(used)) {
    for (const name of names.filter((n) => n in S.excluded)) {
      assert.ok(file === 'app.js' || file === 'app-revisions.js', `${file} uses excluded session.${name}`);
    }
  }
});

test('every snapshot field the consumers read is in agent.sessions@1', async () => {
  const conversationKeys = [...S.conversation.required, ...S.conversation.optional];
  const seen = new Set();
  for (const file of CONSUMERS) {
    const text = await code(file);
    const unknown = snapshotReads(text).filter((read) => !SNAPSHOT_KEYS.includes(read.name)).map((read) => `${file}:${read.line} ${read.via}.${read.name}`);
    assert.deepEqual(unknown, [], `snapshot fields missing from agent.sessions@1:\n${unknown.join('\n')}`);
    for (const read of snapshotReads(text)) seen.add(read.name);
    // snapshot.conversation.<x>
    for (const match of text.matchAll(/snapshot\??\.conversation\??\.(\w+)/g)) {
      assert.ok(conversationKeys.includes(match[1]), `${file}:${lineOf(text, match.index)} snapshot.conversation.${match[1]} is not in the contract`);
    }
  }
  for (const name of ['messages', 'busy', 'paused', 'conversation', 'modelSettings', 'recoveryProviders', 'mode', 'owned']) {
    assert.ok(seen.has(name), `scan no longer sees snapshot.${name}`);
  }
});

// --- session.js itself -----------------------------------------------------------------
async function returnedObject() {
  const text = await source('session-engine.js');
  const start = text.indexOf('\n  const session = {');
  assert.ok(start > 0, 'session.js: the returned `const session = {` object moved; update the C0 scan');
  // Members at the object's top indentation (4 spaces).
  const end = text.indexOf('\n  };', start);
  const body = text.slice(start, end);
  const names = [...body.matchAll(/^ {4}(?:async\s+)?(?:get\s+)?(\w+)\s*(?:\(|,|:)/gm)].map((match) => match[1]);
  return { text, names, line: lineOf(text, start + 1) };
}

test('the object openAppSession returns (session.js) has exactly the contract members plus the excluded ones', async () => {
  const { names, text } = await returnedObject();
  assert.match(text, /\n  return session;\n\}/, 'openAppSession returns that object');
  assert.deepEqual(sorted(names), sorted([...S.getters, ...S.methods, ...Object.keys(S.excluded)]));
  // P4: providers() landed and moved from planned into the method list on purpose.
  assert.deepEqual(Object.keys(S.planned), [], 'agent.sessions@1 has no planned member left');
  assert.ok(names.includes('providers') && S.methods.includes('providers'), 'providers() is a session member and in the contract');
  // C7 (additive): providerLabel(key) for the chat's #mode option and recovery names.
  assert.deepEqual(S.groups.providers, ['providers', 'providerLabel']);
  assert.deepEqual(S.signatures.providers, []);
  assert.deepEqual(S.signatures.providerLabel, ['key']);
  // C7 (additive): the facade's read-only foreground getter.
  assert.deepEqual(S.facadeGetters, ['foreground']);
  assert.ok(S.facade.includes('foreground'));
});

// --- agent.harness@1 pieces --------------------------------------------------------------
test('core-subagents builds createSubagentExtensions from agent.harness@1 only (A5)', async () => {
  const text = await readFile(`${root}plugins/core-subagents/web/index.js`, 'utf8');
  const at = text.indexOf('createSubagentExtensions({');
  assert.ok(at > 0, 'core-subagents index.js: createSubagentExtensions({ call moved');
  const body = text.slice(at, text.indexOf('\n    }, host.pi);', at));
  const pairs = [...body.matchAll(/^ {6}(\w+): .*?\bharness\.((?:\w+\.)?\w+)\(/gm)].map((match) => [match[1], match[2]]);
  assert.deepEqual(sorted(pairs.map(([key]) => key)), sorted(['getTool', 'toolNames', 'resolveModel', 'listModels', 'clampThinking', 'configurePrompt', 'abortTask', 'abortSubmission']));
  // Each option forwards to the agent.harness@1 member the contract maps it to.
  const expected = {};
  for (const group of ['models', 'tools', 'prompt']) for (const [member, option] of Object.entries(H[group])) expected[option] = `${group}.${member}`;
  for (const method of H.methods) expected[method] = method;
  for (const [key, member] of pairs) assert.equal(member, expected[key], `${key} forwards to harness.${expected[key]}`);
  // The session engine no longer knows the subagent implementation.
  assert.doesNotMatch(await source('session-engine.js'), /createSubagentExtensions|subagents\.js/);
});

test('servers-service.js connect() and report-attribution.js use only agent.harness@1 pieces', async () => {
  const servers = await readFile(`${root}plugins/core-servers/web/servers-service.js`, 'utf8');
  const connect = servers.match(/connect\(\{([^}]*)\}\)\s*\{/);
  assert.ok(connect, 'servers-service.js connect({...}) moved');
  const params = connect[1].split(',').map((part) => part.trim().split(':')[0].trim()).filter(Boolean);
  assert.deepEqual(sorted(params), sorted(['harness', 'env', 'rootConversationId', 'context']));
  for (const value of params.filter((p) => p !== 'harness')) assert.ok(H.values.includes(value), `${value} is a harness value`);
  const harnessCalls = sorted([...servers.matchAll(/\bharness\.(\w+)/g)].map((match) => match[1]));
  assert.deepEqual(harnessCalls.filter((name) => !H.methods.includes(name)), [], 'servers-service.js calls harness methods outside agent.harness@1');
  assert.ok(harnessCalls.includes('getTask') && harnessCalls.includes('waitForTask'), 'the doc-gap methods are still used (else drop addedToDocList)');
  const attribution = await readFile(`${root}plugins/core-conversations/web/report-attribution.js`, 'utf8');
  const storageCalls = sorted([...attribution.matchAll(/\bstorage\.(\w+)/g)].map((match) => match[1]));
  assert.ok(storageCalls.length > 0, 'report-attribution.js reads storage');
  assert.deepEqual(storageCalls.filter((name) => !H.storage.includes(name)), [], 'report-attribution.js uses storage outside agent.harness@1');
  // The harness handle never writes storage: the read-only list has no commit/write members.
  assert.deepEqual(H.storage.filter((name) => /commit|write|apply|prepare|close|mint/i.test(name)), []);
});

test('subagents.js reaches the harness only through its constructor dependencies', async () => {
  const text = await readFile(`${root}plugins/core-subagents/web/subagents.js`, 'utf8');
  // No library import either: pi-durable/pi-ai come from the host's pi bag (A5).
  assert.doesNotMatch(text, /^\s*import\b/m);
  // No direct Harness/Storage/session access: everything goes through the mapped options or the pi-durable tool api.
  assert.doesNotMatch(text, /\bharness\.|\bstorage\.|openAppSession/);
  const options = text.match(/function createSubagentExtensions\(\{([^}]*)\}/);
  assert.ok(options, 'subagents.js createSubagentExtensions({...}) signature moved');
  const names = options[1].split(',').map((part) => part.trim().split(/[:=]/)[0].trim()).filter(Boolean);
  const mapped = [...Object.values(H.models), ...Object.values(H.tools), ...Object.values(H.prompt), ...H.methods];
  assert.deepEqual(names.filter((name) => !mapped.includes(name)), []);
});

test('scanner self-check: drift in a consumer would be reported', () => {
  const sample = [
    'var session;',
    'async function a(current = session) { await current.saveEverything(); }',
    'function b() { const opened = await openAppSession({}); opened.subscribe(() => {}); return opened.snapshot.newField; }',
    'function c() { const current = session?.snapshot; return current?.busy && current?.secretField; }',
    'const x = ready().exportAll(); render(snapshot.mode);',
    '// session.commentOnly() is ignored'
  ].join('\n').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const unknown = sessionMembers(sample).filter((use) => !allowedMember(use)).map((use) => use.name);
  assert.deepEqual(sorted(unknown), ['exportAll', 'saveEverything', 'secretField']);
  const fields = snapshotReads(sample).filter((read) => !SNAPSHOT_KEYS.includes(read.name)).map((read) => read.name);
  // (current?.secretField is reported by the member check above: `current` is also a session alias.)
  assert.deepEqual(sorted(fields), ['newField']);
});
