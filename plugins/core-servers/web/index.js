// core-servers: supervised background servers (docs/plugins.md §9a A4, §9c C2). Essential
// built-in agent row (order 40) contributing the whole
// permanent extension "self-forming-servers" (tool manage_server, durable task kind
// self-forming.server v2, doc kind self-forming.servers: servers.js in this folder, moved verbatim in X2)
// and PROVIDING servers@1 (servers-service.js), a facade over the same manage() the tool
// runs. Its session-bound create(host) takes the session's server binding (host.servers,
// given by session.js only where supervised servers work: a native execution environment,
// or in the browser edition an execution environment while the page offers Linux, linuxShell),
// so the bundled and the runtime copy install the same task definition. Browser edition:
// available only when the host reports linuxShell; the session's execution environment must
// be the Linux one (execution@1 exec-linux, env.shell bash): with the JavaScript environment
// every servers operation fails clearly (servers.js browserServersEnv). Servers live only as long
// as the tab (servers@1 status: persistent false, lifetime "tab"). Consumed by core-agent-plugins.js.
// X3b: also provides servers.engine@1 = {load() → {createServerSession}} (servers-service.js), the
// session binding the engine builds per session; the engine takes it from here while the plugin is
// active and uses its bundled static copy otherwise.
import { createServerSession, createServersService, SERVERS_SERVICE, SERVERS_SERVICE_VERSION } from "./servers-service.js";
export const SERVERS_ENGINE_SERVICE = "servers.engine";
const SERVERS_ENGINE = Object.freeze({ load: async () => Object.freeze({ createServerSession }) });

// Equals servers.js SERVER_TASK_KIND (permanent; declared statically, no library import).
export const SERVER_TASK_KIND = "self-forming.server";
const NO_SERVERS_ENV = "Supervised servers need the Linux environment of the Android app; this host has no execution environment.";
const BROWSER_NO_LINUX = "Supervised servers in the browser edition need its in-page Linux (linuxShell); this host does not report it.";
/** Browser edition: servers run in the tab's Linux VM, selected explicitly per command; nothing outlives the tab. */
export const browserServers = (caps, hostInfo) => hostInfo?.platform === "browser" && caps?.executionEnv === true && caps?.linuxShell === true;

export const row = Object.freeze({
  extension: "self-forming-servers", order: 40,
  // An execution environment; in the browser edition also its in-page Linux (linuxShell; the session must use it).
  // On the session side the session decides (host.servers).
  unavailable: (caps, hostInfo, host) => !caps.executionEnv ? NO_SERVERS_ENV
    : hostInfo?.platform === "browser" && !browserServers(caps, hostInfo) ? BROWSER_NO_LINUX
    : host && !host.servers ? "This session has no supervised server support." : undefined,
  tools: () => ["manage_server"],
  tasks: () => [SERVER_TASK_KIND],
  // Android: tmux runs outside the WebView, servers survive page reloads and app restarts.
  // Browser: tmux runs in the tab's VM, servers end with the tab (restarted when the app opens again).
  serve: (ctx, _builders, { hostInfo } = {}) => {
    ctx.provide(SERVERS_SERVICE, SERVERS_SERVICE_VERSION, createServersService(hostInfo?.platform === "browser" ? { persistent: false, lifetime: "tab" } : { persistent: true }));
    ctx.provide(SERVERS_ENGINE_SERVICE, 1, SERVERS_ENGINE);
  },
  load: () => import("./servers.js"),
  create: (_builders, host) => host.servers ? host.servers.part() : null
});
