// core-agent: the page session lifecycle (docs/plugins.md §9a, docs/plugins-providers-agent-core.md).
// create({sessions, harness, lifecycle}) returns this plugin's definition parts. sessions is the
// page-owned agent.sessions@1 facade (agent-sessions.js), harness the agent.harness@1
// facade (without it only agent.sessions@1 is provided). Page-owned: stopping the plugin
// withdraws the services, never closes a session.
// Step C3d: lifecycle (the page controller, agent-sessions.js) is given when the facades are
// the page's; setup then opens the page's sessions through it (open-sessions.js). app.js uses
// this module's openSessions directly (the bundled copy) when composition is unavailable.
// X1: setup opens them with execution@1 (core-execution, optional "uses"); without it the
// page's bundled core-execution copy (sessionOptions.execution) opens the environment.
// X4: likewise net.fetch@1 (core-net-native) gives the sessions' fetch and workspace@1 (core-execution) their
// text workspace. Network lookup stays dynamic even when initially unavailable; only a separately
// invoked bundled opener uses sessionOptions.fetch when composition fails. Workspace keeps its
// sessionOptions.workspace fallback.
// X3: likewise storage@1 (core-storage) opens each session's conversation store, with the page's
// bundled copy (sessionOptions.storage) as fallback. X3b: parts (from the page's runtime, see
// plugin-builtins.js) gives the session engine the active conversations.engine@1 /
// servers.engine@1; without them the engine uses its bundled copies.
import { openSessions } from "./open-sessions.js";
export { openSessions };
const AGENT_SESSIONS_SERVICE = "agent.sessions";
const AGENT_HARNESS_SERVICE = "agent.harness";
const EXECUTION_SERVICE = "execution";

/**
 * E1: decides when the open page session no longer matches the selected execution@1 provider.
 * opened(env): the environment a session got (browser: env.shell.id; undefined before the
 * first open). check(): when the selected provider's shell (exec-js / exec-linux expose .shell;
 * Android's core-execution has none, so nothing ever switches there) differs from the open
 * session's, asks reopen("execution") once per check; true when it asked.
 */
export function executionSwitch({ execution, reopen }) {
  let openedShell;
  return Object.freeze({
    opened(env) { openedShell = env?.shell?.id ?? null; },
    check() {
      if (openedShell === undefined) return false;
      let wanted;
      try { wanted = execution()?.shell; } catch { return false; }
      if (typeof wanted !== "string" || wanted === openedShell) return false;
      try { void Promise.resolve(reopen("execution")).catch(() => {}); } catch { return false; }
      return true;
    }
  });
}

export function create({ sessions, harness, lifecycle, parts, subscribe }) {
  return {
    provides: [{ id: AGENT_SESSIONS_SERVICE, version: 1 }, ...harness ? [{ id: AGENT_HARNESS_SERVICE, version: 1 }] : []],
    setup(ctx) {
      ctx.provide(AGENT_SESSIONS_SERVICE, 1, sessions);
      if (harness) ctx.provide(AGENT_HARNESS_SERVICE, 1, harness);
      // Without session options the page opens its sessions itself (tests, forks).
      const find = (id) => () => { try { return ctx.get(id, 1); } catch { return null; } };
      // open-sessions.js keeps a stable per-request fetch even when initially unavailable.
      // Passing the getter (not its initial result) distinguishes a composed but unready
      // provider from the separately invoked bundled opener when composition failed.
      const net = find("net.fetch");
      if (!lifecycle?.sessionOptions) return;
      const execution = find(EXECUTION_SERVICE);
      const switcher = executionSwitch({ execution, reopen: (reason) => lifecycle.reopenWhenIdle?.(reason) });
      openSessions(lifecycle, "core-agent", execution, { net, workspace: find("workspace"), storage: find("storage"),
        opened: switcher.opened,
        ...parts ? { parts: (id, version) => ctx.signal.aborted ? null : parts(id, version) } : {} });
      // Switching the execution environment (Settings → Providers) reopens the page session in
      // place once no conversation is working: same save-close path as an app update, no page
      // reload. The new session gets the new environment, shell tool and prompt.
      if (typeof subscribe === "function" && typeof lifecycle.reopenWhenIdle === "function") {
        try { const off = subscribe(() => { if (!ctx.signal.aborted) switcher.check(); }); if (typeof off === "function") ctx.cleanup(off); } catch { /* no live switching */ }
      }
    }
  };
}

export { mountPreconnect } from './browser-preconnect.js';
