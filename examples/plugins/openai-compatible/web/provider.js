// The agent.providers row of the openai-compatible plugin (shape: apps/common/agent-providers.js
// and core-provider-<mode>.js; docs/plugins-providers-agent-core.md §B1).
//
// PERMANENT (stored in chats and saved work): mode "openai-compatible", provider id
// "openai-compatible", model ids "<endpoint slug>/<server model id>".
// auth "none": the engine asks credential() for every request; it answers {auth: {}}
// because one provider id serves several endpoints and credential() does not know the
// model. Each endpoint's optional key is resolved by the stream itself (resolveApiKey)
// and only ever goes into that request's Authorization header.
// Transport per endpoint: loopback → page fetch (settings.pageFetch when the engine
// gives one, else globalThis.fetch with this plugin's own bounded, redacted error
// body); anything else → settings.fetch, the session's host transport already wrapped
// by the engine (safeModelErrorResponse), i.e. the native fetch on Android.
import { NO_ENDPOINT, PROVIDER_ID } from "./endpoints.js";

export const MODE = "openai-compatible";
export const LABEL = "OpenAI-compatible";
const MAX_ERROR_BYTES = 32 * 1024;

function redact(value, secrets) {
  let result = String(value);
  for (const secret of secrets) if (secret && secret.length >= 4) result = result.split(secret).join("[redacted]");
  return result
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/** Like the host's safeModelErrorResponse, for page-fetch requests the engine did not wrap. */
export async function safePageResponse(response, init, label = LABEL) {
  if (response.ok) return response;
  const secrets = [];
  try {
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization) secrets.push(authorization, authorization.replace(/^\S+\s+/, ""));
  } catch { /* no headers */ }
  let error;
  try {
    const length = Number(response.headers.get("content-length"));
    if (response.body && !(length > MAX_ERROR_BYTES)) {
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ERROR_BYTES) { void reader.cancel().catch(() => {}); chunks.length = 0; break; }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
      const body = JSON.parse(text);
      error = body?.error && typeof body.error === "object" ? body.error : typeof body?.error === "string" ? { message: body.error } : undefined;
    }
  } catch { error = undefined; }
  const fields = {};
  for (const [name, limit] of [["message", 8192], ["type", 128], ["code", 128]]) {
    const value = error?.[name];
    if ((typeof value === "string" || typeof value === "number") && String(value).length <= limit) {
      const safe = redact(value, secrets);
      if (safe) fields[name] = safe;
    }
  }
  const prefix = `${label} request failed (${response.status}).`;
  const kind = [...new Set([fields.type, fields.code].filter(Boolean))].join("; ");
  const reason = [fields.message, kind ? `(${kind})` : ""].filter(Boolean).join(" ");
  const chars = Array.from(reason ? `${prefix} ${reason}` : `${prefix} Check the server, the model name and the API key.`);
  const safeMessage = chars.length > 500 ? chars.slice(0, 499).join("") + "\u2026" : chars.join("");
  return new Response(JSON.stringify({ error: { ...fields, message: safeMessage } }), { status: response.status, headers: { "content-type": "application/json" } });
}

