// apps/common/session-providers.js
// The session's model provider engine (step P1b of docs/plugins-providers-agent-core.md):
// everything session.js used to do by hand for each provider, moved here and made
// generic over the provider rows (plugins/core-providers-<mode>/web/provider.js). Each row's create(host)
// holds the provider-specific part (credential checks, live/saved model lists, configure
// checks, streams, or a complete pi-ai provider for the offline demo); this engine does,
// once for every row:
// - composition: createProvider({id, models, auth: {apiKey: {name, resolve}}, api}),
//   where resolve FIRST awaits recovery.wait(mode) and only then resolves the credential
//   (auth "transient-key": the in-memory key of that mode; otherwise row credential());
// - transport: host.transport() (evaluated per install, as before) wrapped with
//   safeModelErrorResponse(…, {provider: requestLabel});
// - catalogs (providerCatalog), signed-in installs, saved-work registration and recovery
//   holds/releases keyed by mode, restoring recovery from credential changes, owned/sendTo
//   providers, the subagent model API (resolveModel/listModels/clampThinking) and
//   configure for a send.
// Transient keys live only in this closure: never in a returned value other than the
// pi-ai auth resolve result, never in ThreadsDoc or any commit. session.js clears them
// when the session goes idle and on close (clearTransientKeys).
// Behaviour is unchanged and pinned by tests/plugin-p0-providers.test.mjs, including
// quirks later steps fix on purpose ("faux" for subagents, the ChatGPT "" default).
// P3 (docs §B1b): missing or unknown providers. A mode or provider id that no row owns
// (its plugin is disabled, uninstalled, failed or still loading) is KEPT, never coerced
// to offline: reads return it with available:false and a label ("<label or raw id>"),
// writes (checked: setModelSettings, send) refuse it with "<label> is not available.
// Enable its plugin or choose another model.", a pi.agent provider no row owns maps to
// the display-only mode "provider:<id>" (never stored), and its saved work waits under
// the recovery hold "provider:<id>" behind a stand-in provider, so it never runs
// against a missing provider. When the adapter reports an owner again (or after a
// reopen) the work is handed to the owner through the normal per-mode path (hold,
// saved models, restore). A row that disappears mid-session hands its installed
// models and waiting requests to such a stand-in. The four built-in modes always have
// a row (bundled fallback) and never take these paths.
// P2: the rows may come from the page's agent.providers adapter (agent-providers.js): a
// handle whose rows change while the session is open (a runtime copy arrives, fails,
// stops or is replaced). A changed row gets a new instance; its provider is installed
// again where it was installed, so the change applies from the next model request
// (requests already streaming finish on the provider they started with).
import { createProvider, getSupportedThinkingLevels, clampThinkingLevel, lazyStream } from "./library/pi-ai.js";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./library/pi-ai/providers/faux.js";
import { stream, streamSimple } from "./library/pi-ai/api/openai-responses.js";
import { stream as streamClaude, streamSimple as streamClaudeSimple } from "./library/pi-ai/api/anthropic-messages.js";
import { safeModelErrorResponse } from "./model-error.js";
import { createProviderTable, UNKNOWN_MODE_FALLBACK } from "./core-providers.js";

/** Prefix of the display/recovery key of a provider id no row owns (never stored). */
export const MISSING = "provider:";
// A mode a provider row can have (agent-providers.js checks contributions the same way).
const MODE = /^[a-z][a-z0-9-]{1,63}$/;

// The host's own library pieces for rows (rows never import pi-ai streams themselves).
const AI = Object.freeze({
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  streams: Object.freeze({
    openaiResponses: Object.freeze({ stream, streamSimple }),
    anthropicMessages: Object.freeze({ stream: streamClaude, streamSimple: streamClaudeSimple })
  })
});

