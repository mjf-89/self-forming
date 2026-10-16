// Generated/dummy records only. No real storage, login or application network.
import test from 'node:test';
import { heavy } from "./heavy.mjs";
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
globalThis.crypto ??= webcrypto;

async function exercise(base, built = false) {
  const plugin = built ? 'builtin' : 'plugins';
  const { openClaudeBrowserSignIn, loadClaudeBrowserRecord } = await import(`${base}/${plugin}/core-providers-claude/web/browser-auth.js`);
  const opened = [];
  openClaudeBrowserSignIn('https://claude.ai/oauth/authorize?dummy=1', url => opened.push(url));
  assert.deepEqual(opened, ['https://claude.ai/oauth/authorize?dummy=1']);
  for (const url of ['http://claude.ai/', 'javascript:void(0)', 'file:///dummy']) {
    assert.throws(() => openClaudeBrowserSignIn(url, () => assert.fail('must not open')), { code: 'AUTH_ERROR', message: 'Only HTTPS sign-in pages can be opened' });
  }
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  assert.equal(loadClaudeBrowserRecord(storage, 'dummy'), null);
  storage.setItem('dummy', '{');
  assert.throws(() => loadClaudeBrowserRecord(storage, 'dummy'), SyntaxError);
  const old = globalThis.localStorage;
  globalThis.localStorage = storage;
  const { createBrowserHost } = await import(`${base}/${built ? '' : 'apps/browser/'}browser-host.js`);
  const { Vfs } = await import(`${base}/${plugin}/core-execution/web/browser/browser-vfs.js`);
  const vfs = await Vfs.open({ backend: { async open() {}, async loadMeta() { return []; }, async readContent() {}, async save() {}, close() {} } });
  let host;
  try {
    host = await createBrowserHost({ vfs, network: { fetch() { assert.fail('no network'); } } });
    const { createNativeBridge } = await import(`${base}/${built ? '' : 'dist/app/'}native-host.js`);
    const bridge = createNativeBridge(host.transport);
    try {
      for (const provider of ['unknown', 'plugin:net-tailscale:state', '', null, '__proto__']) {
        for (const method of ['auth.load','auth.save','auth.clear','auth.openExternal']) {
          await assert.rejects(bridge.call(method, { provider, record: { version: 1 }, url: 'https://claude.ai/' }), /Unsupported browser auth provider/);
        }
      }
      await bridge.call('auth.save', { record: { version: 1, ignored: 'dummy' } });
      await bridge.call('auth.save', { provider: 'claude', record: { version: 1, provider: 'claude' } });
      assert.equal(data.get('self-forming.browser.auth.chatgpt'), '{"version":1}');
      assert.equal(data.get('self-forming.browser.auth.claude'), '{"version":1,"provider":"claude"}');
      assert.match(data.get('self-forming.browser.host-id'), /^urn:uuid:/);
      storage.setItem = () => { throw new Error('dummy-quota'); };
      await assert.rejects(bridge.call('auth.save', { record: { version: 1 } }), /ChatGPT sign-in could not be saved in this browser/);
    } finally { bridge.close(); }
  } finally {
    host?.dispose(); await vfs.flush();
    if (old === undefined) delete globalThis.localStorage; else globalThis.localStorage = old;
  }
}

test('owner adapters resolve in source and nonlive build; bootstrap fixed exceptions stay narrow', { skip: heavy }, async () => {
  const root = resolve(new URL('..', import.meta.url).pathname);
  await exercise(pathToFileURL(root).href);
  const out = await mkdtemp(resolve(root, '../plugin-b4-build-'));
  try {
    execFileSync('sh', ['scripts/build-browser.sh', out], { cwd: root, stdio: 'pipe' });
    await writeFile(`${out}/package.json`, JSON.stringify({ type: "module" }));
    await exercise(pathToFileURL(out).href, true);
    await assert.rejects(access(`${out}/browser-oauth.js`));
    const manifest = JSON.parse(await readFile(`${out}/app-manifest.json`, 'utf8'));
    const { FIXED } = await import('../apps/browser/browser-revisions.js');
    const sw = await readFile(`${out}/sw.js`, 'utf8');
    const swFixed = new RegExp(sw.match(/const FIXED = \/(.*)\//)[1]);
    for (const name of ['builtin/core-providers-chatgpt/web/browser-oauth.js', 'builtin/core-providers-claude/web/browser-auth.js']) {
      assert.ok(!manifest.editableFiles.includes(name)); assert.ok(FIXED.test(name)); assert.ok(swFixed.test(name));
    }
    for (const name of ['builtin/core-providers-chatgpt/web/chatgpt-auth.js', 'builtin/core-providers-claude/web/claude-auth.js']) {
      assert.ok(manifest.editableFiles.includes(name)); assert.ok(!FIXED.test(name)); assert.ok(!swFixed.test(name));
    }
    const main = await readFile(`${out}/browser-main.js`, 'utf8');
    assert.match(main, /\.\/builtin\/core-providers-chatgpt\/web\/browser-oauth.js/);
  } finally { await rm(out, { recursive: true, force: true }); }
});
