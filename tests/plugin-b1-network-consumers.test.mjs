// B1 consumer boundary: real runtime, core-agent's session fetch adapter and auth host.
// Fake provider responses only; no accounts, stored credentials or public network requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createAuthHost, createSelectedFetch } from '../apps/common/auth-host.js';
import { fetchOption } from '../plugins/core-agent/web/open-sessions.js';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';

const memory = () => ({ getItem: () => null });
async function network(register) {
  let ready = false;
  const requests = [];
  const runtime = createPluginRuntime({ storage: memory() });
  runtime.register({
    id: 'net-tailscale', version: '1.0.0', name: 'Tailscale exit node',
    provides: [{ id: 'net.fetch', version: 1, default: true }],
    setup(ctx) {
      ctx.provide('net.fetch', 1, Object.assign(async (input, init) => {
        requests.push({ input, init });
        return new Response('selected route');
      }, { available: () => ready, describe: () => ({ id: 'net-tailscale', status: ready ? 'ready' : 'unavailable' }) }));
    }
  });
  register?.(runtime);
  await runtime.start();
  return { runtime, requests, ready: value => { ready = value; } };
}

test('browser session initially unready -> ready -> unavailable uses the same fetch, never bundled/direct/HTTP fallback', async () => {
  const fixture = await network();
  let bypasses = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => { bypasses++; throw new Error('direct leak'); };
  const bridge = { call() { bypasses++; throw new Error('old HTTP bridge recursion'); } };
  try {
    const bundled = () => { bypasses++; throw new Error('selection bypassed'); };
    // This is the exact adapter called by createSessionOpener, with the getter core-agent passes.
    const fetch = fetchOption({ bridge, hostInfo: { platform: 'browser' }, fetch: bundled }, {
      net: () => fixture.runtime.service('net.fetch', 1)
    }).fetch;
    assert.equal(typeof fetch, 'function', 'never leave fetch undefined for the engine last resort');
    await assert.rejects(fetch('https://models.example.test/'), /Network is unavailable/);
    assert.equal(fetch.describe().status, 'unavailable');
    fixture.ready(true);
    const controller = new AbortController();
    const init = { method: 'POST', body: 'payload', signal: controller.signal };
    assert.equal(await (await fetch('https://models.example.test/', init)).text(), 'selected route');
    assert.equal(fixture.requests[0].init, init, 'body/signal/options reach the provider unchanged');
    assert.equal(fetch.describe().id, 'net-tailscale');
    fixture.ready(false);
    await assert.rejects(fetch('https://models.example.test/'), /Network is unavailable/);
    assert.equal(fixture.requests.length, 1);
    assert.equal(bypasses, 0);
  } finally { globalThis.fetch = original; await fixture.runtime.close(); }
});

test('actual core-agent setup opens one initially-unready browser session with a stable fail-closed transport', { skip: !await libraryAvailable() }, async () => {
  const app = await assembleApp();
  let fixture, opened;
  const captured = [];
  let bypasses = 0, openings = 0, opening;
  try {
    const agent = await app.load('builtin/core-agent/web/index.js');
    const pd = await app.load('library/pi-durable.js');
    const lifecycle = {
      sessionOptions: {
        bridge: { call() { bypasses++; throw new Error('unexpected bridge request'); } },
        hostInfo: { platform: 'browser', capabilities: {} },
        workspace: { read: async () => '', write: async () => {}, list: async () => [] },
        fetch: () => { bypasses++; throw new Error('bundled selection bypass'); },
        extra: { storage: new pd.MemoryStorage(), toolchain: false },
        // Observe the real session engine's transport handed to its actual provider rows.
        agentProviders: { attach(_models, { builtins }) {
          return {
            rows: () => builtins.map(entry => entry.value),
            instantiate(row, host) { captured.push(host.transport()); return { row, instance: row.create(host) }; },
            subscribe: () => () => {}, detach() {}
          };
        } }
      },
      begin(opener) { openings++; opening = opener({ wanted: () => true }); return true; }
    };
    fixture = await network(runtime => runtime.register({
      id: 'core-agent', version: '1.0.0', uses: [{ id: 'net.fetch', version: 1 }],
      ...agent.create({ sessions: {}, lifecycle })
    }));
    opened = await opening;
    assert.ok(opened, 'real session opened while the route was unready');
    assert.ok(captured.length > 0, 'real provider rows received their transport');
    const fetch = captured[0];
    await assert.rejects(fetch('https://model.example.test/'), /Network is unavailable/);
    fixture.ready(true);
    assert.equal(await (await fetch('https://model.example.test/')).text(), 'selected route');
    fixture.ready(false);
    await assert.rejects(fetch('https://model.example.test/'), /Network is unavailable/);
    assert.equal(openings, 1, 'readiness recovery never reopened the session');
    assert.equal(bypasses, 0, 'neither bundled selection bypass nor engine bridge last resort ran');
  } finally { await opened?.close(); await fixture?.runtime.close(); await app.remove(); }
});

