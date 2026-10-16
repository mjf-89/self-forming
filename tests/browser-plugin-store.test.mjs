// Instrumented IndexedDB API double: verifies the real store adapter's transaction
// boundaries and reconstruction. Not proof of browser quota/eviction behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { packageHash } from '../plugins/core-plugin-management/web/browser-plugin-package.js';
import { servePlugin } from '../plugins/core-plugin-management/web/browser-plugin-serving.js';
globalThis.crypto ??= webcrypto;
import { openPluginStore, PLUGIN_DB } from '../plugins/core-plugin-management/web/browser-plugin-store.js';
function indexedDbDouble() {
  const records = new Map(), transactions = [];
  let initialized = false, failPublication = false;
  const idb = {
    transactions, failNextPublication: () => { failPublication = true; },
    open(name,version) {
      assert.equal(name,PLUGIN_DB); assert.equal(version,1);
      const request = {};
      queueMicrotask(() => {
        request.result = {
          createObjectStore: name => records.set(name,new Map()), close() {},
          transaction(names, mode = 'readonly') {
            names = Array.isArray(names) ? names : [names];
            transactions.push({names,mode});
            const staged = new Map(names.map(n=>[n,new Map(structuredClone([...records.get(n)]))]));
            const tx = {}; let pending = 0, timer;
            const finish = () => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                if (pending) return finish();
                if (mode === 'readwrite' && (idb.denyWrites || (names.includes('snapshots') && failPublication))) {
                  failPublication = false; tx.error = new Error('quota abort'); tx.onabort?.(); return;
                }
                if (mode === 'readwrite') for (const [name,map] of staged) records.set(name,map);
                tx.oncomplete?.();
              },0);
            };
            tx.objectStore = name => {
              assert.ok(names.includes(name)); const map = staged.get(name);
              const run = action => {
                pending++; const r = {};
                queueMicrotask(() => { try { r.result = structuredClone(action()); r.onsuccess?.(); } catch (error) { r.error = error; r.onerror?.(); } finally { pending--; finish(); } });
                return r;
              };
              return {
                get: key => run(()=>map.get(key)), getKey: key => run(()=>map.has(key)?key:undefined), getAll: () => run(()=>[...map.values()]),
                put: (value,key) => run(()=>{ map.set(key,structuredClone(value)); return key; }),
                add: (value,key) => run(()=>{ assert.equal(map.has(key),false); map.set(key,structuredClone(value)); return key; }),
                delete: key => run(()=>{map.delete(key);})
              };
            };
            finish(); return tx;
          }
        };
        if (!initialized) { initialized = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    }
  };
  return idb;
}
test('real store adapter atomically commits snapshot+selection; abort preserves both; old snapshots are immutable and reconstruct', async () => {
  const idb = indexedDbDouble(), store = await openPluginStore(idb);
  assert.equal(store.durable,true); assert.deepEqual(await store.selections(),[],'durability probe leaves no records');
  const first = {manifest:{id:'notes'},hash:'a'.repeat(64),files:{'web/a.js':new Uint8Array([1,2,3])}};
  const selection = {id:'notes',hash:first.hash,previous:null,enabled:true};
  await store.publish(first,selection);
  assert.deepEqual(await store.snapshot('notes',first.hash),first);
  assert.deepEqual(idb.transactions.find(t=>t.names.includes('snapshots') && t.mode==='readwrite').names,['snapshots','selections']);
  const next = {...first,hash:'b'.repeat(64)};
  idb.failNextPublication();
  await assert.rejects(store.publish(next,{...selection,hash:next.hash,previous:first.hash}),/quota/);
  assert.equal(await store.snapshot('notes',next.hash),undefined); assert.equal((await store.selection('notes')).hash,first.hash);
  await store.publish({...first,files:{'web/a.js':new Uint8Array([9])}},selection);
  assert.deepEqual((await store.snapshot('notes',first.hash)).files,first.files,'existing immutable snapshot is not overwritten');
  await store.publish(next,{...selection,hash:next.hash,previous:first.hash});
  store.close();
  const reconstructed = await openPluginStore(idb);
  assert.equal((await reconstructed.selection('notes')).previous,first.hash);
  assert.deepEqual(await reconstructed.snapshot('notes',first.hash),first);
  reconstructed.close();
});
test('database blocked/error cannot advertise an available store', async () => {
  await assert.rejects(openPluginStore({open(){const r = {}; queueMicrotask(()=>r.onblocked()); return r;}}),/blocked/);
  await assert.rejects(openPluginStore({open(){const r = {error:new Error('denied')}; queueMicrotask(()=>r.onerror()); return r;}}),/denied/);
});

test('already-published snapshot serves via read-only opens even when all subsequent writes fail quota', async () => {
  const idb = indexedDbDouble(), store = await openPluginStore(idb);
  const manifest = {id:'notes',name:'Notes',version:'1',api:1,reload:'page',web:{entry:'web/index.js'}};
  const enc = text => new TextEncoder().encode(text);
  const files = {'plugin.json':enc(JSON.stringify(manifest)),'web/index.js':enc('export function setup() {}')};
  const hash = await packageHash(files);
  await store.publish({manifest,hash,files},{id:'notes',hash,enabled:true}); store.close();
  idb.denyWrites = true;
  await assert.rejects(openPluginStore(idb),/quota/,'management cannot advertise writability');
  const response = await servePlugin(new Request(`https://example.test/sub/assets/web/plugins/notes/${hash}/web/index.js`),'https://example.test/sub/',{openStore:()=>openPluginStore(idb,{probe:false})});
  assert.equal(response.status,200); assert.match(await response.text(),/export function setup/);
  assert.equal(idb.transactions.at(-1).mode,'readonly');
});
