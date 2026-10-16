import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable, until } from './plugin-agent-support.mjs';
import { CONFIGURATIONS } from './plugin-a2-support.mjs';
import { El, all, installDom } from './plugin-p4-support.mjs';

// Drawer index repro (docs/plugins-ui-editions.md "Drawer index"). On the phone a subagent spawned
// while the app was open showed up late or not at all: the drawer only learned about conversations
// by re-running a full tree() rescan every 2 s, whose per-row lookups queue behind every agent commit
// in the one native SQLite queue; lookups are bounded at 4 s and an owned row whose naming lookup
// missed became an unnamed, idle "task" (then hidden behind a "Finished" toggle, which no longer exists). Here the storage is
// phone-like (one FIFO, a fixed cost per call; or one slow lookup kind) and the session, runtime,
// core-subagents and drawer are real; the ChatGPT endpoint is mocked.
// Mocked DOM and storage: NOT on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, pd, session, runtimeModule, agentModule, coreModule, piModule, registry;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  pd = await app.load('library/pi-durable.js');
  session = await app.load('session.js');
  runtimeModule = await app.load('plugin-runtime.js');
  agentModule = await app.load('agent-extensions.js');
  coreModule = await app.load('core-agent-plugins.js');
  piModule = await app.load('plugin-pi.js');
  registry = await app.load('builtin-plugins.js');
});
after(async () => { await app?.remove(); });

// Phone-like storage: every call waits its turn in one FIFO (the native-host SQLite facade does the
// same) and costs `cost` ms; slow(kind) delays findDocument for one document kind by `ms`, outside
// the FIFO. calls counts every storage call; close is a no-op so a second session can reopen it.
function phoneStorage() {
  const inner = new pd.MemoryStorage();
  const state = { cost: 0, calls: 0, slow: undefined };
  let tail = Promise.resolve();
  const storage = new Proxy(inner, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    if (key === 'close') return async () => {};
    return (...args) => {
      state.calls++;
      if (key === 'findDocument' && state.slow && args[0]?.kind === state.slow.kind) {
        return new Promise((resolve) => setTimeout(resolve, state.slow.ms)).then(() => value.apply(target, args));
      }
      const result = tail.then(async () => {
        if (state.cost) await new Promise((resolve) => setTimeout(resolve, state.cost));
        return value.apply(target, args);
      });
      tail = result.catch(() => {});
      return result;
    };
  } });
  return { storage, state };
}