test('browser auth HTTP resolves per request; composition failure alone permits explicit owning bundled fallback', async () => {
  const fixture = await network();
  let composition = fixture.runtime;
  let bundledRequests = 0, bridgeRequests = 0, nativeFactories = 0, directRequests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => { directRequests++; throw new Error('direct leak'); };
  const bridge = { call(method) {
    bridgeRequests++;
    assert.equal(method, 'auth.info', 'HTTP must not re-enter the browser bridge');
    return { signedIn: true };
  } };
  const bundled = async () => { bundledRequests++; return new Response('owning bundled route'); };
  try {
    const host = createAuthHost(bridge, {
      fetch: createSelectedFetch({ runtime: () => composition, fallback: () => bundled }),
      createFetch() { nativeFactories++; throw new Error('native factory must not be called'); }
    });
    assert.deepEqual(await host.call('auth.info', {}), { signedIn: true });
    await assert.rejects(host.fetch('https://auth.example.test/token'), /Network is unavailable: Tailscale exit node is not available/);
    assert.equal(bundledRequests, 0, 'present/unavailable is not failed composition');
    fixture.ready(true);
    assert.equal(await (await host.fetch('https://auth.example.test/token', { method: 'POST' })).text(), 'selected route');
    fixture.ready(false);
    await assert.rejects(host.fetch('https://auth.example.test/token'), /not available/);
    composition = null; // Missing/failed composition: page supplies the owning bundled implementation.
    assert.equal(await (await host.fetch('https://auth.example.test/token')).text(), 'owning bundled route');
    assert.equal(bundledRequests, 1);
    composition = fixture.runtime;
    await assert.rejects(host.fetch('https://auth.example.test/token'), /not available/);
    assert.equal(bundledRequests, 1, 'composition recovery reinstates fail-closed selection');
    assert.equal(nativeFactories, 0);
    assert.equal(bridgeRequests, 1, 'only the explicit auth call used the bridge');
    assert.equal(directRequests, 0);
  } finally { globalThis.fetch = original; await fixture.runtime.close(); }
});

test('no owning fallback fails clearly; a throwing live resolver cannot escape to fallback', async () => {
  const absent = createSelectedFetch({ runtime: () => null });
  await assert.rejects(absent('https://external.example.test/'), /Network is unavailable/);
  let fallbackCalls = 0;
  const broken = createSelectedFetch({
    runtime: () => ({ service() { throw new Error('resolution failed'); } }),
    fallback: () => { fallbackCalls++; return () => 'bypass'; }
  });
  await assert.rejects(broken('https://external.example.test/'), /resolution failed/);
  assert.equal(fallbackCalls, 0);
});

test('ready Android native provider and absent-composition bundled opener retain functionality', async () => {
  const calls = [];
  const bridge = { call: async method => {
    calls.push(method);
    if (method === 'http.send') return { status: 200, statusText: 'OK', headers: [], url: 'https://api.example.test/' };
    if (method === 'http.read') return { done: true, data: '' };
    return {};
  }, onClose: () => () => {} };
  // The owning native-fetch implementation, not a hand-made native request twin.
  const { createNativeFetch } = await import('../plugins/core-net-native/web/native-fetch.js');
  const native = createNativeFetch(bridge);
  const managed = fetchOption({ bridge }, { net: () => native }).fetch;
  assert.equal((await managed('https://api.example.test/')).status, 200);
  assert.equal(calls[0], 'http.open');
  const bundled = fetchOption({ bridge, fetch: native }).fetch;
  assert.equal(bundled, native, 'bundled opener without managed getter uses the owning page copy');
  assert.equal((await bundled('https://api.example.test/')).status, 200);
});
