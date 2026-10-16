import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleApp } from './plugin-agent-support.mjs';

// The served layout (apps/common + builtin/<id>/web/** from plugins/): the built-in registry imports ./builtin/...
const app = await assembleApp();
test.after(() => app.remove());
const { initPluginSettings } = await app.load('builtin/core-plugin-management/web/plugin-settings.js');

// Mocked DOM only (same stand-in as plugin-agent-settings.test.mjs): not visual verification.
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

test('essential core plugins are a fixed row (only when failed) and can never be toggled', () => {
  const fixed = dom();
  const rows = [
    { id: 'core-tools', name: 'core-tools', state: 'failed', reason: 'builders unavailable', essential: true, tools: [], errors: [], toggle: false, enabled: true },
    { id: 'counter', name: 'Counter', state: 'active', tools: ['counter_value'], errors: [], toggle: true, enabled: true }
  ];
  const changes = [];
  const session = {
    snapshot: { conversation: { id: 1 }, owned: false },
    plugins: () => rows,
    setPluginEnabled: async (...args) => { changes.push(args); }
  };
  initPluginSettings({ getSession: () => session });
  const inputs = all(fixed['plugin-list']).filter((node) => node.tag === 'input');
  assert.deepEqual(inputs.map((input) => [input.id, input.checked, input.disabled]), [
    ['plugin-toggle-core-tools', true, true], ['plugin-toggle-counter', true, false]
  ]);
  const texts = all(fixed['plugin-list']).flatMap((node) => [node.textContent, ...node.children.filter((child) => child.text).map((child) => child.text)]).filter(Boolean);
  assert.ok(texts.includes('built-in') && texts.includes('Failed') && texts.includes(': builders unavailable'));
  // Even a forced change event on the fixed row does not reach the session.
  inputs[0].checked = false;
  inputs[0].listeners.change[0]();
  assert.deepEqual(changes, []);
});
