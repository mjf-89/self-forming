// core-providers-offline: the built-in Offline model provider (docs/plugins-providers-agent-core.md
// P2). Essential built-in: it contributes its provider row (provider.js) as agent.providers,
// key = mode, consumed by agent-providers.js. provider.js (and with it pi-ai) is imported
// lazily in setup; nothing is imported from the library at evaluation. Every session also
// has the same row as its bundled fallback (session.js imports provider.js itself), so a
// failed, stopped or slow plugin never removes a provider.
export const provider = Object.freeze({ mode: "offline", order: 0, load: () => import("./provider.js") });
