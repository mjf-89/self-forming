// Browser transport/compatibility glue. Implementations and page controllers are the SAME
// owning bundled entries used by normal composition; no cors-rot stack lives in this host.
import { createController as createTor } from '../../plugins/net-tor/web/index.js';
import { createController as createTailscale, createBrowserStorage } from '../../plugins/net-tailscale/web/index.js';
import { pageFetch } from '../../plugins/core-net-page/web/index.js';
import { createPluginRuntime } from '../common/plugin-runtime.js';

const ROUTE_KEY = 'self-forming.net.route';
const LEGACY_KEY = 'self-forming.browser.network-mode';
const MIGRATED_KEY = 'self-forming.browser.network-mode.migrated';
const DEFAULT = 'net-tailscale';

export function migrateNetworkRoute(storage) {
  try {
    if (storage?.getItem(MIGRATED_KEY) === '1') return;
    // Explicit canonical choice wins, even an empty/unknown value. Mark the compatibility
    // read consumed so choosing the default later (which removes ROUTE_KEY) cannot revive Tor.
    if (storage?.getItem(ROUTE_KEY) !== null) { storage?.setItem(MIGRATED_KEY, '1'); return; }
    const legacy = storage?.getItem(LEGACY_KEY);
    if (legacy !== null && legacy !== undefined) {
      storage.setItem(ROUTE_KEY, legacy === 'tor' ? 'net-tor' : DEFAULT);
      if (storage.getItem(ROUTE_KEY) !== (legacy === 'tor' ? 'net-tor' : DEFAULT)) return;
    }
    storage?.setItem(MIGRATED_KEY, '1');
  } catch { /* failed persistence: leave migration retryable, never clear the legacy record */ }
}

/** net.fetch@1 transport adjunct v1: selected service.transport has connect(host,port,
 * {tls,signal,timeoutMs}), warmUp(), preconnect(url), getStatus(). Raw streams retain their
 * cancellation/backpressure APIs. Explicit worker fetchTor is the named Tor override, not a
 * change to the selected provider. Same-origin Fetch bypasses route readiness altogether.
 */
