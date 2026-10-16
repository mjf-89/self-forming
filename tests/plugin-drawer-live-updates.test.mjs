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

// Drawer live updates: the open drawer must show busy dots and new subagent rows within one tick,
// also after the session was closed and reopened (as after an app update) while it stays open.
// The drawer follows a swappable "current" session, as agent.sessions@1 does.
const dots = (title) => rowOf(title)?.children[0]?.children.some((child) => /conv-dot busy/.test(child.className));
const rowOf = (title) => byId('tree-list').children.find((row) => row.children[0]?.textContent === title);

test('the open drawer shows busy dots and new subagents, also after a session reopen', { skip, timeout: 90000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const gates = { one: deferred(), two: deferred() };
  const agent = agentFetch({ gates: { one: gates.one.promise, two: gates.two.promise } });
  let opened = await f.open(phone.storage, agent.fetch);
  const holder = { current: opened };
  const chat = { mode: 'chatgpt', modelId: 'gpt-4.1' };
  let view;
  try {
    const dom = installDom({ 'chat-screen': 'section', error: 'div' }, (fixed) => {
      fixed['chat-screen'].append(Object.assign(new El('header'), { className: 'topbar' }));
      fixed.error.hidden = true;
    });
    globalThis.document.body = new El('body');
    globalThis.document.querySelector = () => null;
    const listeners = new Set();
    const entry = registry.builtinPlugin('core-conversations').entry;
    entry.mountBundled();
    entry.mountConversations({ sessions: { current: () => holder.current, onSession: (l) => { listeners.add(l); } }, by: 'bundled' });
    view = { dom, close: () => byId('tree-back')?.click() };
    byId('chat-tree').click();
    await until(() => rowOf('Main'), 'no Main row', 15000);
    // (a) the selected conversation becomes busy
    await opened.send('Spawn one.', chat);
    // (b) a new subagent appears, busy
    await until(() => dots('one'), 'new subagent row with busy dot missing', 4000);
    // (c) close and reopen while the drawer stays open
    holder.current = null;
    await opened.close();
    opened = await f.open(phone.storage, agent.fetch);
    holder.current = opened;
    for (const l of listeners) l();
    gates.one.resolve();
    await until(() => !dots('one') && rowOf('one'), 'one still busy after finishing', 20000);
    await until(() => !opened.snapshot.busy, 'main busy', 20000);
    await opened.send('Spawn two.', chat);
    await until(() => rowOf('two') && dots('two'), 'after reopen: new subagent missing', 4000);
    gates.two.resolve();
    await until(() => rowOf('two') && !dots('two'), 'after reopen: two still busy', 20000);
  } finally {
    gates.one.resolve(); gates.two.resolve();
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});

// A rename left open when the drawer is closed (Android back, scrim: the input is hidden and may never blur)
// must not freeze the list for good.
test('closing the drawer during a rename does not freeze the next opening', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  const phone = phoneStorage();
  const gate = deferred();
  const agent = agentFetch({ gates: { one: gate.promise } });
  const opened = await f.open(phone.storage, agent.fetch);
  let view;
  try {
    const dom = installDom({ 'chat-screen': 'section', error: 'div' }, (fixed) => {
      fixed['chat-screen'].append(Object.assign(new El('header'), { className: 'topbar' }));
      fixed.error.hidden = true;
    });
    El.prototype.replaceWith ??= function (node) {
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this), 1, node);
      node.parent = this.parent;
    };
    if (!Object.getOwnPropertyDescriptor(El.prototype, 'parentElement')) Object.defineProperty(El.prototype, 'parentElement', { get() { return this.parent; } });
    El.prototype.select ??= function () {};
    globalThis.document.body = new El('body');
    globalThis.document.querySelector = () => null;
    const entry = registry.builtinPlugin('core-conversations').entry;
    entry.mountBundled();
    entry.mountConversations({ sessions: { current: () => opened }, by: 'bundled' });
    view = { dom, close: () => byId('tree-back')?.click() };
    byId('chat-tree').click();
    await until(() => rowOf('Main'), 'no Main row', 15000);
    await opened.tree(); await new Promise((resolve) => setTimeout(resolve, 200));
    const main = rowOf('Main').children[0];
    for (const l of main.listeners.pointerdown ?? []) l({ clientX: 0, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    byId('tree-back').click(); // closed without a blur
    byId('chat-tree').click();
    await opened.send('Spawn one.', { mode: 'chatgpt', modelId: 'gpt-4.1' });
    await until(() => rowOf('one') && dots('one'), 'the reopened drawer is frozen after an unfinished rename', 4000);
  } finally {
    gate.resolve();
    await view?.close();
    view?.dom.restore();
    await opened.close();
    await f.close();
  }
});