let responseId = 0;
function response(text, tool) {
  const id = ++responseId;
  const item = tool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
    : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    ...tool ? [] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } }
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const auth = () => ({
  async getAccessToken() { return 'dummy-drawer-token'; },
  async listModels() { return [{ id: 'gpt-4.1', name: 'Main model' }]; },
  subscribe() { return () => {}; }
});
const isChild = (body) => body.input.some((item) => ['developer', 'system'].includes(item.role) && /You are the subagent/.test(JSON.stringify(item)));
// The main agent archives `name` for "Archive <name>." and spawns `name` once for each user message "Spawn <name>."; the child waits for gate(name).
function agentFetch({ gates = {} } = {}) {
  const spawned = new Set();
  const started = new Set();
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isChild(body)) {
      const name = /You are the subagent \\"(\w+)\\"/.exec(JSON.stringify(body.input))?.[1];
      started.add(name);
      // The gate also yields to an abort (a session closing interrupts the call; the durable run resumes on reopen).
      if (gates[name]) await Promise.race([gates[name], new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
      })]);
      return response(`${name} finished`);
    }
    const last = JSON.stringify(body.input.at(-1));
    const archiving = /Archive (\w+)\./.exec(last)?.[1];
    if (archiving && body.input.at(-1).type !== 'function_call_output') return response('', { name: 'subagent', args: { action: 'archive', name: archiving } });
    const sending = /Send (\w+)\./.exec(last)?.[1];
    if (sending && body.input.at(-1).type !== 'function_call_output') return response('', { name: 'subagent', args: { action: 'send', name: sending, message: 'More.' } });
    const name = /Spawn (\w+)\./.exec(last)?.[1];
    if (name && !spawned.has(name)) {
      spawned.add(name);
      return response('', { name: 'subagent', args: { action: 'spawn', name, message: 'Look around.', tools: ['read'] } });
    }
    return response('ok');
  };
  return { fetch, started };
}
async function fixture() {
  const { hostInfo, options } = CONFIGURATIONS.native();
  const runtime = runtimeModule.createPluginRuntime({ pi: piModule.pluginPi });
  for (const definition of coreModule.createCoreAgentPlugins({ hostInfo })) runtime.register(definition);
  await runtime.start();
  const agentExtensions = agentModule.createAgentExtensions({ onError() {} });
  agentExtensions.connect(runtime);
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfo;
  const open = (storage, fetch) => session.openAppSession({ storage, toolchain: false, ...options, chatgpt: auth(), fetch, agentExtensions });
  return { open, close: async () => { globalThis.__piHostInfo = saved; await runtime.close(); } };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// The mocked DOM pieces conversations.js needs beyond the P4 mock (as in plugin-c7-conversations).
if (!Object.getOwnPropertyDescriptor(El.prototype, 'classList')) {
  Object.defineProperty(El.prototype, 'classList', { get() {
    const classes = (this._classes ??= new Set());
    return { toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; }, contains: (name) => classes.has(name) };
  } });
}
const setAttribute = El.prototype.setAttribute;
El.prototype.setAttribute = function (name, value) {
  setAttribute.call(this, name, value);
  if (name === 'id') this.id = String(value);
  if (name === 'hidden') this.hidden = true;
};
Object.defineProperty(El.prototype, 'firstChild', { configurable: true, get() { return this.children[0] ?? null; } });
El.prototype.insertBefore = function (node, reference) {
  node.parent?.removeChild(node);
  node.parent = this;
  const index = this.children.indexOf(reference);
  this.children.splice(index < 0 ? this.children.length : index, 0, node);
};
El.prototype.querySelector = function (selector) {
  const match = (node) => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tag === selector;
  return all(this).slice(1).find(match) ?? null;
};
const byId = (id) => globalThis.document.getElementById(id) ?? all(globalThis.document.body).find((node) => node.id === id) ?? null;
function drawer(opened) {
  const dom = installDom({ 'chat-screen': 'section', error: 'div' }, (fixed) => {
    const topbar = Object.assign(new El('header'), { className: 'topbar' });
    fixed['chat-screen'].append(topbar);
    fixed.error.hidden = true;
  });
  globalThis.document.body = new El('body');
  globalThis.document.querySelector = () => null;
  const entry = registry.builtinPlugin('core-conversations').entry;
  entry.mountBundled();
  entry.mountConversations({ sessions: { current: () => opened }, by: 'bundled' });
  const titles = () => byId('tree-list').children.map((row) => row.children[0]?.textContent).filter(Boolean);
  return { dom, titles, open: () => byId('chat-tree').click(), close: () => byId('tree-back')?.click() };
}

