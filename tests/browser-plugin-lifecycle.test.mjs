// Nonvisual lifecycle test: real shared VFS, installed client/runtime and actual ESM
// setup (Node file import adapter), owner response serving; durable-store double.
// This is NOT a real browser/ServiceWorker/IndexedDB acceptance test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Vfs, MemoryBackend } from '../plugins/core-execution/web/browser/browser-vfs.js';
import { createBrowserPlugins } from '../plugins/core-plugin-management/web/browser-plugin-host.js';
import { packageHash, validatePackage } from '../plugins/core-plugin-management/web/browser-plugin-package.js';
import { servePlugin, isPluginRequest } from '../plugins/core-plugin-management/web/browser-plugin-serving.js';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { loadInstalledPlugins } from '../apps/common/plugin-client.js';
import { styleUrl } from '../apps/common/plugin-styles.js';
globalThis.crypto ??= webcrypto;
const enc = text => new TextEncoder().encode(text);
const base = 'https://example.test/deploy/app/', builtinIds = ['core-agent','look-public'];
const manifest = extra => ({ id:'agent-notes', name:'Agent notes', version:'1.0', api:1, reload:'page', web:{entry:'web/index.js'}, provides:[{id:'notes.value',version:1}], requires:[], uses:[], ...extra });
function durableDouble() {
  const snapshots = new Map(), selections = new Map();
  let rejectPublish = false;
  return {
    durable:true, snapshots, selectionsMap: selections,
    failNext: () => { rejectPublish = true; },
    snapshot: async (id,hash) => structuredClone(snapshots.get(`${id}/${hash}`)),
    selection: async id => structuredClone(selections.get(id)),
    selections: async () => structuredClone([...selections.values()]),
    publish: async (snapshot,selection) => {
      if (rejectPublish) { rejectPublish = false; throw new Error('quota abort'); }
      if (snapshot && !snapshots.has(`${snapshot.manifest.id}/${snapshot.hash}`)) snapshots.set(`${snapshot.manifest.id}/${snapshot.hash}`,structuredClone(snapshot));
      selections.set(selection.id,structuredClone(selection));
    }, close() {}
  };
}
async function fixture() {
  const backend = new MemoryBackend(), vfs = await Vfs.open({backend}), store = durableDouble();
  const options = { vfs, store, builtinIds, assetBase:'/deploy/app/assets/web/plugins/' };
  const host = await createBrowserPlugins(options);
  const call = (name,args = {}) => host.methods[`plugins.${name}`](args);
  function author(value, extra = {}) {
    vfs.write('/workspace/plugins/agent-notes/plugin.json',enc(JSON.stringify(manifest(extra))));
    vfs.write('/workspace/plugins/agent-notes/web/index.js',enc("import {value} from './value.js'; export function setup(ctx) { ctx.provide('notes.value',1,{get:()=>value}); ctx.contribute('test.ui','notes',{label:value}); }"));
    vfs.write('/workspace/plugins/agent-notes/web/value.js',enc(`export const value = ${JSON.stringify(value)};`));
    vfs.write('/workspace/plugins/agent-notes/web/theme.css',enc('body { background: url(./icon.svg); }'));
    vfs.write('/workspace/plugins/agent-notes/web/icon.svg',enc('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  }
  const response = (path, init) => servePlugin(new Request(new URL(path,base),init), base,{openStore:async()=>store});
  return {vfs,backend,store,options,host,call,author,response};
}
test('agent authors shared VFS plugin → immutable install → actual installed ESM setup → upgrade/pins/disable/rollback/reconstructed host', async () => {
  const f = await fixture(), dir = await mkdtemp(join(tmpdir(),'browser-plugin-esm-'));
  let runtime;
  try {
    // The workspace file tool and installer share this exact VFS, not another package system.
    f.author('first');
    const first = await f.call('install',{path:'plugins/agent-notes'});
    assert.equal(first.reloadRequired,true); assert.equal(first.restartRequired,false);
    const firstUrl = `${f.options.assetBase}${first.id}/${first.hash}/web/`;
    assert.equal((await f.call('list')).plugins[0].state,'reload-required','installation is not activation');
    const pageHost = await createBrowserPlugins(f.options);
    runtime = createPluginRuntime();
    await loadInstalledPlugins({ runtime, bridge:{call:(method,args)=>pageHost.methods[method](args)}, hostInfo:{platform:'browser',pluginAssetBase:f.options.assetBase,capabilities:{plugins:true,pluginRead:true}}, importModule: async url => {
      assert.equal(url,`${firstUrl}index.js`);
      // Real ESM resolution with a relative dependency; bytes come only from owner serving.
      const local = join(dir,first.hash,'web'); await mkdir(local,{recursive:true});
      await writeFile(join(dir,'package.json'),'{"type":"module"}');
      for (const path of ['index.js','value.js']) {
        const response = await f.response(firstUrl+path); assert.equal(response.status,200);
        await writeFile(join(local,path),new Uint8Array(await response.arrayBuffer()));
      }
      return import(pathToFileURL(join(local,'index.js')).href);
    }});
    await runtime.start();
    assert.equal(runtime.service('notes.value').get(),'first');
    assert.equal(runtime.contributions('test.ui')[0].value.label,'first');
    f.author('second',{version:'2.0'});
    assert.match(await (await f.response(firstUrl+'value.js')).text(),/first/,'editable source cannot mutate snapshot');
    const second = await f.call('install',{path:'/workspace/plugins/agent-notes'});
    assert.notEqual(second.hash,first.hash);
    assert.equal(runtime.service('notes.value').get(),'first','no pretend live activation');
    assert.equal((await pageHost.methods['plugins.list']({})).plugins[0].state,'reload-required');
    assert.match((await pageHost.methods['plugins.read']({id:first.id,hash:first.hash,path:'web/value.js'})).text,/first/);
    await f.call('disable',{id:first.id});
    assert.match(await (await f.response(firstUrl+'value.js')).text(),/first/,'disabled page-pinned assets remain readable');
    const reloadedVfs = await Vfs.open({backend:f.backend});
    const reloaded = await createBrowserPlugins({...f.options,vfs:reloadedVfs});
    assert.equal((await reloaded.methods['plugins.list']({})).plugins[0].enabled,false);
    await assert.rejects(reloaded.methods['plugins.read']({id:first.id,hash:first.hash,path:'web/value.js'}),/selected or pinned/);
    assert.equal((await reloaded.methods['plugins.rollback']({id:first.id})).hash,first.hash);
    assert.equal((await reloaded.methods['plugins.list']({})).plugins[0].enabled,false,'rollback does not silently enable');
    await reloaded.methods['plugins.enable']({id:first.id});
    assert.equal((await reloaded.methods['plugins.list']({})).plugins[0].hash,first.hash);
    const safe = await createBrowserPlugins({...f.options,safe:true});
    const safeList = await safe.methods['plugins.list']({}); assert.equal(safeList.plugins[0].state,'blocked');
    let imported = false;
    await loadInstalledPlugins({runtime:createPluginRuntime(),bridge:{call:(m,p)=>safe.methods[m](p)},hostInfo:{capabilities:{plugins:true}},importModule:()=>{imported=true;}});
    assert.equal(imported,false,'safe inventory is nonloadable');
    await safe.methods['plugins.disable']({id:first.id});
    await safe.methods['plugins.rollback']({id:first.id});
    await assert.rejects(f.call('call',{id:first.id,hash:first.hash,method:'fakeKotlin'}),e=>e.code==='PLUGIN_UNAVAILABLE');
  } finally { await runtime?.close(); await f.vfs.flush(); await rm(dir,{recursive:true,force:true}); }
});

test('canonical hash matches independent native/shell record algorithm', async () => {
  const files = {'web/é.js':enc('é'),'plugin.json':enc('{}'),'web/a.js':enc('a')};
  const records = Object.keys(files).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(path=>Buffer.concat([Buffer.from(path+'\0'),Buffer.from(createHash('sha256').update(files[path]).digest('hex')+'\n')]));
  assert.equal(await packageHash(files),createHash('sha256').update(Buffer.concat(records)).digest('hex'));
});

test('failures leave previous selection intact; native, built-in IDs, schema, mutation, size, corrupt bytes, unavailable serving', async () => {
  const f = await fixture();
  try {
    f.author('ok'); const old = await f.call('install',{path:'plugins/agent-notes'});
    for (const extra of [{native:{jar:'native/module.jar'}},{id:'core-agent'},{api:2},{requires:[{id:'x',version:0}]},{requires:[{id:'x',version:1},{id:'x',version:1}]},{web:{entry:'web/%2f.js'}}]) {
      f.author('bad',extra); await assert.rejects(f.call('install',{path:'plugins/agent-notes'}));
      assert.equal((await f.store.selection(old.id)).hash,old.hash);
    }
    f.author('new'); f.store.failNext(); await assert.rejects(f.call('install',{path:'plugins/agent-notes'}),/quota/);
    assert.equal((await f.store.selection(old.id)).hash,old.hash);
    assert.equal((await f.response(`${f.options.assetBase}${old.id}/${old.hash}/web/value.js`)).status,200,'quota/publication failure cannot prevent loading an already-published snapshot');
    const read = f.vfs.read.bind(f.vfs); let reads = 0;
    f.vfs.read = async path => { const bytes = await read(path); if (path.endsWith('value.js') && ++reads === 1) f.vfs.write(path,enc('export const value="raced";')); return bytes; };
    await assert.rejects(f.call('install',{path:'plugins/agent-notes'}),/changed/); f.vfs.read = read;
    f.author('oversized'); f.vfs.get('/workspace/plugins/agent-notes/plugin.json').size = 1048577;
    await assert.rejects(f.call('install',{path:'plugins/agent-notes'}),/limit/);
    for (const path of ['../plugins/agent-notes','/tmp/plugin','/workspace/plugins/../agent-notes','/workspace/plugins%2fagent-notes','/workspace/plugins/agent-notes?q']) await assert.rejects(f.call('install',{path}));
    const corrupt = f.store.snapshots.get(`${old.id}/${old.hash}`); corrupt.files['web/value.js'] = enc('tampered');
    assert.equal((await f.call('list')).plugins[0].state,'failed');
    assert.equal((await f.response(`${f.options.assetBase}${old.id}/${old.hash}/web/value.js`)).status,404);
    await f.call('disable',{id:old.id}); // Recovery survives corrupt code.
    f.host.setServing(false); assert.equal(f.host.available(),false);
    await assert.rejects(f.call('install',{path:'plugins/agent-notes'}),e=>e.code==='PLUGIN_UNAVAILABLE');
  } finally { await f.vfs.flush(); }
});

test('immutable namespace fails closed, supports deployment subpath, accurate MIME and CSS-relative assets', async () => {
  const f = await fixture();
  try {
    f.author('asset'); const first = await f.call('install',{path:'plugins/agent-notes'});
    const prefix = `${f.options.assetBase}${first.id}/${first.hash}/web/`;
    const css = await f.response(prefix+'theme.css'); assert.equal(css.headers.get('content-type'),'text/css; charset=utf-8');
    assert.equal(css.headers.get('x-content-type-options'),'nosniff');
    assert.match(await css.text(),/\.\/icon.svg/);
    const icon = await f.response(new URL('./icon.svg',new URL(prefix+'theme.css',base)).href); assert.equal(icon.headers.get('content-type'),'image/svg+xml');
    for (const suffix of ['missing.js','value.js?x=1','value.js#fragment','%2fvalue.js','%252fvalue.js','%3fvalue.js','../plugin.json']) assert.notEqual((await f.response(prefix+suffix)).status,200,suffix);
    const namespace = new URL(f.options.assetBase+'not-installed/'+'a'.repeat(64)+'/web/index.js',base);
    assert.equal(isPluginRequest(namespace,base),true); assert.equal((await f.response(namespace)).status,404);
    const rawEncoded = new URL('assets%2fweb/plugins/x',base); assert.equal(isPluginRequest(rawEncoded,base),true);
    assert.equal((await f.response(rawEncoded)).status,400);
    globalThis.__piBrowser = {pluginAssetBase:f.options.assetBase};
    assert.equal(styleUrl({id:first.id,hash:first.hash},'web/theme.css'),prefix+'theme.css');
    delete globalThis.__piBrowser;
    const files = {'plugin.json':enc(JSON.stringify(manifest())),'web/index.js':enc('')};
    assert.equal(validatePackage(files).id,'agent-notes');
  } finally { delete globalThis.__piBrowser; await f.vfs.flush(); }
});

test('normal runtime dependencies and failure scopes remain generic, with safe recovery management available', async () => {
  const f = await fixture();
  try {
    f.author('blocked',{requires:[{id:'android.only',version:1}]}); await f.call('install',{path:'plugins/agent-notes'});
    let pageHost = await createBrowserPlugins(f.options);
    const bridge = {call:(m,p)=>pageHost.methods[m](p)}, hostInfo = {capabilities:{plugins:true}};
    let imported = false; const blocked = createPluginRuntime();
    await loadInstalledPlugins({runtime:blocked,bridge,hostInfo,importModule:async()=>{imported=true;return {setup(){}};}});
    await blocked.start(); assert.equal(imported,false); assert.equal(blocked.list()[0].state,'blocked'); await blocked.close();
    f.author('failed'); await f.call('install',{path:'plugins/agent-notes'});
    pageHost = await createBrowserPlugins(f.options);
    const failed = createPluginRuntime();
    await loadInstalledPlugins({runtime:failed,bridge,hostInfo,importModule:async()=>({setup(){throw new Error('fixture setup failed');}})});
    await failed.start(); assert.equal(failed.list()[0].state,'failed'); assert.match(failed.list()[0].reason,/fixture setup failed/); await failed.close();
    const safe = await createBrowserPlugins({...f.options,safe:true});
    assert.equal((await safe.methods['plugins.list']({})).plugins[0].state,'blocked');
    await safe.methods['plugins.disable']({id:'agent-notes'}); await safe.methods['plugins.rollback']({id:'agent-notes'});
  } finally { await f.vfs.flush(); }
});

test('browser digest equals existing scripts/plugin.sh check for the same web-only package', async () => {
  const dir = await mkdtemp(join(tmpdir(),'browser-plugin-hash-'));
  try {
    const files = {'plugin.json':enc(JSON.stringify(manifest())),'web/index.js':enc('export function setup() {}'),'web/é.js':enc('export default "é";')};
    for (const [path,bytes] of Object.entries(files)) { await mkdir(dirname(join(dir,path)),{recursive:true}); await writeFile(join(dir,path),bytes); }
    const {stdout} = await promisify(execFile)('bash',[fileURLToPath(new URL('../scripts/plugin.sh',import.meta.url)),'check',dir]);
    assert.equal(stdout.trim(),`Valid M1 package: ${await packageHash(files)}`);
    const tooMany = {...files}; for (let i=0;i<4096;i++) tooMany[`web/${i}.js`] = new Uint8Array();
    assert.throws(()=>validatePackage(tooMany),/4096/);
    assert.throws(()=>validatePackage({...files,'web/skills/missing/file.txt':enc('x')}),/SKILL.md/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
