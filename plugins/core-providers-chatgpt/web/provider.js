// Built-in model provider row "chatgpt" (ChatGPT account sign-in).
// Static part from step P1a of docs/plugins-providers-agent-core.md. Session-bound part
// from step P1b: create(host) holds the account model list, the chatgptModel shape,
// requests rewritten to openai/api.openai.com/v1 and the configure checks (moved verbatim
// from session.js). The engine (session-providers.js) composes the pi-ai provider, waits
// for recovery before credential(), wraps the transport and installs it.
//
// Permanent: mode "chatgpt", provider id "openai-chatgpt", stored "" means the account
// default (docs §C).
// Pinned by P0, kept on purpose until a later step: the STATIC lookups (thinking efforts
// in Settings and in modelSettings normalization) use the bundled OpenAI catalog and
// read "" as gpt-4.1-mini, exactly like the openai row; account-only models have no
// thinking control there. The bundled pi-ai catalog is a static import, only read inside
// the functions below.
import { getSupportedThinkingLevels } from "../../../library/pi-ai.js";
import { OPENAI_MODELS } from "../../../library/pi-ai/providers/openai.models.js";

const STATIC_LOOKUP_DEFAULT = "gpt-4.1-mini";
const PROVIDER_ID = "openai-chatgpt";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const catalog = () => Object.values(OPENAI_MODELS);
const catalogModel = (modelId) => catalog().find((model) => model.id === (modelId || STATIC_LOOKUP_DEFAULT));
// An account model ({id, name}) as an openai-responses model of this provider, zero cost.
const chatgptModel = (selected) => {
  const known = Object.values(OPENAI_MODELS).find((candidate) => candidate.id === selected.id);
  return {
    ...known ?? { id: selected.id, api: "openai-responses", reasoning: false, input: ["text"], contextWindow: 128e3, maxTokens: 16384 },
    name: selected.name,
    provider: PROVIDER_ID,
    baseUrl: OPENAI_BASE_URL,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
};
// Requests go to the OpenAI Responses API as provider "openai".
const requestModel = (candidate) => ({ ...candidate, api: "openai-responses", provider: "openai", baseUrl: OPENAI_BASE_URL });

export const providerRow = Object.freeze({
  mode: "chatgpt",
  preconnectOrigins: Object.freeze(["https://api.openai.com"]),
  providerIds: Object.freeze([PROVIDER_ID]),
  label: "ChatGPT",            // #mode option text (index.html)
  requestLabel: "ChatGPT",     // error prefix and auth name (model-error.js whitelist)
  waitingLabel: "ChatGPT",
  auth: "account",
  order: 20,
  listed: true,
  defaultModelId: "",          // "" = the account's first model (resolved per send)
  // Last-known catalog: the bundled OpenAI models (the live list comes from the account).
  catalog,
  catalogModel,
  thinkingEfforts(modelId) {
    const model = catalogModel(modelId);
    return model?.reasoning ? getSupportedThinkingLevels(model) : [];
  },
  // No preference: the engine's generic choice (mini/nano/…, else the first model).
  fastModel: () => void 0,
  /** host: {credentials: {chatgpt}, ai: {streams: {openaiResponses}}}. */
  create(host) {
    const credentials = host.credentials;
    const { stream, streamSimple } = host.ai.streams.openaiResponses;
    return {
      subscribe: (listener) => credentials.chatgpt?.subscribe?.(listener),
      // Model requests (after recovery.wait): the account's access token.
      async credential(signal) {
        const token = await credentials.chatgpt.getAccessToken(signal);
        if (!token) throw new Error("Sign in to ChatGPT again to continue.");
        return { auth: { apiKey: token } };
      },
      // Live catalog: the account's models; needs a usable credential.
      async models(signal) {
        let token;
        try {
          token = await credentials.chatgpt?.getAccessToken(signal);
        } catch {
          token = void 0;
        }
        if (!token) throw new Error("Sign in to ChatGPT in Settings to use ChatGPT models.");
        return (await credentials.chatgpt.listModels()).map(chatgptModel);
      },
      // Saved work of an earlier session: the bundled OpenAI models plus the saved ids
      // the account listed then (unknown here, so they get the generic shape).
      savedModels(refs) {
        const list = Object.values(OPENAI_MODELS).map((item) => chatgptModel(item));
        for (const ref of refs) if (!list.some((item) => item.id === ref.modelId))
          list.push(chatgptModel({ id: ref.modelId, name: ref.modelId }));
        return list;
      },
      // One send: {model, list} for the chosen settings, or a user-facing reason.
      async choose(config) {
        if (!credentials.chatgpt) throw new Error("Sign in to ChatGPT before sending a message.");
        try {
          if (!await credentials.chatgpt.getAccessToken()) throw new Error("No credential");
        } catch {
          throw new Error("Sign in to ChatGPT again to continue.");
        }
        const available = await credentials.chatgpt.listModels();
        const selected = config.modelId?.trim() ? available.find((entry) => entry.id === config.modelId.trim()) : available[0];
        if (!selected) throw new Error("Choose a model available in your ChatGPT account.");
        return { model: chatgptModel(selected), list: available.map(chatgptModel) };
      },
      streams: {
        stream: (model, transcript, settings) => stream(requestModel(model), transcript, settings),
        streamSimple: (model, transcript, settings) => streamSimple(requestModel(model), transcript, settings)
      }
    };
  }
});
