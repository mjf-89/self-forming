// Built-in model provider row "openai" (OpenAI API key typed per send).
// Static part from step P1a of docs/plugins-providers-agent-core.md. Session-bound part
// from step P1b: create(host) holds the model checks and the Responses stream (moved
// verbatim from session.js). The key itself is the engine's: auth "transient-key" means
// session-providers.js keeps it in memory for this mode (never stored, cleared when the
// session goes idle and on close) and answers credential requests with it.
//
// Permanent: mode "openai", provider id "openai", stored "" means gpt-4.1-mini (docs §C).
// The bundled pi-ai catalog is a static import; it is only read inside the functions
// below, never while the row is declared.
import { getSupportedThinkingLevels } from "../../../library/pi-ai.js";
import { OPENAI_MODELS } from "../../../library/pi-ai/providers/openai.models.js";

const DEFAULT_MODEL_ID = "gpt-4.1-mini";
const FAST_MODEL_ID = "gpt-4.1-mini";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const catalog = () => Object.values(OPENAI_MODELS);
const catalogModel = (modelId) => catalog().find((model) => model.id === (modelId || DEFAULT_MODEL_ID));
const requestModel = (candidate) => ({ ...candidate, api: "openai-responses", provider: "openai", baseUrl: OPENAI_BASE_URL });

export const providerRow = Object.freeze({
  mode: "openai",
  preconnectOrigins: Object.freeze(["https://api.openai.com"]),
  providerIds: Object.freeze(["openai"]),
  label: "OpenAI API key",     // #mode option text (index.html)
  requestLabel: "OpenAI",      // error prefix and auth name (model-error.js whitelist)
  waitingLabel: "OpenAI API key",
  auth: "transient-key",
  order: 30,
  listed: true,
  defaultModelId: DEFAULT_MODEL_ID,
  catalog,
  catalogModel,
  thinkingEfforts(modelId) {
    const model = catalogModel(modelId);
    return model?.reasoning ? getSupportedThinkingLevels(model) : [];
  },
  fastModel: (list) => list.find((model) => model.id === FAST_MODEL_ID)?.id,
  /** host: {ai: {streams: {openaiResponses}}}. */
  create(host) {
    const { stream, streamSimple } = host.ai.streams.openaiResponses;
    return {
      // Live catalog: only while the session holds a key; the last installed list if any.
      async models(signal, { hasTransientKey, installed } = {}) {
        if (!hasTransientKey) throw new Error("OpenAI API-key models are only available while a reply that uses the key is running.");
        return installed ?? catalog();
      },
      // Saved work of an earlier session: the bundled catalog.
      savedModels: () => catalog(),
      // One send: {model, list, key}; the engine keeps `key` in memory for this mode.
      async choose(config) {
        const modelId = config.modelId?.trim() || DEFAULT_MODEL_ID;
        const known = catalog().find((candidate) => candidate.id === modelId);
        if (!known) throw new Error("This model is not in the bundled OpenAI catalog. Choose gpt-4.1-mini or another supported model.");
        if (!config.apiKey?.trim()) throw new Error("Enter your OpenAI API key to start.");
        return { model: known, list: catalog(), key: config.apiKey.trim() };
      },
      streams: {
        stream: (model, transcript, settings) => stream(requestModel(model), transcript, settings),
        streamSimple: (model, transcript, settings) => streamSimple(requestModel(model), transcript, settings)
      }
    };
  }
});
