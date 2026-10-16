// Agent tool for the endpoint list (no secrets): lets a conversation add, list, refresh
// and remove OpenAI-compatible endpoints until Settings has a panel for them (P4).
// API keys are deliberately NOT accepted here: a key typed into a chat would end up in
// the transcript. Keys are saved through the service openai-compatible.endpoints@1
// (setKey), which a Settings panel calls.
// PERMANENT: extension name "openai-compatible" (stored in per-conversation exclusions).
export const EXTENSION = "openai-compatible";
export const TOOL = "openai_compatible_endpoints";

export function createEndpointsExtension(pi, store) {
  const { defineExtension, defineTool, Type } = pi;
  return defineExtension({
    name: EXTENSION,
    tools: [defineTool({
      name: TOOL,
      description: [
        "Manage the OpenAI-compatible model endpoints of this app (llama-server, Ollama, vLLM, LM Studio, OpenRouter, ...).",
        "Actions: list; add {baseUrl, label?, models?, keyRequired?, contextWindow?, maxTokens?}; refresh {slug}; remove {slug}.",
        "baseUrl is the API root that has /chat/completions and /models, e.g. http://127.0.0.1:8080/v1 (llama-server) or http://127.0.0.1:11434/v1 (Ollama).",
        "Plain http works only for this phone (127.0.0.1/localhost); other hosts need https and are added to the app's network allow-list.",
        "Without models the list comes from GET <baseUrl>/models. Model ids for chats and subagents are openai-compatible/<slug>/<model>.",
        "Never ask for or pass API keys here: the user saves keys in Settings."
      ].join(" "),
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("refresh"), Type.Literal("remove")]),
        baseUrl: Type.Optional(Type.String({ description: "add: the API base URL, e.g. http://127.0.0.1:8080/v1" })),
        label: Type.Optional(Type.String({ description: "add: a short name, e.g. llama" })),
        slug: Type.Optional(Type.String({ description: "refresh/remove: the endpoint's slug from list" })),
        models: Type.Optional(Type.Array(Type.String(), { description: "add: model ids by hand (skips GET /models)" })),
        keyRequired: Type.Optional(Type.Boolean({ description: "add: the server needs an API key (default: true for https hosts, false for this phone)" })),
        contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
        maxTokens: Type.Optional(Type.Integer({ minimum: 1 }))
      }),
      replay: "unsafe",
      async execute(args, _api, context) {
        context?.abortSignal?.throwIfAborted?.();
        let result;
        switch (args.action) {
          case "list": result = await store.list(); break;
          case "add": result = await store.add({ baseUrl: args.baseUrl, label: args.label, models: args.models, keyRequired: args.keyRequired, contextWindow: args.contextWindow, maxTokens: args.maxTokens }); break;
          case "refresh": result = await store.refresh(args.slug, { signal: context?.abortSignal }); break;
          case "remove": result = await store.remove(args.slug); break;
          default: throw new Error(`Unknown action ${JSON.stringify(args.action)}`);
        }
        return { output: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    })]
  });
}
