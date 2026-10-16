// Page-owned composition. Conversation closure does not close it.
import { createPluginRuntime } from './plugin-runtime.js';
import { createBuiltinPlugins } from './plugin-builtins.js';
import { builtinPlugin } from './builtin-plugins.js';
import { loadInstalledPlugins } from './plugin-client.js';
import { createPluginStyles } from './plugin-styles.js';

// A module that is simply not part of this edition (404 / not found), as opposed to one
// that exists but fails to evaluate (reported).
function moduleMissing(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return true;
  return error instanceof TypeError && /dynamically imported module|importing a module script failed|failed to fetch/i.test(String(error.message));
}

/**
 * agentExtensions (agent-extensions.js) and agentProviders (agent-providers.js, the
 * core-providers-* built-ins and plugin model providers) are connected right after
 * runtime.start(), before optional tools mount, so the chat's readiness barrier is not
 * held up by them.
 *
 * executionOwner: the page's execution owner; core-execution opens its ExecutionEnv over
 * bridge with it (execution@1, step X1). openExecution: optional replacement opener (tests).
 *
 * The storage option registers core-storage (storage@1, X3); parts lets core-agent look up the
 * session engine parts in this runtime (conversations.engine@1, servers.engine@1; X3b, see
 * plugin-builtins.js).
 *
 * loadDevTools: an optional dev tools module (createDevPlugins({browser}) adds built-in
 * definitions, startDevTools({runtime}) runs after start). Not every edition has it; a
 * missing module adds nothing and is not reported.
 */
export async function startPluginComposition({ bridge, hostInfo, executionOwner, openExecution, browserNetwork = globalThis.__piBrowser?.network, browserGit = globalThis.__piBrowser?.git, browserExecution = globalThis.__piBrowser?.execution, onError = console.error, agentExtensions, agentProviders, loadDevTools = () => import('./dev-plugins.js') }) {
  const report = (error, details) => { try { onError(error, details); } catch {} };
  const devLoading = Promise.resolve().then(loadDevTools).catch((error) => { if (!moduleMissing(error)) report(error, { phase: 'dev-tools' }); return null; });
  // The host's own pi-durable exports (ctx.pi); a failure leaves plugins without them.
  let pi;
  try { ({ pluginPi: pi } = await import('./plugin-pi.js')); }
  catch (error) { report(error, { phase: 'plugin-pi' }); }
  const runtime = createPluginRuntime({ onError: report, ...(pi ? { pi } : {}) });
  const browser = Boolean(globalThis.__piBrowser) || hostInfo?.platform === 'browser';
  // The app's own agent tools are ordinary essential built-ins (core-agent-plugins.js);
  // each session also has them as a bundled fallback, so composition never gates them.
  // N3/B1: Android keeps scope-owned route implementations. Browser composition attaches
  // the same owning page controllers used for bundled recovery, without creating a second node.
  const routes = { selection: runtime.selection, subscribe: (listener) => runtime.subscribe(listener), hostInfo, refresh: () => runtime.service('net.fetch', 1), ...browser ? { controllers: browserNetwork?.controllers } : {} };
  const options = { execution: { bridge, hostInfo, owner: executionOwner, ...browser ? { browserBackend: browserExecution, browserGit } : {} }, git: { service: browserGit?.service, hostInfo }, net: { bridge, browser, routes }, storage: { bridge, hostInfo }, parts: (id, version) => runtime.service(id, version), openExecution, agentTools: { hostInfo, selection: runtime.selection, subscribe: (listener) => runtime.subscribe(listener) }, providers: { hostInfo }, secrets: true };
  // Android build tools (C4): never in the browser; the plugin also checks the environment.
  if (!browser) options.toolchain = true;
  const dev = await devLoading;
  try { if (typeof dev?.createDevPlugins === 'function') options.extra = dev.createDevPlugins({ browser }); }
  catch (error) { report(error, { phase: 'dev-tools' }); }
  for (const definition of createBuiltinPlugins(options)) runtime.register(definition);
  let installed;
  try { installed = await loadInstalledPlugins({ runtime, bridge, hostInfo, adapters: pi ? { pi } : {}, onError: report }); }
  catch (error) { report(error, { phase: 'installed-inventory' }); }
  // Bind before setup: controllers already exist on the page and follow intent, never
  // currently-ready fallback resolution. Scope setup only attaches their services/views.
  if (browser) { browserNetwork?.bind(runtime); browserGit?.bind(runtime); }
  await runtime.start();
  try { agentExtensions?.connect(runtime, { installed: installed?.plugins ?? [] }); }
  catch (error) { report(error, { phase: 'agent-extensions' }); agentExtensions?.unavailable(error); }
  try { agentProviders?.connect(runtime); } catch (error) { report(error, { phase: 'agent-providers' }); agentProviders?.unavailable(error); }
  let styles;
  try { if (globalThis.document) styles = createPluginStyles({ runtime, installed: () => installed?.plugins ?? [], bundled: (id, href) => Boolean(builtinPlugin(id)?.manifest.styles?.some((entry) => entry.href === href)) && !runtime.selection.providers('look', 1).some((p) => p.id === id && !p.default), onError: (error, details) => report(error, details) }); }
  catch (error) { report(error, { phase: 'styles' }); }
  // A dev tools failure must not destroy the independently useful runtime.
  let devTools;
  try { devTools = await dev?.startDevTools?.({ runtime }); }
  catch (error) { report(error, { phase: 'dev-tools' }); }
  return { runtime, devTools, installed, styles };
}
