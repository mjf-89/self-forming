// B2: real owner + JSONL + ExecutionEnv/browser filesystem adapter; dummy records only.
// The injected memory backend survives reconstruction within this test, not a real page reload.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';
import { createBrowserHost } from '../apps/browser/browser-host.js';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';

test('browser bootstrap has no conversation storage twin or legacy hook', async () => {
  const main = await readFile(new URL('../apps/browser/browser-main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /__piOpenStorage|JsonlStorage|BACKGROUND_CONTEXT|\/data\/conversations/);
});

test('storage@1 persists conversation, entry and document through close and fresh browser adapters', {
  skip: await libraryAvailable() ? false : 'dist/app/library required'
}, async () => {
  const app = await assembleApp();
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__piOpenStorage');
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const dummyLocal = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => dummyLocal.get(key) ?? null,
    setItem: (key, value) => dummyLocal.set(key, String(value)), removeItem: key => dummyLocal.delete(key)
  } });
  let oldReads = 0;
  Object.defineProperty(globalThis, '__piOpenStorage', { configurable: true, get() {
    oldReads++; throw new Error('legacy global must never be consulted');
  } });
  const active = [];
  try {
    const { create } = await app.load('builtin/core-storage/web/index.js');
    const { JsonlStorage } = await app.load('library/pi-durable/storage/jsonl.js');
    const { BACKGROUND_CONTEXT: context } = await app.load('library/chord/context.js');
    const { createNativeBridge } = await app.load('native-host.js');
    const { openNativeExecutionEnv } = await app.load('builtin/core-execution/web/execution-env.js');
    const backend = new MemoryBackend();
    const calls = [];
    async function open() {
      const vfs = await Vfs.open({ backend });
      const host = await createBrowserHost({ vfs, network: { fetch() { throw new Error('unexpected network'); } } });
      active.push(host);
      const native = createNativeBridge(host.transport);
      const bridge = { call(method, ...args) { calls.push(method); return native.call(method, ...args); },
        subscribe: (...args) => native.subscribe(...args), onClose: (...args) => native.onClose(...args) };
      const info = await bridge.call('host.info');
      assert.equal(info.platform, 'browser');
      const env = await openNativeExecutionEnv(bridge);
      let service;
      create({ bridge, hostInfo: info }).setup({ signal: new AbortController().signal,
        provide(id, version, value) { assert.equal(id, 'storage'); assert.equal(version, 1); service = value; } });
      assert.equal(service.databaseName, 'self-forming');
      const store = await service.open({ env });
      assert.ok(store instanceof JsonlStorage);
      return { vfs, host, env, store };
    }
    const conversation = { id: 1, createdAt: 100, title: 'B2 dummy' };
    const entry = { id: 2, conversationId: 1, kind: 'pi.user', createdAt: 101, text: 'dummy message' };
    const record = { id: 3, scope: { kind: 'conversation', conversationId: 1 }, kind: 'pi.agent', key: '', history: 'full', fork: 'copy' };
    const value = { title: 'B2 dummy document', model: 'dummy-model' };
    const first = await open();
    await first.store.commit([
      { type: 'conversation', value: conversation }, { type: 'entry', value: entry },
      { type: 'document.create', record, content: { kind: 'base', version: 1, value } }
    ], context);
    const expectedDocument = await first.store.document(3, 'current', context);
    assert.ok(expectedDocument);
    await first.store.close(context);
    await assert.rejects(first.store.conversation(1, context), /closed/);
    await first.vfs.flush();
    const files = await first.env.listDir('/data/conversations', context);
    assert.ok(files.ok);
    assert.ok(files.value.some(file => file.name.endsWith('.jsonl')));
    first.host.dispose();
    const second = await open();
    assert.notEqual(second.vfs, first.vfs);
    assert.notEqual(second.store, first.store);
    assert.deepEqual(await second.store.conversation(1, context), conversation);
    assert.deepEqual(await second.store.entry(2, context), { entry, commitSeq: 1 });
    assert.deepEqual(await second.store.document(3, 'current', context), expectedDocument);
    assert.equal((await second.store.scanConversations({}, 10, undefined, context)).items.length, 1);
    await second.store.close(context);
    await second.vfs.flush();
    assert.equal(oldReads, 0);
    assert.ok(calls.some(method => method.startsWith('env.')));
    assert.ok(!calls.some(method => method.startsWith('sqlite.')), 'browser storage never calls SQLite');
  } finally {
    for (const host of active) host.dispose();
    if (previous) Object.defineProperty(globalThis, '__piOpenStorage', previous);
    else delete globalThis.__piOpenStorage;
    if (previousLocal) Object.defineProperty(globalThis, 'localStorage', previousLocal);
    else delete globalThis.localStorage;
    await app.remove();
  }
});