export function createBrowserNetwork({ storage, nativeFetch = globalThis.fetch?.bind(globalThis), origin = globalThis.location?.href,
  hostInfo = { platform: 'browser', capabilities: {} }, loadCorsRot, controllers: supplied } = {}) {
  migrateNetworkRoute(storage);
  const controllers = supplied ?? {
    'net-tor': createTor({ hostInfo, ...loadCorsRot ? { loadCorsRot } : {} }),
    'net-tailscale': createTailscale({ hostInfo, browserStorage: createBrowserStorage(storage), ...loadCorsRot ? { loadCorsRot } : {} })
  };
  // The bundled recovery uses the SAME general runtime/selector and SAME owner controllers,
  // not a second network implementation or a home-grown provider resolver.
  const bundled = createPluginRuntime({ storage });
  for (const controller of Object.values(controllers)) bundled.register({
    id: controller.id, version: '1.0.0', name: controller.name, hint: controller.hint,
    provides: [{ id: 'net.fetch', version: 1, ...controller.id === DEFAULT ? { default: true } : {} }],
    setup: ctx => controller.attach({ ...ctx, provide: (id, version, value) => ctx.provide(id, version, recoveryValue(controller.id, value)) })
  });
  bundled.register({ id: 'core-net-page', version: '1.0.0', name: pageFetch.describe().label,
    provides: [{ id: 'net.fetch', version: 1 }], setup: ctx => ctx.provide('net.fetch', 1, recoveryValue('core-net-page', pageFetch)) });
  let runtime = null, offRuntime, disposed = false, syncing = false, disposal;
  const listeners = new Set(), stops = [];
  const choice = () => { try { return storage?.getItem(ROUTE_KEY) || null; } catch { return null; } };
  const intended = () => runtime?.selection.choice('net.fetch', 1) ?? choice() ?? DEFAULT;
  const records = () => runtime?.list() ?? [];
  // Failure recovery is distinct from unready/stopped/blocked providers. An actual setup
  // failure (including an essential plugin) can recover with this same page controller.
  const suppressed = id => records().some(r => r.id === id && ['stopped', 'blocked'].includes(r.state));
  const recovery = () => !suppressed(intended()) && (records().some(r => r.essential && r.state === 'failed') ||
    records().some(r => r.id === intended() && r.state === 'failed'));
  // Recovery must not republish a deliberately stopped/blocked choice OR default from
  // its still-ready page controller. Leave provider resolution to the general runtime.
  function recoveryValue(id, value) {
    return Object.freeze(Object.assign((...args) => {
      if (suppressed(id)) return Promise.reject(new Error('Network provider is not active'));
      return value(...args);
    }, value, { available: () => !suppressed(id) && (typeof value.available !== 'function' || value.available()) }));
  }
  const selectedController = () => controllers[intended()];
  const effective = () => runtime && !recovery() ? runtime : bundled;
  function sync() {
    if (syncing || disposed) return;
    syncing = true;
    try {
      const id = intended();
      for (const controller of Object.values(controllers)) {
        const state = records().find(r => r.id === controller.id)?.state;
        controller.setSelected(controller.id === id && !['stopped', 'blocked'].includes(state));
      }
    } finally { syncing = false; }
  }
  function status() {
    const id = intended(), snapshot = selectedController()?.service.transport.getStatus() ?? {};
    const resolved = effective().selection.resolve('net.fetch', 1);
    return { ...snapshot, mode: id === 'net-tor' ? 'tor' : id === DEFAULT ? 'tailscale' : id,
      transport: id === 'net-tor' ? 'tor' : id === DEFAULT ? 'tailscale' : id,
      provider: id, recovery: Boolean(runtime && recovery()),
      status: `${resolved.status}${runtime && !recovery() ? '' : ' (Bundled recovery)'}`,
      torState: id === 'net-tor' ? snapshot.torState ?? 'idle' : 'idle' };
  }
  function notify() {
    if (disposed) return;
    const value = status();
    for (const listener of [...listeners]) { try { listener(value); } catch {} }
  }
  function provider() {
    if (disposed) throw new Error('Network is disposed');
    sync();
    const value = effective().service('net.fetch', 1);
    if (typeof value !== 'function') throw new Error(`Network is unavailable: ${status().status}`);
    return value;
  }
  const sameOrigin = input => {
    try { return Boolean(origin) && new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin).origin === new URL(origin).origin; }
    catch { return false; }
  };
  const fetch = async (input, init) => {
    // Assets, revisions and OAuth same-origin helpers never wait for external route startup.
    if (sameOrigin(input)) return nativeFetch(input, init);
    await bundledReady;
    return provider()(input, init);
  };
  for (const controller of Object.values(controllers)) stops.push(controller.subscribe(() => {
    if (runtime) runtime.service('net.fetch', 1); // refresh generic Providers status
    notify();
  }));
  const facade = {
    controllers, fetch,
    // Explicit Tor stays independent of the selected external-model provider.
    fetchTor: (input, init) => sameOrigin(input) ? nativeFetch(input, init) : disposed ? Promise.reject(new Error('Network is disposed')) : controllers['net-tor'].service.transport.fetchTor(input, init),
    connect: async (host, port, options) => {
      await bundledReady;
      const transport = provider().transport;
      if (!transport?.connect) throw new Error('Selected network provider does not support raw TCP');
      return transport.connect(host, port, options);
    },
    warmUp: async () => { if (disposed) throw new Error('Network is disposed'); sync(); const controller = selectedController();
      const state = records().find(row => row.id === controller?.id)?.state;
      if (['stopped', 'blocked'].includes(state)) throw new Error('Selected network provider is not active');
      return controller?.service.transport.warmUp(); },
    preconnect: async url => sameOrigin(url) ? { route: 'direct', warmed: false } : provider().transport?.preconnect?.(url) ?? { warmed: false, reason: 'unsupported' },
    getStatus: async () => status(),
    subscribe: async listener => { listeners.add(listener); listener(status()); return () => listeners.delete(listener); },
    setMode: async mode => {
      if (disposed) throw new Error('Network is disposed');
      if (!['tor', 'tailscale'].includes(mode)) throw new Error('Network mode must be tailscale or tor');
      const id = mode === 'tor' ? 'net-tor' : DEFAULT;
      if (runtime) runtime.selection.choose('net.fetch', 1, id);
      else { try { storage?.setItem(ROUTE_KEY, id); } catch {} }
      sync(); notify(); return status();
    },
    bind: value => {
      if (disposed) return;
      offRuntime?.(); runtime = value ?? null;
      offRuntime = runtime?.subscribe(() => { sync(); notify(); });
      sync(); notify();
    },
    // Used by auth/session consumers even after a returned runtime suffered setup failure.
    needsRecovery: () => Boolean(runtime && recovery()),
    dispose: () => {
      if (disposal) return disposal;
      disposed = true; offRuntime?.(); for (const stop of stops) stop(); listeners.clear();
      disposal = Promise.all([bundled.close(), ...Object.values(controllers).map(controller => controller.dispose())]);
      return disposal;
    }
  };
  const selection = Object.fromEntries(['providers', 'services', 'resolve', 'choose', 'choice'].map(method =>
    [method, (...args) => {
      const result = effective().selection[method](...args);
      if (method === 'choose') { sync(); notify(); }
      return result;
    }]));
  const subscribeSettings = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  let panel;
  // app.js supplies the generic owning bundled entry from its registry (served paths).
  facade.configureSettingsProvider = factory => { panel ??= factory({ selection, subscribe: subscribeSettings }); notify(); };
  // Settings recovery merges only MISSING owner contributions, preserving unrelated active
  // plugin sections and avoiding duplicate node ids. The UI implementation remains its owner.
  facade.settingsRuntime = Object.freeze({
    subscribe: subscribeSettings,
    contributions: kind => {
      const entries = runtime?.contributions(kind) ?? [];
      if (kind !== 'settings.sections') return entries;
      const result = entries.map(row => panel && recovery() && row.key === 'providers' ? { ...row, value: panel } : row);
      if (panel && !entries.some(row => row.key === 'providers')) result.push({ providerId: 'core-plugin-management', key: 'providers', value: panel, order: 25 });
      for (const controller of Object.values(controllers)) {
        const state = records().find(row => row.id === controller.id)?.state;
        if ((!runtime || recovery()) && !['stopped', 'blocked'].includes(state) && !entries.some(row => row.providerId === controller.id))
          result.push({ providerId: controller.id, key: controller.id + '-options', value: controller.section, order: 30 });
      }
      return result;
    }
  });
  const bundledReady = bundled.start();
  void bundledReady.then(notify);
  // B5 compatibility status adapters: no node creation, selection or implementation here.
  facade.tailscale = {
    getStatus: () => controllers[DEFAULT].service.transport.getStatus().tailscale ?? { state: 'off', exitNodes: [] },
    subscribe: listener => controllers[DEFAULT].subscribe(() => listener(facade.tailscale.getStatus())),
    start: () => facade.warmUp(),
    setExitNode: id => controllers[DEFAULT].service.transport.tailscale?.setExitNode(id),
    logout: () => controllers[DEFAULT].service.transport.signOut(),
  };
  facade.snowflakeProxy = {
    getStatus: () => controllers['net-tor'].service.transport.getStatus().proxy ?? { state: 'stopped', active: false },
    subscribe: listener => controllers['net-tor'].subscribe(() => listener(facade.snowflakeProxy.getStatus()))
  };
  // Merely constructing the host stays lazy. Startup warmUp/bind explicitly activates intent.
  return Object.freeze(facade);
}
