// Ordinary definitions: built-ins have no privileged registration or last-wins
// path. Each one is a plugin folder (plugins/<id>/plugin.json + web/index.js) in the
// generated static registry builtin-plugins.js (scripts/gen-builtins.sh); definitionShell
// (builtin-definition.js) turns its manifest into the runtime definition. No host library or
// heavy view module is imported at module evaluation.
import { createCoreAgentPlugins } from "./core-agent-plugins.js";
import { pageAgentHarness, pageAgentLifecycle, pageAgentSessions } from "./agent-sessions.js";
import { pageChatHost } from "./chat-host.js";
import { AGENT_PROVIDERS } from "./agent-providers.js";
import { CORE_PROVIDER_ROWS } from "./core-providers.js";
import { SETTINGS_SECTIONS } from "./settings-sections.js";
import { builtinPlugin } from "./builtin-plugins.js";
import { definitionShell } from "./builtin-definition.js";
import { STYLES } from "./plugin-styles.js";
export const EXECUTION_SERVICE = "execution";
export const AGENT_SESSIONS_SERVICE = "agent.sessions";
export const AGENT_HARNESS_SERVICE = "agent.harness";
// T2/N1: the looks: ordinary built-ins that provide look@1 and contribute styles. ALL looks present in the registry are
// registered, in this order (lowest priority first); an edition leaves one out by leaving its folder out of the tree.
// The DEFAULT look is the last one present (look-private in the private tree, look-public alone in the public export): the
// runtime's ordinary `default: true` of provides is set here, not in the manifests, so the export edits nothing. The user's
// choice is the generic provider selection (Settings → Providers). scripts/gen-builtins.sh keeps the same list (a test compares).
export const STYLE_ONLY_PLUGINS = Object.freeze(["look-public", "look-private"]);

/**
 * T2: a built-in's manifest lists its stylesheets ("styles": [{href, order?}], relative to the plugin's web folder);
 * its definition contributes them as `styles` (plugin-styles.js) before its own setup runs. The same files are linked
 * statically by the generated builtin-styles.css, so the page looks right before and without composition.
 */
export function withManifestStyles(definition) {
  const styles = builtinPlugin(definition.id)?.manifest.styles;
  if (!Array.isArray(styles) || styles.length === 0) return definition;
  const setup = definition.setup;
  return {
    ...definition,
    setup(ctx) {
      for (const { href, order = 0 } of styles) ctx.contribute(STYLES, `${definition.id}/${href}`, { href }, order);
      return typeof setup === "function" ? setup.call(definition, ctx) : undefined;
    }
  };
}

