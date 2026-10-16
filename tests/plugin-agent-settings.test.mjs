import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { initPluginSettings } = await app.load('builtin/core-plugin-management/web/plugin-settings.js');

// Mocked DOM only: this is not visual verification of the Settings view.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false; this.id = ''; }
  append(...nodes) { this.children.push(...nodes.map((node) => typeof node === 'string' ? { text: node } : node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  focus() { globalThis.document.activeElement = this; }
}
const all = (node) => [node, ...(node.children ?? []).flatMap((child) => child instanceof Node ? all(child) : [])];
function dom() {
  const fixed = { 'plugin-settings': new Node('details'), 'plugin-list': new Node('div'), 'plugin-status': new Node('p') };
  fixed['plugin-settings'].hidden = true;
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => fixed[id] ?? all(fixed['plugin-list']).find((node) => node.id === id) ?? null
  };
  return fixed;
}

test('Plugins section: one checkbox per plugin with tools, per conversation, reasons for failures', async () => {
  const fixed = dom();
  let rows = [
    { id: 'counter', name: 'Counter', state: 'active', tools: ['counter_value'], errors: [], toggle: true, enabled: true },
    { id: 'broken', name: 'Broken', state: 'failed', reason: 'setup exploded', tools: [], errors: [], toggle: false, enabled: true }
  ];
  const changes = [];
  let release;
  const session = {
    snapshot: { conversation: { id: 3 }, owned: false },
    plugins: () => rows,
    setPluginEnabled: (id, enabled, conversationId) => { changes.push([id, enabled, conversationId]); return new Promise((resolve) => { release = resolve; }); }
  };
  const settings = initPluginSettings({ getSession: () => session });
  assert.equal(fixed['plugin-settings'].hidden, false);
  const inputs = () => all(fixed['plugin-list']).filter((node) => node.tag === 'input');
  assert.deepEqual(inputs().map((input) => [input.id, input.type, input.checked, input.disabled]), [
    ['plugin-toggle-counter', 'checkbox', true, false], ['plugin-toggle-broken', 'checkbox', false, true]
  ]);
  const texts = all(fixed['plugin-list']).flatMap((node) => [node.textContent, ...node.children.filter((child) => child.text).map((child) => child.text)]).filter(Boolean);
  assert.ok(texts.includes('1 tool') && texts.includes('Failed') && texts.includes(': setup exploded'));
  const [counter] = inputs();
  counter.checked = false;
  counter.listeners.change[0]();
  assert.deepEqual(changes, [['counter', false, 3]]);
  assert.equal(inputs()[0].disabled, true, 'pending toggle waits for the commit');
  assert.equal(inputs()[0].checked, false, 'optimistic state');
  rows = [{ ...rows[0], enabled: false }, rows[1]];
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(inputs().map((input) => [input.checked, input.disabled]), [[false, false], [false, true]]);
  // Owned (subagent) conversations follow their owner; nothing to toggle there.
  session.snapshot = { conversation: { id: 9 }, owned: true };
  settings.update();
  assert.equal(inputs()[0].disabled, true);
  assert.equal(fixed['plugin-status'].textContent, "Subagents use their owner's plugins.");
  rows = [];
  settings.update();
  assert.equal(fixed['plugin-settings'].hidden, true, 'hidden without agent plugins');
});
