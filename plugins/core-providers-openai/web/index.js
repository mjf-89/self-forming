// core-providers-openai: the built-in OpenAI model provider (docs/plugins-providers-agent-core.md
// P2). Essential built-in: it contributes its provider row (provider.js) as agent.providers,
// key = mode, consumed by agent-providers.js. provider.js (and with it pi-ai) is imported
// lazily in setup; nothing is imported from the library at evaluation. Every session also
// has the same row as its bundled fallback (session.js imports provider.js itself), so a
// failed, stopped or slow plugin never removes a provider.
// S1a: its Settings panel (settings-panel.js, DOM only) is contributed as settings.sections in
// the provider slot; app.js mounts the same nodes as the bundled fallback.
import { section } from "./settings-panel.js";
export const provider = Object.freeze({ mode: "openai", preconnectOrigins: Object.freeze(["https://api.openai.com"]), order: 30, load: () => import("./provider.js"), section });