/**
 * execution: {bridge, hostInfo, owner} for core-execution (step X1), which provides the real
 * execution@1: open(cwd?, {owner}?) opens its own ExecutionEnv (plugins/core-execution/web/
 * execution-env.js) over that bridge, owner defaulting to the page's execution owner.
 * openExecution(...args): optional replacement opener (tests, forks). The returned
 * environment keeps the local exec/read/write/stream and cleanup APIs. The caller still owns
 * environment lifetime; no implicit cleanup kills running processes or a durable session on
 * hide/background.
 *
 * net: {bridge} for core-net-native (step X4; the provider selector is core-plugin-management's Settings → Providers), plus core-net-page (N2); both provide net.fetch@1, core-net-native is the default: a fetch (native HTTPS over the
 * page's bridge) with describe() and createFetch(host). Omitted: no core-net-native (sessions use the page's bundled copy).
 * execution also gives core-execution's workspace@1 (text workspace over the same bridge).
 *
 * net.routes (N3): {selection, subscribe, refresh, hostInfo} adds the optional route providers net-tor and net-tailscale (bundle
 * self-forming-net): more providers of net.fetch@1 over libs/cors-rot (Tor/Snowflake; the user's Tailscale exit node). Lazy: they
 * start nothing until the user selects them (they follow selection/subscribe); refresh() re-reads the selector status when their
 * availability changes. Omitted (tests/forks): no route providers. B1 browser routes receive page-lived owning controllers;
 * net.browser omits core-net-native and makes net-tailscale the sole default (page fetch stays explicit).
 *
 * storage: {bridge, hostInfo} for core-storage (step X3), which provides storage@1: open({env, name}?)
 * opens the conversation store (SQLite database "self-forming" over the bridge; JSONL in the browser
 * edition). Omitted: no core-storage (sessions use the page's bundled copy).
 *
 * parts: (id, version) → the runtime's active service or null (plugin-bootstrap.js, runtime.service),
 * given to core-agent for the session engine's parts (X3b): conversations.engine@1
 * (core-conversations) and servers.engine@1 (core-servers). Read without a declared "uses" because
 * core-conversations requires agent.sessions@1 (a declared use would be a cycle, which the runtime
 * blocks); only these ids are answered. Omitted: the engine uses its bundled copies.
 *
 * extra: further built-in definitions (an optional bundle such as the dev tools that
 * plugin-bootstrap.js loads when present), placed right after core-execution.
 *
 * agentTools: {hostInfo} adds the essential core agent plugins (core-prompt, the
 * prompt sections; core-workspace-tools, core-tools, core-self-update,
 * core-plugin-management, the tools; see core-agent-plugins.js). Each one is
 * registered blocked with a reason when its host capability (hostInfo.capabilities)
 * is missing. Omitted: no agent plugins.
 *
 * sessions: the page-owned agent.sessions@1 facade (agent-sessions.js). core-agent
 * (essential, reload "page") provides it as is; the facade is created by app.js before
 * composition starts, so the chat never waits for this plugin. Defaults to the facade the
 * page registered (setPageAgentSessions); without one (tests, forks) core-agent is left out.
 *
 * harness: the page-owned agent.harness@1 facade (agent-sessions.js controller.harness,
 * step C2), also provided by core-agent. Defaults to the registered page controller's
 * facade when sessions is the registered page facade; otherwise only agent.sessions@1.
 *
 * lifecycle: the page controller whose sessions core-agent's setup opens (step C3d).
 * Defaults to the registered controller when sessions is the registered page facade.
 *
 * providers: {hostInfo} adds the essential model provider plugins core-providers-offline,
 * -claude, -chatgpt and -openai (createCoreProviderPlugins), after core-agent and before
 * the agent tool rows. Omitted: no provider plugins (sessions use their bundled rows).
 *
 * secrets: truthy adds the essential core-secrets plugin (S1b), right after the providers:
 * it contributes the Settings → Secrets screen as settings.sections (slot "secrets").
 * Omitted: no core-secrets (app.js still shows its bundled copy).
 *
 * chat: the page's chat host (chat-host.js, step C7). With sessions it adds the essential
 * core-chat right after core-agent: it requires agent.sessions@1 and mounts the chat in its
 * setup. Defaults to the host the page registered (setPageChatHost); without one (tests,
 * forks) core-chat is left out and nothing mounts a chat. With the same host (a page with the
 * chat screen) it also adds the essential core-conversations (C7b), the drawer on
 * agent.sessions@1.
 *
 * toolchain: truthy adds the built-in core-toolchain (C4, not essential: Self Forming only,
 * a fork leaves the folder out) when the registry has it: it provides toolchain@1 and starts
 * the Android build tools install from agent.harness@1 onSession. Omitted (the browser
 * edition): nothing; app.js then shows no toolchain note.
 */