/**
 * models: the session's pi-ai Models; rows: provider rows (with create(host)), or the
 * session's agent.providers handle {rows(), instantiate(row, host), subscribe(listener)};
 * host: {transport() -> fetch, credentials: {chatgpt, claude}, env, demoTokensPerSecond,
 * messages: {textOf, attachedUserPresentation}}; recovery: the session's recovery gate
 * (keyed by mode); storedModel(id) -> the stored pi.agent model ref of a conversation;
 * onChange() after the rows changed (the session republishes what depends on them).
 * Ungated rows (a complete `provider`, i.e. the offline demo) are installed right away.
 */
export function createSessionProviders({ models, rows, host, recovery, storedModel, onChange }) {
  const source = Array.isArray(rows) ? void 0 : rows;
  const thinking = { getSupportedThinkingLevels, clampThinkingLevel };
  let table = createProviderTable(source ? source.rows() : rows, thinking);
  // Lookups over the current table (it changes when the adapter's rows do).
  const rowOf = (mode) => table.rowOf(mode);
  const owned = (provider) => table.rows.some((row) => row.providerIds.includes(provider));
  /** pi.agent provider id -> mode; an id no row owns -> "provider:<id>" (P3; display and recovery only). */
  const modeOf = (provider) => typeof provider === "string" && provider && !owned(provider) ? `${MISSING}${provider}` : table.modeOf(provider);
  const providerIdOf = (mode) => table.providerIdOf(mode);
  const fastModelOf = (mode, list) => table.fastModelOf(mode, list);
  const thinkingFor = (model, requested) => table.thinkingFor(model, requested);
  const rowHost = Object.freeze({ ...host, ai: AI });
  // {row, instance}; through the adapter a failing runtime copy yields its bundled copy,
  // and a row that cannot be built at all is left out (null; the adapter reports it).
  const instantiate = (row) => {
    if (!source) return { row, instance: row.create(rowHost) };
    try {
      return source.instantiate(row, rowHost);
    } catch {
      return null;
    }
  };
  const instances = new Map();
  const used = [];
  for (const row of table.rows) {
    const made = instantiate(row);
    if (!made) continue;
    instances.set(made.row.mode, made.instance);
    used.push(made.row);
  }
  if (used.length !== table.rows.length || used.some((row, index) => row !== table.rows[index])) table = createProviderTable(used, thinking);
  for (const instance of instances.values()) if (instance.provider) models.setProvider(instance.provider);
  /** Not credential-gated: the row installs a complete provider (offline demo; unknown modes fall back to it). */
  const ungated = (mode) => Boolean(instances.get(mode)?.provider);
  // P3: labels of every row seen in this session (and, through the adapter, on this page),
  // so a missing provider is still named by its label.
  const seen = new Map();
  const remember = (list) => {
    for (const row of list) {
      const names = Object.freeze({ label: row.label, waitingLabel: row.waitingLabel ?? row.label });
      seen.set(row.mode, names);
      for (const id of row.providerIds) seen.set(`${MISSING}${id}`, names);
    }
  };
  remember(table.rows);
  /** {label, waitingLabel} of a mode or "provider:<id>" (current row, else remembered), or undefined. */
  const labelsOf = (key) => {
    const row = rowOf(key) ?? (String(key).startsWith(MISSING) ? rowOf(modeOf(String(key).slice(MISSING.length))) : void 0);
    if (row) return { label: row.label, waitingLabel: row.waitingLabel ?? row.label };
    let remembered;
    try {
      remembered = source?.labelOf?.(key);
    } catch {
    }
    return seen.get(key) ?? remembered;
  };
  const rawId = (key) => String(key).startsWith(MISSING) ? String(key).slice(MISSING.length) : String(key);
  const labelFor = (key) => labelsOf(key)?.label ?? rawId(key);
  const unavailable = (key) => new Error(`${labelFor(key)} is not available. Enable its plugin or choose another model.`);
  /** Reads: a stored choice whose mode no row owns stays as is, marked unavailable. */
  const read = (settings) => rowOf(settings.mode) ? settings : { ...settings, available: false, label: labelFor(settings.mode) };
  /** The whitelist normalizer; a valid mode no row owns is kept (never coerced). */
  const normalize = (value = {}) => {
    const mode = value?.mode;
    if (typeof mode !== "string" || rowOf(mode) || !MODE.test(mode)) return table.modelSettings(value);
    return {
      mode,
      modelId: typeof value.modelId === "string" ? value.modelId.trim().slice(0, 300) : "",
      thinkingEffort: typeof value.thinkingEffort === "string" ? value.thinkingEffort.trim().slice(0, 32) : ""
    };
  };
  /** Writes (setModelSettings, send): refuses a mode no row owns before anything is written. */
  const checked = (value = {}) => {
    const mode = value?.mode;
    if (typeof mode === "string" && mode && !rowOf(mode)) throw unavailable(mode);
    return normalize(value);
  };
  const fromAgent = (agent) => {
    const mode = modeOf(agent?.model?.provider);
    if (rowOf(mode)) return table.agentModelSettings(agent);
    return read({
      mode,
      modelId: typeof agent.model.modelId === "string" ? agent.model.modelId.trim().slice(0, 300) : "",
      thinkingEffort: typeof agent.thinkingLevel === "string" ? agent.thinkingLevel.slice(0, 32) : ""
    });
  };
  // P3: saved work of a provider id no row owns waits behind a stand-in provider under the
  // recovery hold "provider:<id>". Stand-ins know the saved model ids (pi-durable needs the
  // model to exist), never run a request themselves: once the hold is released they hand
  // the request to the provider that owns the id now.
  const missing = new Map(); // provider id -> {refs: Map(modelId -> ref), models: Map(modelId -> model)}
  const standIns = new WeakSet();
  const orphaned = new WeakSet(); // instances whose row disappeared mid-session
  const standInModel = (provider, id) => ({
    id,
    name: id,
    api: "self-forming-unavailable",
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128e3,
    maxTokens: 16384
  });
  // The provider that serves `provider` now (the owner's install), never `stale` itself.
  const current = (provider, stale) => {
    const mode = modeOf(provider);
    const ids = rowOf(mode) ? [provider, providerIdOf(mode)] : [provider];
    for (const id of ids) {
      const found = models.getProvider(id);
      if (found && found !== stale && !(standIns.has(found) && stale && standIns.has(stale))) return found;
    }
    return void 0;
  };
  const forwardAuth = async (provider, stale, args) => {
    const live = current(provider, stale);
    if (!live) throw unavailable(`${MISSING}${provider}`);
    return live.auth?.apiKey ? live.auth.apiKey.resolve(args) : { auth: {} };
  };
  const forwardStream = (provider, stale, method) => (model, transcript, options) => lazyStream(model, async () => {
    const live = current(provider, stale());
    if (!live) throw unavailable(`${MISSING}${provider}`);
    let list = [];
    try {
      list = live.getModels();
    } catch {
    }
    return live[method](list.find((item) => item.id === model.id) ?? { ...model, provider: live.id }, transcript, options);
  });
  const standIn = (provider, list) => {
    const key = `${MISSING}${provider}`;
    const made = createProvider({
      id: provider,
      name: labelFor(key),
      models: list,
      auth: { apiKey: { name: labelFor(key), resolve: async (args) => {
        await recovery.wait(key, args?.signal);
        return forwardAuth(provider, made, args);
      } } },
      api: { stream: forwardStream(provider, () => made, "stream"), streamSimple: forwardStream(provider, () => made, "streamSimple") }
    });
    standIns.add(made);
    return made;
  };
  /** Holds work of a provider id no row owns: refs ({provider, modelId}) or the models it had. */
  const holdMissing = (provider, items) => {
    let entry = missing.get(provider);
    if (!entry) missing.set(provider, entry = { refs: new Map(), models: new Map() });
    for (const item of items) {
      const id = item.modelId ?? item.id;
      if (typeof id !== "string") continue;
      entry.refs.set(id, { provider, modelId: id });
      if (!entry.models.has(id)) entry.models.set(id, item.api ? { ...item, provider } : standInModel(provider, id));
    }
    recovery.hold(`${MISSING}${provider}`);
    models.setProvider(standIn(provider, [...entry.models.values()]));
  };
  const keys = new Map();
  const catalogs = new Map();
  const subscriptions = new Map();
  const checkingAuth = new Set();
  let recovering = [];
  let following = false;
  let closed = false;

  const setTransientKey = (mode, key) => {
    keys.set(mode, key);
  };
  const clearTransientKeys = () => {
    keys.clear();
  };
  const install = (mode, list) => {
    const row = rowOf(mode);
    const instance = instances.get(mode);
    const label = row.requestLabel;
    const id = providerIdOf(mode);
    const transport = host.transport();
    const fetch = async (input, init) => safeModelErrorResponse(await transport(input, init), { provider: label, input, init });
    // P3: once this row is gone (orphaned), requests that were waiting here move on to
    // whatever serves the id now (the stand-in that waits for an owner, or the owner).
    const forwarded = {
      stream: forwardStream(id, () => installed, "stream"),
      streamSimple: forwardStream(id, () => installed, "streamSimple")
    };
    catalogs.set(mode, list);
    const installed = createProvider({
      id,
      models: list,
      auth: { apiKey: { name: label, resolve: async ({ signal }) => {
        await recovery.wait(mode, signal);
        if (orphaned.has(instance)) return forwardAuth(id, installed, { signal });
        if (row.auth === "transient-key") {
          const key = keys.get(mode);
          return key ? { auth: { apiKey: key } } : void 0;
        }
        return instance.credential(signal);
      } } },
      api: {
        stream: (model, transcript, settings) => orphaned.has(instance) ? forwarded.stream(model, transcript, settings) : instance.streams.stream(model, transcript, { ...settings, fetch }),
        streamSimple: (model, transcript, settings) => orphaned.has(instance) ? forwarded.streamSimple(model, transcript, settings) : instance.streams.streamSimple(model, transcript, { ...settings, fetch })
      }
    });
    models.setProvider(installed);
  };
  /** Live catalog of one mode (providerCatalog): checks the credential, installs, releases recovery. */
  const catalog = async (mode, signal) => {
    if (!instances.has(mode) || ungated(mode)) return (rowOf(mode) ?? rowOf(UNKNOWN_MODE_FALLBACK)).catalog();
    const list = await instances.get(mode).models(signal, { hasTransientKey: Boolean(keys.get(mode)), installed: catalogs.get(mode) });
    install(mode, list);
    recovery.release(mode);
    return list;
  };
  /** Every account row whose credential is usable now. */
  const installSignedIn = async () => {
    for (const row of table.rows) {
      if (row.auth !== "account") continue;
      try {
        await catalog(row.mode);
      } catch {
      }
    }
  };
  // Saved work of one gated mode: hold its requests and install the saved model list.
  const registerSavedMode = (mode, refs) => {
    const list = instances.get(mode).savedModels(refs);
    recovery.hold(mode);
    install(mode, list);
  };
  const restore = async (mode) => {
    if (closed || !recovery.has(mode) || checkingAuth.has(mode)) return;
    checkingAuth.add(mode);
    try {
      await catalog(mode);
    } catch {
    } finally {
      checkingAuth.delete(mode);
    }
  };
  /**
   * Startup, once: registers the saved model refs of pending work (grouped by mode,
   * ungated ones skipped), then follows credential changes. The subscriptions come after
   * the holds, so a controller's immediate callback already finds them.
   */
  const registerSaved = (refs) => {
    const byMode = new Map();
    for (const ref of refs) {
      const mode = modeOf(ref.provider);
      if (ungated(mode)) continue;
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push(ref);
    }
    for (const [mode, list] of byMode) {
      if (rowOf(mode)) registerSavedMode(mode, list);
      else holdMissing(list[0].provider, list);
    }
    recovering = [...byMode.keys()].filter((mode) => rowOf(mode));
    if (following) return;
    following = true;
    for (const [mode, instance] of instances) follow(mode, instance);
  };
  // Credential changes of one mode restore its held work.
  const follow = (mode, instance) => {
    const unsubscribe = instance.subscribe?.((state) => {
      if (state.signedIn) void restore(mode);
    });
    if (unsubscribe) subscriptions.set(mode, unsubscribe);
  };
  const retire = (mode) => {
    subscriptions.get(mode)?.();
    subscriptions.delete(mode);
    instances.get(mode)?.close?.();
    instances.delete(mode);
  };
  /** P2: the adapter's rows changed; unchanged rows keep their instance. */
  const swap = () => {
    if (closed) return;
    const previous = table;
    let next;
    try {
      next = createProviderTable(source.rows(), thinking);
    } catch {
      return;
    }
    const kept = [];
    const created = new Map();
    for (const row of next.rows) {
      const old = previous.rowOf(row.mode);
      if (old === row) {
        kept.push(row);
        continue;
      }
      const made = instantiate(row);
      if (made) {
        created.set(made.row.mode, made);
        kept.push(made.row);
      } else if (old) kept.push(old);
    }
    try {
      table = kept.length === next.rows.length && kept.every((row, index) => row === next.rows[index]) ? next : createProviderTable(kept, thinking);
    } catch {
      for (const { instance } of created.values()) instance.close?.();
      return;
    }
    remember(table.rows);
    // P3: a row that disappeared hands its installed models and waiting work to a
    // stand-in that waits for an owner (a built-in mode always has its bundled row).
    for (const row of previous.rows) {
      if (table.rowOf(row.mode)) continue;
      const id = row.providerIds[0];
      const gone = instances.get(row.mode);
      let list = catalogs.get(row.mode);
      if (!list && gone?.provider) {
        try {
          list = models.getProvider(id) === gone.provider ? gone.provider.getModels() : void 0;
        } catch {
          list = void 0;
        }
      }
      catalogs.delete(row.mode);
      if (gone) orphaned.add(gone);
      retire(row.mode);
      if (!rowOf(modeOf(id)) && (list || missing.has(id))) holdMissing(id, list ?? []);
      recovery.release(row.mode);
    }
    for (const [mode, { row, instance }] of created) {
      const old = previous.rowOf(mode);
      const wasProvider = Boolean(instances.get(mode)?.provider);
      retire(mode);
      instances.set(mode, instance);
      if (old && old.providerIds[0] !== row.providerIds[0]) models.deleteProvider?.(old.providerIds[0]);
      if (instance.provider) {
        catalogs.delete(mode);
        models.setProvider(instance.provider);
      } else if (catalogs.has(mode)) install(mode, catalogs.get(mode));
      else if (wasProvider && old) models.deleteProvider?.(old.providerIds[0]);
      if (following) follow(mode, instance);
    }
    adopt();
    try {
      onChange?.();
    } catch {
    }
  };
  // P3: work waiting for a provider id whose owner arrived goes the normal per-mode way:
  // hold the mode with the saved models, release "provider:<id>", then restore.
  const adopt = () => {
    for (const [id, entry] of [...missing]) {
      const mode = modeOf(id);
      if (!rowOf(mode) || !instances.has(mode)) continue;
      if (!ungated(mode) && !catalogs.has(mode)) {
        try {
          registerSavedMode(mode, [...entry.refs.values()]);
        } catch {
          continue;
        }
      }
      missing.delete(id);
      recovery.release(`${MISSING}${id}`);
      if (!ungated(mode) && rowOf(mode).auth !== "transient-key") void restore(mode);
    }
  };
  const unsubscribeSource = source?.subscribe?.(swap);
  /** The provider of a stored (owned or sendTo) conversation, before submitting to it. */
  const ensureStored = async (id, config = {}) => {
    const ref = await storedModel(id);
    const mode = modeOf(ref?.provider);
    if (!rowOf(mode)) throw unavailable(mode);
    if (ungated(mode)) return;
    if (!catalogs.has(mode)) registerSavedMode(mode, [ref]);
    if (rowOf(mode).auth === "transient-key") {
      if (config.apiKey?.trim()) setTransientKey(mode, config.apiKey.trim());
      if (keys.get(mode)) recovery.release(mode);
      else recovery.hold(mode);
    } else if (recovery.has(mode)) await restore(mode);
  };
  const resolveModel = async (spec, parent, signal) => {
    const value = String(spec ?? "same").trim();
    if (!value || value === "same") return void 0;
    if (value === "fast") {
      const kind2 = modeOf(parent?.provider);
      const pick = fastModelOf(kind2, await catalog(kind2, signal));
      if (!pick) throw new Error("No model is available for this provider.");
      return { provider: providerIdOf(kind2), modelId: pick.id };
    }
    const slash = value.indexOf("/");
    const provider = slash > 0 ? value.slice(0, slash) : "";
    const modelId = value.slice(slash + 1);
    const kind = modeOf(provider);
    // Only the fallback mode can own an id it does not list (an unknown provider id).
    if (slash <= 0 || !rowOf(kind) || ungated(kind) && !rowOf(kind).providerIds.includes(provider)) throw new Error(`Unknown model "${value}". Use the models action to list the available ones.`);
    const list = await catalog(kind, signal);
    if (!list.some((m) => m.id === modelId)) throw new Error(`${value} is not available. Use the models action to list the available ones.`);
    return { provider, modelId };
  };
  const listModels = async (parent, signal) => {
    const lines = [`same: your model${parent ? ` (${parent.provider}/${parent.modelId})` : ""}`, "fast: a smaller, cheaper model of your provider"];
    for (const row of table.rows) {
      if (!row.listed) continue;
      let list;
      try {
        list = await catalog(row.mode, signal);
      } catch {
        continue;
      }
      for (const m of list) lines.push(`${providerIdOf(row.mode)}/${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`);
    }
    return lines.join("\n");
  };
  const clampThinking = (ref, level) => {
    if (!level) return void 0;
    const model = catalogs.get(modeOf(ref?.provider))?.find((m) => m.id === ref?.modelId);
    return model ? clampThinkingLevel(model, level) : level;
  };
  /** Configure for a send: {model: {provider, modelId}, thinkingLevel}, or a user-facing reason. */
  const configure = async (config) => {
    const row = rowOf(config.mode);
    if (row && ungated(row.mode)) return { model: { provider: row.providerIds[0], modelId: row.defaultModelId }, thinkingLevel: "off" };
    if (!row) throw typeof config.mode === "string" && config.mode ? unavailable(config.mode) : new Error("Choose a supported model provider.");
    const chosen = await instances.get(row.mode).choose(config);
    if (row.auth === "transient-key") setTransientKey(row.mode, chosen.key);
    install(row.mode, chosen.list);
    recovery.release(config.mode);
    void installSignedIn();
    return { model: { provider: providerIdOf(config.mode), modelId: chosen.model.id }, thinkingLevel: thinkingFor(chosen.model, config.thinkingEffort) };
  };
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeSource?.();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    for (const instance of instances.values()) instance.close?.();
  };
  return Object.freeze({
    rowOf,
    modeOf,
    providerIdOf,
    normalize,
    /** P3: normalize for writes; throws "<label> is not available. …" for a mode no row owns. */
    checked,
    /** P3: a stored choice as read (unknown modes kept, with available:false and label). */
    read,
    fromAgent,
    /** P3: the storable part of a choice ({mode, modelId, thinkingEffort}); undefined for a display-only "provider:<id>". */
    stored: (settings) => String(settings?.mode).startsWith(MISSING) ? void 0 : { mode: settings.mode, modelId: settings.modelId, thinkingEffort: settings.thinkingEffort },
    /** P3: {label, waitingLabel} of a mode or "provider:<id>" (also of missing rows seen before). */
    labelsOf,
    /** A mode whose sends need credentials (configure); false for the offline demo and unknown modes. */
    needsCredentials: (mode) => instances.has(mode) && !ungated(mode),
    configure,
    installSignedIn,
    registerSaved,
    ensureStored,
    restore,
    resolveModel,
    listModels,
    clampThinking,
    setTransientKey,
    clearTransientKeys,
    /** Modes held for saved work at startup (registerSaved), in the order found. */
    get recovering() {
      return recovering.slice();
    },
    close
  });
}
