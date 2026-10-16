// openai-compatible: a model provider for any OpenAI-compatible /v1/chat/completions
// server (llama-server, Ollama, vLLM, LM Studio, OpenRouter, ...). Step P5 of
// docs/plugins-providers-agent-core.md (decision §F.4). Web-only, reload "page".
//
// Contributes:
// - agent.providers "openai-compatible" (provider.js), streaming through a port of pi-ai's
//   openai-completions API (openai-completions.js, MIT, attribution there) built on the
//   host's own pi-ai exports (ctx.pi.ai); the plugin never bundles pi-ai;
// - the service openai-compatible.endpoints@1 (endpoints.js: list, add, update, remove,
//   refresh, setKey, clearKey, subscribe) for a Settings panel;
// - agent.extensions "openai-compatible": the endpoint tool (tool.js, no keys).
// Optional host lanes, feature-detected: ctx.credentials (plugin credential records,
// keys stored encrypted) and ctx.http ({fetch, allowList}); without them keys stay in
// memory for the page and remote https endpoints must be allow-listed by hand.
import { createOpenAICompletions, REQUIRED_AI } from "./openai-completions.js";
import { createEndpointStore } from "./endpoints.js";
import { createProviderRow, LABEL, MODE } from "./provider.js";
import { createEndpointsExtension } from "./tool.js";

export const SERVICE = "openai-compatible.endpoints";

function hostAi(pi) {
  const ai = pi?.ai;
  const missing = REQUIRED_AI.filter((name) => typeof ai?.[name] !== "function");
  if (missing.length) throw new Error(`This version of Self Forming does not give plugins the pi-ai functions the OpenAI-compatible provider needs (ctx.pi.ai: ${missing.join(", ")}).`);
  return ai;
}
function pageStorage() {
  try { return globalThis.localStorage ?? undefined; } catch { return undefined; }
}

export function setup(ctx) {
  const ai = hostAi(ctx.pi);
  const api = createOpenAICompletions(ai, { errorPrefix: () => `${LABEL} API error` });
  const store = createEndpointStore({ storage: pageStorage(), credentials: ctx.credentials, http: ctx.http });
  ctx.cleanup(() => store.close());
  ctx.provide(SERVICE, 1, Object.freeze({
    list: store.list, add: store.add, update: store.update, remove: store.remove, refresh: store.refresh,
    setKey: store.setKey, clearKey: store.clearKey, subscribe: store.subscribe
  }));
  ctx.contribute("agent.providers", MODE, createProviderRow({ store, api, ai }), 50);
  if (typeof ctx.pi.defineExtension === "function" && typeof ctx.pi.defineTool === "function" && ctx.pi.Type) {
    ctx.contribute("agent.extensions", "openai-compatible", createEndpointsExtension(ctx.pi, store));
  }
}
