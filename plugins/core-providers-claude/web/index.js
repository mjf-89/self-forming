// core-providers-claude: the built-in Claude model provider (docs/plugins-providers-agent-core.md
// P2). Essential built-in: it contributes its provider row (provider.js) as agent.providers,
// key = mode, consumed by agent-providers.js. provider.js (and with it pi-ai) is imported
// lazily in setup; nothing is imported from the library at evaluation. Every session also
// has the same row as its bundled fallback (session.js imports provider.js itself), so a
// failed, stopped or slow plugin never removes a provider.
// S1a: its Settings panel (settings-panel.js, DOM only) is contributed as settings.sections in
// the provider slot; app.js mounts the same nodes as the bundled fallback.
import { section } from "./settings-panel.js";
export const provider = Object.freeze({ mode: "claude", preconnectOrigins: Object.freeze(["https://api.anthropic.com"]), order: 10, load: () => import("./provider.js"), section });

// X4: Claude sign-in lives in claude-auth.js (packages/native-host/src/claude-auth.ts hand-ported).
// The page's credential controller (app.js) is created with loadClaudeAuth(): claude-auth.js is
// imported lazily and, only if it cannot be loaded, the old createClaudeAuth export of the fixed
// native-host.js is used (last resort). Same bridge methods (auth.* with provider "claude").
export function loadClaudeAuth({ load = () => import("./claude-auth.js"), fallback = () => import("../../../native-host.js") } = {}) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.createClaudeAuth !== "function") throw new TypeError("claude-auth.js has no createClaudeAuth");
    return module.createClaudeAuth;
  }).catch(async (cause) => {
    console.error("core-providers-claude sign-in unavailable: using native-host.js", cause);
    return (await fallback()).createClaudeAuth;
  });
}