/** createProviderRow({store, api, ai}) → the agent.providers contribution value. */
export function createProviderRow({ store, api, ai }) {
  const catalogModel = (modelId) => modelId ? store.modelFor(modelId) : store.catalog()[0];
  // A stream that fails at once with a user-facing reason (no request is made).
  function failed(model, text) {
    const stream = ai.createAssistantMessageEventStream();
    const output = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage: text, timestamp: Date.now()
    };
    queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: output }); stream.end(); });
    return stream;
  }
  function transportFor(endpoint, settings) {
    const base = endpoint.transport === "page"
      ? settings.pageFetch ?? (async (input, init) => safePageResponse(await globalThis.fetch(input, init), init))
      : settings.fetch;
    if (typeof base !== "function") return undefined;
    return async (input, init) => {
      try {
        return await base(input, init);
      } catch (error) {
        if (error?.name === "AbortError" || init?.signal?.aborted) throw error;
        const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 200)})` : "";
        throw new Error(endpoint.transport === "page"
          ? `Could not reach ${endpoint.label} at ${endpoint.baseUrl}${detail}. Check that the server is running and accepts requests from the app (CORS).`
          : `Could not reach ${endpoint.label} at ${endpoint.baseUrl}${detail}. Check the address and that it is in the app's network allow-list.`);
      }
    };
  }
  function run(method, model, transcript, settings = {}) {
    const parts = store.split(model.id);
    if (!parts?.endpoint) return failed(model, `The OpenAI-compatible endpoint "${parts?.slug ?? model.id}" is not configured any more. Add it again or choose another model.`);
    const current = store.modelFor(model.id);
    const fetch = transportFor(parts.endpoint, settings);
    if (!fetch) return failed(model, `${parts.endpoint.label} cannot be reached: this session has no network transport.`);
    const { pageFetch: _page, apiKey: _key, ...rest } = settings;
    return api[method](current, transcript, { ...rest, fetch, resolveApiKey: () => store.requestKey(parts.endpoint) });
  }

  return Object.freeze({
    mode: MODE,
    providerIds: Object.freeze([PROVIDER_ID]),
    label: LABEL,
    requestLabel: LABEL,
    waitingLabel: LABEL,
    auth: "none",
    order: 50,
    listed: true,
    defaultModelId: "", // "" = the first model of the first endpoint
    transport: "page",  // loopback endpoints; remote ones use the host transport (see above)
    catalog: () => store.catalog(),
    catalogModel,
    thinkingEfforts: () => [],
    fastModel: () => undefined,
    create(host) {
      try { store.useSessionFetch(host?.transport?.()); } catch { /* discovery of remote endpoints waits for a transport */ }
      const models = (signal) => store.liveModels(signal);
      return {
        status: () => ({ ready: store.endpoints().length > 0, signedIn: store.endpoints().length > 0, ...(store.endpoints().length ? {} : { message: NO_ENDPOINT }) }),
        // Config changes (endpoint added, models refreshed, key saved) release saved work.
        subscribe: (listener) => store.subscribe(() => listener({ signedIn: store.endpoints().length > 0 })),
        credential: async () => ({ auth: {} }),
        models,
        // Saved work: the stored model ids, as the current config describes them (an id
        // whose endpoint was removed still gets a model, so its request fails with a reason).
        savedModels: (refs) => refs.map((ref) => store.modelFor(ref.modelId) ?? {
          id: ref.modelId, requestModelId: ref.modelId, name: ref.modelId, api: "openai-completions", provider: PROVIDER_ID,
          baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096
        }),
        // One send: {model, list}, or a user-facing reason.
        async choose(config = {}, signal) {
          if (!store.endpoints().length) throw new Error(NO_ENDPOINT);
          let list;
          let failure;
          try { list = await models(signal); } catch (error) { failure = error; list = store.catalog(); }
          const modelId = config.modelId?.trim() || list[0]?.id;
          if (!modelId) throw failure ?? new Error(NO_ENDPOINT);
          const parts = store.split(modelId);
          if (!parts?.endpoint) throw new Error(`The OpenAI-compatible endpoint "${parts?.slug ?? modelId}" is not configured. Add it again or choose another model.`);
          await store.requestKey(parts.endpoint);
          const model = list.find((candidate) => candidate.id === modelId);
          if (!model) {
            if (!parts.endpoint.models && store.lastError(parts.endpoint.slug)) throw new Error(store.lastError(parts.endpoint.slug));
            if (failure && !parts.endpoint.models) throw failure;
            throw new Error(`${parts.remoteId} is not offered by ${parts.endpoint.label}. Refresh its model list or choose another model.`);
          }
          return { model, list };
        },
        streams: {
          stream: (model, transcript, settings) => run("stream", model, transcript, settings),
          streamSimple: (model, transcript, settings) => run("streamSimple", model, transcript, settings)
        }
      };
    }
  });
}