export function createBuiltinPlugins({ execution, git, net, storage, parts, openExecution, version = "1.0.0", agentTools, providers, secrets, toolchain, sessions = pageAgentSessions(), harness = sessions && sessions === pageAgentSessions() ? pageAgentHarness() : undefined, lifecycle = sessions && sessions === pageAgentSessions() ? pageAgentLifecycle() : undefined, chat = pageChatHost(), extra = [] } = {}) {
  if (openExecution !== void 0 && typeof openExecution !== "function") throw new TypeError("openExecution must be a function");
  if (!Array.isArray(extra)) throw new TypeError("extra must be an array of definitions");
  // E1: in the browser edition execution@1 has two providers, exec-linux (default when the page
  // offers its Linux) and exec-js, chosen in Settings → Providers; core-execution keeps
  // workspace@1 and the shared page VFS backend. Android (and an explicit openExecution) keep
  // core-execution's own execution@1.
  const browserExecution = Boolean(execution && !openExecution && (execution.browserBackend || execution.hostInfo?.platform === "browser")
    && builtinPlugin("exec-js") && builtinPlugin("exec-linux"));
  const definitions = [{ ...definitionShell("core-execution", { version, ...browserExecution ? { provides: [{ id: "workspace", version: 1 }] } : {} }),
    ...builtinPlugin("core-execution").entry.create({ ...execution, openExecution, providesExecution: !browserExecution }) },
    ...extra, ...browserExecution ? executionProviders(execution, version) : []];
  if (git && builtinPlugin("core-git")) definitions.push({ ...definitionShell("core-git", { version }), ...builtinPlugin("core-git").entry.create(git) });
  // X4: core-net-native provides net.fetch@1 (native fetch) over the page's bridge; registered with the
  // execution adapter (after any extra bundle) so the services exist before core-agent opens its sessions.
  if (net && !net.browser && builtinPlugin("core-net-native")) definitions.splice(1 + extra.length, 0, { ...definitionShell("core-net-native", { version }), ...builtinPlugin("core-net-native").entry.create(net) });
  // N2: core-net-page is a second provider of net.fetch@1 (chosen in Settings → Providers); registered next to core-net-native.
  if (net && builtinPlugin("core-net-page")) definitions.splice(1 + extra.length + (!net.browser && builtinPlugin("core-net-native") ? 1 : 0), 0, { ...definitionShell("core-net-page", { version }), ...builtinPlugin("core-net-page").entry.create() });
  // N3/B1: route implementations are plugin-owned. Browser definitions attach the page
  // controllers and choose Tailscale as default; Android keeps Native as its default.
  if (net?.routes && builtinPlugin("net-tor") && builtinPlugin("net-tailscale")) {
    const routes = { ...net.routes, bridge: net.bridge };
    definitions.push({ ...definitionShell("net-tor", { version }), ...builtinPlugin("net-tor").entry.create({ ...routes, controller: routes.controllers?.["net-tor"] }) },
      { ...definitionShell("net-tailscale", { version, ...net.browser ? { provides: [{ id: "net.fetch", version: 1, default: true }] } : {} }), ...builtinPlugin("net-tailscale").entry.create({ ...routes, controller: routes.controllers?.["net-tailscale"] }) });
  }
  // X3: core-storage provides storage@1 (the conversation store), likewise before core-agent.
  if (storage && builtinPlugin("core-storage")) definitions.splice(1 + extra.length + (net && !net.browser && builtinPlugin("core-net-native") ? 1 : 0) + (net && builtinPlugin("core-net-page") ? 1 : 0), 0, { ...definitionShell("core-storage", { version }), ...builtinPlugin("core-storage").entry.create(storage) });
  if (sessions) {
    if (typeof sessions.current !== "function" || typeof sessions.onSession !== "function" || typeof sessions.subscribe !== "function") throw new TypeError("sessions must be the agent.sessions@1 facade");
    if (harness && (typeof harness.current !== "function" || typeof harness.onSession !== "function")) throw new TypeError("harness must be the agent.harness@1 facade");
    // Page-owned: stopping the plugin withdraws the services, never closes a session.
    definitions.push({ ...definitionShell("core-agent", { version }), ...builtinPlugin("core-agent").entry.create({ sessions, harness, lifecycle, parts: engineParts(parts), subscribe: agentTools?.subscribe }) });
    // C7: the chat on agent.sessions@1 (page-owned: stopping it never unmounts the chat).
    if (chat && builtinPlugin("core-chat")) definitions.push({ ...definitionShell("core-chat", { version }), ...builtinPlugin("core-chat").entry.create({ page: chat }) });
    if (chat && builtinPlugin("core-conversations")) definitions.push({ ...definitionShell("core-conversations", { version }), ...builtinPlugin("core-conversations").entry.create() });
  }
  if (providers) definitions.push(...createCoreProviderPlugins({ ...providers, version }));
  if (secrets) definitions.push({ ...definitionShell("core-secrets", { version }), ...builtinPlugin("core-secrets").entry.create() });
  if (toolchain && builtinPlugin("core-toolchain")) definitions.push({ ...definitionShell("core-toolchain", { version }), ...builtinPlugin("core-toolchain").entry.create() });
  // Every look present is registered (providers of look@1); the last one present is the default. Only the default's sheet is
  // in the bundled builtin-styles.css; the others are linked by plugin-styles.js while selected.
  // Registered before the core agent rows, which stay last (A2/A4/A5 order); style order comes from the manifests.
  const looks = STYLE_ONLY_PLUGINS.filter((id) => builtinPlugin(id));
  for (const look of looks) {
    const provides = look === looks[looks.length - 1] ? [{ id: "look", version: 1, default: true }] : undefined;
    definitions.push({ ...definitionShell(look, { version, provides }), ...builtinPlugin(look).entry.create() });
  }
  if (agentTools) definitions.push(...createCoreAgentPlugins({ ...agentTools, version }));
  return definitions.map(withManifestStyles);
}