test('the open drawer lists a subagent spawned meanwhile at once, named and running, and does not poll storage', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const gate = deferred();
  const agent = agentFetch({ gates: { worker: gate.promise } });
  const opened = await f.open(phone.storage, agent.fetch);
  let view;
  try {
    for (let i = 0; i < 20; i++) await opened.newThread(); // a realistic list
    await opened.switchConversation(pd.ROOT_CONVERSATION_ID);
    phone.state.cost = 40; // every storage call now costs 40 ms, one at a time
    view = drawer(opened);
    await view.open();
    await until(() => view.titles().length === 21, `the drawer did not list the conversations: ${JSON.stringify(view.titles())}`, 15000);
    // Once the one-time lazy details (model, busy, empty) are in, an open idle drawer costs no
    // storage work (it used to rescan every 2 s). tree() resolves when those details are filled.
    await opened.tree();
    const idle = phone.state.calls;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(phone.state.calls - idle, 0, 'storage calls while the drawer stayed open and nothing changed');
    assert.ok(!view.titles().includes('worker'));
    await opened.send('Spawn worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => agent.started.has('worker'), 'the child never started', 30000);
    const since = Date.now();
    await until(() => view.titles().includes('worker'), `the spawned subagent never reached the drawer: ${JSON.stringify(view.titles())}`, 8000);
    const delay = Date.now() - since;
    assert.ok(delay < 1000, `listed ${delay} ms after it started (a 2 s rescan used to be needed)`);
    const row = byId('tree-list').children.find((item) => item.children[0]?.textContent === 'worker');
    assert.ok(row.children[0].children.some((child) => /conv-dot busy/.test(child.className)), 'shown as working');
  } finally {
    gate.resolve();
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});

test('watchTree: a spawned subagent arrives from its commit (kind subagent, busy), a second one too; tree() agrees', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const gates = { first: deferred(), second: deferred() };
  const agent = agentFetch({ gates: { first: gates.first.promise, second: gates.second.promise } });
  const opened = await f.open(phone.storage, agent.fetch);
  let latest = [];
  const unwatch = opened.watchTree((nodes) => { if (nodes) latest = nodes; });
  try {
    await until(() => latest.length === 1, 'no first list');
    const worker = (name) => latest.find((node) => node.title === name);
    await opened.send('Spawn first.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => agent.started.has('first'), 'first never started', 30000);
    await until(() => worker('first')?.busy === true, `first not listed as running: ${JSON.stringify(latest)}`, 1000);
    assert.equal(worker('first').kind, 'subagent');
    assert.equal('finished' in worker('first'), false, 'no finished concept');
    assert.equal(worker('first').archived, false);
    assert.equal(worker('first').parentId, pd.ROOT_CONVERSATION_ID);
    gates.first.resolve();
    await until(() => worker('first')?.busy === false, 'first still busy', 30000);
    // The registry doc exists (and was read) now: a second spawn must still arrive.
    await until(() => !opened.snapshot.busy, 'main still busy', 30000);
    await opened.send('Spawn second.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => agent.started.has('second'), 'second never started', 30000);
    await until(() => worker('second')?.busy === true, `second not listed: ${JSON.stringify(latest.map((n) => [n.title, n.kind, n.busy]))}`, 1000);
    const nodes = await opened.tree();
    assert.deepEqual(nodes.map((node) => [node.id, node.parentId, node.kind, node.title]), latest.map((node) => [node.id, node.parentId, node.kind, node.title]));
  } finally {
    unwatch();
    gates.first.resolve();
    gates.second.resolve();
    await opened.close();
    await f.close();
  }
});

test('after a reopen, a subagent whose registry lookup is slow gets its name; idle subagents are listed normally, with no Finished toggle', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const agent = agentFetch();
  let opened = await f.open(phone.storage, agent.fetch);
  let view;
  try {
    await opened.send('Spawn worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(async () => (await opened.tree()).some((node) => node.title === 'worker' && !node.busy), 'worker not done', 30000);
    await until(() => !opened.snapshot.busy, 'main still busy', 30000);
    await opened.close();
    // A fresh session (nothing cached) whose subagent registry answers after the 4 s lookup bound.
    phone.state.slow = { kind: 'self-forming.subagents', ms: 5000 };
    opened = await f.open(phone.storage, agent.fetch);
    view = drawer(opened);
    await view.open();
    await until(() => view.titles().length > 0, 'no list', 20000);
    const rows = () => byId('tree-list').children.filter((row) => row.className === 'conv-row');
    assert.equal(rows().length, 2, `both conversations are listed at the first render: ${JSON.stringify(view.titles())}`);
    // The name arrives with the registry; the idle subagent stays listed under its parent (no Finished toggle).
    await until(() => view.titles().includes('worker'), `the subagent got its name: ${JSON.stringify(view.titles())}`, 20000);
    assert.ok(!view.titles().includes('Subagent'), 'no unnamed subagent row is left');
    assert.equal(rows().length, 2);
    assert.ok(!view.titles().some((title) => /inished/.test(title)), `no Finished toggle: ${JSON.stringify(view.titles())}`);
  } finally {
    phone.state.slow = undefined;
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});

// The registry flag `archived` (set by the subagent tool's archive action) hides a subagent in the drawer
// under the existing "Archived" toggle; thread archive (ThreadsDoc) is unchanged.
test('an archived subagent shows only under the Archived toggle', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const agent = agentFetch();
  const opened = await f.open(phone.storage, agent.fetch);
  let view;
  try {
    await opened.send('Spawn worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(async () => (await opened.tree()).some((node) => node.title === 'worker' && !node.busy), 'worker not done', 30000);
    await until(() => !opened.snapshot.busy, 'main still busy', 30000);
    view = drawer(opened);
    await view.open();
    await until(() => view.titles().includes('worker'), `worker listed: ${JSON.stringify(view.titles())}`, 10000);
    assert.ok(!view.titles().some((title) => /^Archived/.test(title)), 'no toggle without archived rows');
    // Archive through the tool's registry flag (a plain doc commit, as the tool does).
    await opened.send('Archive worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => view.titles().some((title) => /^Archived \(1\)/.test(title)), `archived toggle: ${JSON.stringify(view.titles())}`, 15000);
    assert.ok(!view.titles().includes('worker'), 'hidden by default');
    const toggle = byId('tree-list').children.find((row) => row.className === 'conv-toggles').children[0];
    toggle.click();
    await until(() => view.titles().includes('worker'), `shown under Archived: ${JSON.stringify(view.titles())}`, 5000);
    assert.ok(view.titles().some((title) => /^Hide archived/.test(title)));
    toggle.click();
  } finally {
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});

test('busy: a lookup that times out and then answers marks the conversation working; no start-up guess is left as final', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const gate = deferred();
  const agent = agentFetch({ gates: { worker: gate.promise } });
  let opened = await f.open(phone.storage, agent.fetch);
  let unwatch;
  try {
    await opened.send('Spawn worker.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => agent.started.has('worker'), 'the child never started', 30000);
    await until(async () => (await opened.tree()).some((node) => node.title === 'worker' && node.busy), 'worker not working', 10000);
    await opened.close(); // the child's work is unfinished and durable
    // Reopened: the live-run lookup is slower than the 4 s bound. The answer (a run) arrives late.
    phone.state.slow = { kind: 'pi.live', ms: 5500 };
    opened = await f.open(phone.storage, agent.fetch);
    let latest = [];
    unwatch = opened.watchTree((nodes) => { if (nodes) latest = nodes; });
    await until(() => latest.length === 2, 'no first list', 15000);
    const work = () => latest.find((node) => node.title === 'worker' || node.kind === 'task');
    // The bound passes without an answer: unknown is shown as not working, not guessed.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.notEqual(work()?.busy, true, 'no guess from queued or live tasks while the lookup is pending');
    await until(() => work()?.busy === true, `the late answer marks it working: ${JSON.stringify(latest.map((n) => [n.title, n.kind, n.busy]))}`, 20000);
    gate.resolve();
    await until(() => work()?.busy === false, 'still working after the child finished', 30000);
  } finally {
    phone.state.slow = undefined;
    gate.resolve();
    unwatch?.();
    await opened.close();
    await f.close();
  }
});

// Archive from the drawer (rows of forks and subagents get the same Archive/Unarchive button as threads).
const rowOf = (title) => byId('tree-list').children.find((row) => row.children[0]?.textContent === title);
const buttonOf = (title, verb) => rowOf(title)?.children.find((child) => child.getAttribute?.('aria-label')?.startsWith(verb + ' '));
const toggleText = () => byId('tree-list').children.find((row) => row.className === 'conv-toggles')?.children[0]?.textContent;
const treeError = () => byId('tree-screen').querySelector('.conv-error');

test('forks can be archived from the drawer; the fork and everything below it go under the Archived toggle', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const agent = agentFetch();
  const opened = await f.open(new pd.MemoryStorage(), agent.fetch);
  let view;
  try {
    await opened.send('Hello.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => !opened.snapshot.busy, 'main still busy', 20000);
    await opened.forkThread();
    const outer = opened.snapshot.conversation.id;
    await opened.renameConversation(outer, 'Outer');
    await opened.forkThread();
    const inner = opened.snapshot.conversation.id;
    await opened.renameConversation(inner, 'Inner');
    await opened.switchConversation(pd.ROOT_CONVERSATION_ID);
    view = drawer(opened);
    await view.open();
    await until(() => view.titles().includes('Inner'), `forks listed: ${JSON.stringify(view.titles())}`, 10000);
    assert.ok(buttonOf('Inner', 'Archive'), 'a nested fork has the button');
    assert.ok(buttonOf('Outer', 'Archive'), 'a fork has the button');
    assert.ok(!buttonOf('Main', 'Archive'), 'main has none');
    buttonOf('Outer', 'Archive').click();
    await until(() => !view.titles().includes('Outer'), `Outer still listed: ${JSON.stringify(view.titles())}`, 10000);
    assert.ok(!view.titles().includes('Inner'), 'its descendant is hidden with it');
    assert.match(toggleText(), /^Archived \(1\)$/, 'only the archived row is counted');
    byId('tree-list').children.find((row) => row.className === 'conv-toggles').children[0].click();
    await until(() => view.titles().includes('Inner') && view.titles().includes('Outer'), 'both shown under Archived', 5000);
    assert.ok(buttonOf('Outer', 'Unarchive'), 'the archived fork offers Unarchive');
    assert.ok(!buttonOf('Inner', 'Unarchive'), 'the descendant was not flagged itself');
    assert.equal((await opened.tree()).find((node) => node.title === 'Outer').archived, true);
    buttonOf('Outer', 'Unarchive').click();
    await until(() => !toggleText(), `toggle gone: ${JSON.stringify(view.titles())}`, 10000);
    assert.ok(view.titles().includes('Outer') && view.titles().includes('Inner'));
    // Archiving the open fork's ancestor moves the open chat to Main (it would vanish from the list otherwise).
    await opened.switchConversation(inner);
    await opened.archiveConversation(outer);
    assert.equal(opened.snapshot.conversation.id, pd.ROOT_CONVERSATION_ID);
  } finally {
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});

test('subagents can be archived from the drawer: refused inline while active, allowed once idle, send unarchives', { skip, timeout: 90000 }, async () => {
  const f = await fixture();
  const gate = deferred();
  const agent = agentFetch({ gates: { worker: gate.promise } });
  const opened = await f.open(new pd.MemoryStorage(), agent.fetch);
  const chat = { mode: 'chatgpt', modelId: 'gpt-4.1' };
  const flag = async () => (await opened.tree()).find((node) => node.title === 'worker').archived;
  let view;
  try {
    await opened.send('Spawn worker.', chat);
    await until(() => agent.started.has('worker'), 'the child never started', 30000);
    view = drawer(opened);
    await view.open();
    await until(() => view.titles().includes('worker'), `worker listed: ${JSON.stringify(view.titles())}`, 10000);
    assert.ok(buttonOf('worker', 'Archive'), 'a subagent row has the button');
    buttonOf('worker', 'Archive').click();
    await until(() => treeError().hidden === false, 'no inline error', 10000);
    assert.match(treeError().textContent, /Cannot archive worker while it is active/);
    assert.equal(await flag(), false);
    assert.ok(view.titles().includes('worker'), 'still listed');
    gate.resolve();
    await until(async () => (await opened.tree()).find((node) => node.title === 'worker')?.busy === false, 'worker still working', 30000);
    await until(() => !opened.snapshot.busy, 'main still busy', 30000);
    // The reporter settles right after the report is posted: retry the click until it is accepted.
    await until(async () => { if (!buttonOf('worker', 'Archive')) return true; buttonOf('worker', 'Archive').click(); await new Promise((r) => setTimeout(r, 300)); return !view.titles().includes('worker'); }, 'archive kept being refused', 20000);
    assert.equal(await flag(), true, 'the registry flag the tool uses');
    assert.match(toggleText(), /^Archived \(1\)$/);
    byId('tree-list').children.find((row) => row.className === 'conv-toggles').children[0].click();
    await until(() => buttonOf('worker', 'Unarchive'), 'archived worker offers Unarchive', 5000);
    buttonOf('worker', 'Unarchive').click();
    await until(async () => (await flag()) === false && !toggleText(), `unarchived: ${toggleText()}`, 10000);
    // Archived again from the drawer, then the main agent's send unarchives it.
    await until(async () => { if (await flag()) return true; buttonOf('worker', 'Archive')?.click(); await new Promise((r) => setTimeout(r, 300)); return flag(); }, 'could not archive again', 20000);
    await opened.send('Send worker.', chat);
    await until(async () => (await flag()) === false, 'send did not unarchive', 20000);
    // Run helpers (task-owned one-shots) have no registry entry: nothing to archive.
    await assert.rejects(opened.archiveConversation(987654), /Only conversations and spawned subagents/);
  } finally {
    gate.resolve();
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});
