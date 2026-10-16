import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginRuntime } from '../apps/common/plugin-runtime.js';
import { createPluginEventChannel, loadInstalledPlugins } from '../apps/common/plugin-client.js';

// Track B part 1: native → page plugin events over the PiPlugins channel (plugin-client.js
// ctx.native.on). The port is a fake of the WebMessage listener object; the native side
// (PluginEvents.kt) is covered by the JVM checks. Not on-device verification.
const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const manifest = (options = {}) => ({
  id: 'counter', name: 'Counter', version: '0.1.0', hash: HASH, enabled: true, state: 'installed',
  web: { entry: 'web/index.js' }, reload: 'scope', provides: [], requires: [], uses: [], ...options
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakePort({ events = true } = {}) {
  const sent = [], listeners = new Set();
  const port = { postMessage(text) { assert.equal(typeof text, 'string'); sent.push(JSON.parse(text)); }, onmessage: null };
  if (events) port.addEventListener = (type, fn) => { if (type === 'message') listeners.add(fn); };
  const deliver = (value) => {
    const message = { data: typeof value === 'string' ? value : JSON.stringify(value) };
    for (const fn of listeners) fn(message);
    port.onmessage?.(message);
  };
  return { port, sent, deliver };
}
const event = (page, options = {}) => ({ type: 'event', page, plugin: 'counter', hash: HASH, event: 'tick', data: { n: 1 }, seq: 1, dropped: 0, ...options });

async function load({ capabilities = { plugins: true, pluginEvents: true }, port = fakePort().port, plugins = [manifest()], onError } = {}) {
  const runtime = createPluginRuntime();
  const contexts = {};
  const bridge = { async call(method) { if (method === 'plugins.list') return { api: 1, plugins }; throw new Error(`unexpected ${method}`); } };
  await loadInstalledPlugins({ runtime, bridge, hostInfo: { capabilities }, eventPort: port, onError,
    importModule: async (url) => ({ setup(ctx) { contexts[url.split('/')[4]] = ctx; } }) });
  await runtime.start();
  return { runtime, contexts };
}

test('hosts without pluginEvents: ctx.native.events is false and on() is a harmless no-op', async () => {
  for (const capabilities of [{ plugins: true }, { plugins: true, pluginEvents: false }]) {
    const fake = fakePort();
    const { runtime, contexts } = await load({ capabilities, port: fake.port });
    const native = contexts.counter.native;
    assert.equal(native.events, false);
    const off = native.on('tick', () => assert.fail('no events on old hosts'));
    assert.equal(typeof off, 'function'); off(); off();
    fake.deliver(event('anything'));
    assert.deepEqual(fake.sent, [], 'old hosts never receive PiPlugins traffic');
    await runtime.close();
  }
  // Capability claimed but no PiPlugins object injected (e.g. a fork): still a no-op.
  const { runtime, contexts } = await load({ port: null });
  assert.equal(contexts.counter.native.events, false);
  contexts.counter.native.on('tick', () => {})();
  await runtime.close();
});

test('on() announces the plugin for this page and delivers only its own events', async () => {
  const fake = fakePort(), errors = [];
  const { runtime, contexts } = await load({ port: fake.port, onError: (error, details) => errors.push([error.message, details]),
    plugins: [manifest(), manifest({ id: 'other', hash: OTHER })] });
  const native = contexts.counter.native;
  assert.equal(native.events, true);
  assert.deepEqual(fake.sent, [], 'nothing is announced before a listener exists');
  const seen = [];
  native.on('tick', (data, info) => seen.push([data.n, info.event, info.seq, info.dropped]));
  assert.equal(fake.sent.length, 1);
  const [listen] = fake.sent;
  assert.equal(listen.type, 'listen'); assert.deepEqual(listen.plugins, ['counter']);
  assert.match(listen.page, /^[A-Za-z0-9_-]{8,64}$/);
  const page = listen.page;
  fake.deliver(event(page, { data: { n: 1 }, seq: 1 }));
  fake.deliver(event(page, { data: { n: 2 }, seq: 2, dropped: 3 }));
  fake.deliver(event('another-page-token', { data: { n: 99 } })); // an older/newer document's traffic
  fake.deliver(event(page, { hash: OTHER, data: { n: 98 } })); // another revision of the plugin
  fake.deliver(event(page, { event: 'tock', data: { n: 97 } })); // not subscribed
  fake.deliver(event(page, { plugin: 'other', data: { n: 96 } }));
  for (const junk of ['not json', '"string"', 'null', JSON.stringify({ ...event(page), type: 'emit' }), 'x'.repeat(2 * 1024 * 1024)]) fake.deliver(junk);
  assert.deepEqual(seen, [[1, 'tick', 1, 0], [2, 'tick', 2, 3]]);
  // A throwing callback is reported; the other subscribers still run.
  const second = [];
  native.on('tick', () => { throw new Error('listener broke'); });
  native.on('tick', (data) => second.push(data.n));
  assert.equal(fake.sent.length, 1, 'the plugin set did not change, so no new listen message');
  fake.deliver(event(page, { data: { n: 3 } }));
  assert.deepEqual(second, [3]);
  assert.deepEqual(errors, [['listener broke', { id: 'counter', phase: 'event' }]]);
  // A second plugin joins the set.
  contexts.other.native.on('tick', () => {});
  assert.deepEqual(fake.sent.at(-1).plugins, ['counter', 'other']);
  assert.equal(fake.sent.at(-1).page, page, 'one token per page');
  await runtime.close();
});

test('subscriptions belong to the plugin scope: off() and scope closure release them', async () => {
  const fake = fakePort();
  const { runtime, contexts } = await load({ port: fake.port });
  const native = contexts.counter.native;
  const seen = [];
  const off = native.on('tick', (data) => seen.push(data.n));
  const page = fake.sent[0].page;
  fake.deliver(event(page, { data: { n: 1 } }));
  off(); off();
  assert.deepEqual(fake.sent.at(-1).plugins, [], 'host is told nobody listens any more');
  fake.deliver(event(page, { data: { n: 2 } }));
  native.on('tick', (data) => seen.push(data.n * 10));
  assert.deepEqual(fake.sent.at(-1).plugins, ['counter']);
  fake.deliver(event(page, { data: { n: 3 } }));
  await runtime.stop('counter');
  await tick();
  assert.deepEqual(fake.sent.at(-1).plugins, [], 'stopping the plugin releases its listeners');
  fake.deliver(event(page, { data: { n: 4 } }));
  assert.deepEqual(seen, [1, 30]);
  const late = native.on('tick', () => assert.fail('closed scope'));
  assert.equal(typeof late, 'function'); late();
  assert.deepEqual(fake.sent.at(-1).plugins, []);
  await runtime.close();
});

test('invalid event names and callbacks are refused', async () => {
  const fake = fakePort();
  const { runtime, contexts } = await load({ port: fake.port });
  const native = contexts.counter.native;
  for (const name of ['', '1tick', 'has space', 'x'.repeat(65), 'ü', 7]) assert.throws(() => native.on(name, () => {}), /event names/);
  assert.throws(() => native.on('tick'), /callback/);
  assert.deepEqual(fake.sent, []);
  await runtime.close();
});

test('the channel falls back to onmessage and keeps an existing handler; one channel per port', () => {
  const fake = fakePort({ events: false });
  const previous = [];
  fake.port.onmessage = (message) => previous.push(message.data);
  const channel = createPluginEventChannel({ port: fake.port });
  assert.equal(createPluginEventChannel({ port: fake.port }), channel);
  const seen = [];
  const off = channel.on('counter', HASH, 'tick', (data) => seen.push(data.n));
  fake.deliver(event(channel.page, { data: { n: 5 }, dropped: 2 }));
  assert.deepEqual(seen, [5]);
  assert.equal(previous.length, 1);
  assert.deepEqual(channel.stats(), { dropped: 2, delivered: 1, plugins: ['counter'] });
  off();
  assert.equal(createPluginEventChannel({ port: {} }), null);
  assert.equal(createPluginEventChannel({}), null);
  assert.throws(() => channel.on('Bad', HASH, 'tick', () => {}), /Invalid plugin id/);
});
