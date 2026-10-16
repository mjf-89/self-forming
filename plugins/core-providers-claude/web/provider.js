// Built-in model provider row "claude" (Claude account sign-in).
// Static part from step P1a of docs/plugins-providers-agent-core.md. Session-bound part
// from step P1b: create(host) holds the account checks, the live and saved model lists,
// the configure checks and the Anthropic Messages stream (moved verbatim from
// session.js). The engine (session-providers.js) composes the pi-ai provider, waits for
// recovery before credential(), wraps the transport and installs it.
//
// Permanent: mode "claude", provider id "anthropic", stored "" means claude-sonnet-4-6
// (docs §C). The bundled pi-ai catalog is a static import; it is only read inside the
// functions below, never while the row is declared.
import { getSupportedThinkingLevels } from "../../../library/pi-ai.js";
import { ANTHROPIC_MODELS } from "../../../library/pi-ai/providers/anthropic.models.js";

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const FAST_MODEL_ID = "claude-haiku-4-5";
const catalog = () => Object.values(ANTHROPIC_MODELS);
const catalogModel = (modelId) => catalog().find((model) => model.id === (modelId || DEFAULT_MODEL_ID));

export const providerRow = Object.freeze({
  mode: "claude",
  preconnectOrigins: Object.freeze(["https://api.anthropic.com"]),
  providerIds: Object.freeze(["anthropic"]),
  label: "Claude Code",        // #mode option text (index.html)
  requestLabel: "Claude",      // error prefix and auth name (model-error.js whitelist)
  waitingLabel: "Claude Code",
  auth: "account",
  order: 10,
  listed: true,
  defaultModelId: DEFAULT_MODEL_ID,
  catalog,
  catalogModel,
  thinkingEfforts(modelId) {
    const model = catalogModel(modelId);
    return model?.reasoning ? getSupportedThinkingLevels(model) : [];
  },
  fastModel: (list) => list.find((model) => model.id === FAST_MODEL_ID)?.id,
  /** host: {credentials: {claude}, ai: {streams: {anthropicMessages}}}. */
  create(host) {
    const credentials = host.credentials;
    const { stream, streamSimple } = host.ai.streams.anthropicMessages;
    return {
      subscribe: (listener) => credentials.claude?.subscribe?.(listener),
      // Model requests (after recovery.wait): the account's access token.
      async credential(signal) {
        const token = await credentials.claude.getAccessToken(signal);
        if (!token) throw new Error("Sign in to Claude again to continue.");
        return { auth: { apiKey: token } };
      },
      // Live catalog: needs a usable credential.
      async models(signal) {
        let token;
        try {
          token = await credentials.claude?.getAccessToken(signal);
        } catch {
          token = void 0;
        }
        if (!token) throw new Error("Sign in to Claude in Settings to use Claude models.");
        return catalog();
      },
      // Saved work of an earlier session: the bundled catalog.
      savedModels: () => catalog(),
      // One send: {model, list} for the chosen settings, or a user-facing reason.
      async choose(config) {
        const model = catalogModel(config.modelId);
        if (!model) throw new Error("Choose a Claude model from the bundled catalog.");
        try {
          if (!await credentials.claude?.getAccessToken()) throw new Error("No credential");
        } catch {
          throw new Error("Sign in to Claude again to continue.");
        }
        return { model, list: catalog() };
      },
      streams: {
        stream: (model, transcript, settings) => stream(model, transcript, settings),
        streamSimple: (model, transcript, settings) => streamSimple(model, transcript, settings)
      }
    };
  }
});
