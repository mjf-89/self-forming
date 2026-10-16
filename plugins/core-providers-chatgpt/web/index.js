// core-providers-chatgpt: the built-in ChatGPT model provider (docs/plugins-providers-agent-core.md
// P2). Essential built-in: it contributes its provider row (provider.js) as agent.providers,
// key = mode, consumed by agent-providers.js. provider.js (and with it pi-ai) is imported
// lazily in setup; nothing is imported from the library at evaluation. Every session also
// has the same row as its bundled fallback (session.js imports provider.js itself), so a
// failed, stopped or slow plugin never removes a provider.
// S1a: its Settings panel (settings-panel.js, DOM only) is contributed as settings.sections in
// the provider slot; app.js mounts the same nodes as the bundled fallback.
import { section } from "./settings-panel.js";
export const provider = Object.freeze({ mode: "chatgpt", preconnectOrigins: Object.freeze(["https://api.openai.com"]), order: 20, load: () => import("./provider.js"), section });

// X4b: ChatGPT sign-in lives in chatgpt-auth.js (packages/native-host/src/auth.ts hand-ported; the
// ID-token check uses the vendored official jose build in lib/jose/). The page's credential
// controller (app.js) is created with loadChatGPTAuth(): chatgpt-auth.js is imported lazily and,
// only if it cannot be loaded, the old createChatGPTAuth export of the fixed native-host.js is
// used (last resort). Same bridge methods (auth.* for ChatGPT) and stored record.
export function loadChatGPTAuth({ load = () => import("./chatgpt-auth.js"), fallback = () => import("../../../native-host.js") } = {}) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.createChatGPTAuth !== "function") throw new TypeError("chatgpt-auth.js has no createChatGPTAuth");
    return module.createChatGPTAuth;
  }).catch(async (cause) => {
    console.error("core-providers-chatgpt sign-in unavailable: using native-host.js", cause);
    return (await fallback()).createChatGPTAuth;
  });
}