/** E1: the browser's execution@1 providers; Linux is the default when the page offers it. */
function executionProviders(execution, version) {
  const createExecution = builtinPlugin("core-execution").entry.createExecution;
  const linuxDefault = builtinPlugin("exec-linux").entry.offered(execution.hostInfo);
  return ["exec-linux", "exec-js"].map((id) => {
    const isDefault = id === "exec-linux" ? linuxDefault : !linuxDefault;
    return { ...definitionShell(id, { version, provides: [{ id: EXECUTION_SERVICE, version: 1, ...isDefault ? { default: true } : {} }] }),
      ...builtinPlugin(id).entry.create({ ...execution, createExecution }) };
  });
}

// X3b: the session engine parts the page may look up in the runtime (see createBuiltinPlugins parts).
export const ENGINE_PART_SERVICES = Object.freeze(["conversations.engine", "servers.engine"]);
function engineParts(parts) {
  if (typeof parts !== "function") return undefined;
  return (id, version = 1) => {
    if (!ENGINE_PART_SERVICES.includes(id)) return null;
    try { return parts(id, version) ?? null; } catch { return null; }
  };
}

/**
 * The built-in model providers as essential plugins (step P2 of
 * docs/plugins-providers-agent-core.md): each contributes its provider row
 * (plugins/core-providers-<mode>/web/provider.js) as agent.providers, key = mode, consumed by
 * agent-providers.js. The row module (and with it pi-ai) is imported lazily in setup;
 * nothing is imported from the library at evaluation. A fork leaves a provider out with
 * omit(hostInfo) on its CORE_PROVIDER_ROWS entry. Every session also has the same rows
 * as its bundled fallback, so a failed, stopped or slow plugin never removes a provider.
 * Rows with a `section` (S1a) also contribute their Settings panel as settings.sections,
 * key provider-<mode>, in the provider slot (provider-panels.js).
 */
export function createCoreProviderPlugins({ hostInfo, version = "1.0.0", rows = CORE_PROVIDER_ROWS } = {}) {
  return rows.filter((entry) => !entry.omit?.(hostInfo)).map((entry) => ({
    ...definitionShell(entry.id, { version, provides: [], fallback: { essential: true } }),
    async setup(ctx) {
      // S1a: the provider's Settings panel (plugins/<id>/web/settings-panel.js), before the
      // lazy row load so a failed load never takes the panel along (app.js has the bundled copy).
      if (entry.section) ctx.contribute(SETTINGS_SECTIONS, `provider-${entry.mode}`, entry.section, entry.order);
      const { providerRow } = await entry.load();
      if (ctx.signal.aborted) return;
      ctx.contribute(AGENT_PROVIDERS, entry.mode, providerRow, entry.order);
    }
  }));
}
