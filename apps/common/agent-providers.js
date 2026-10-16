// Page-owned bridge from plugin contributions of kind "agent.providers" to the model
// provider engine of whichever session is open (step P2 of
// docs/plugins-providers-agent-core.md); the counterpart of agent-extensions.js. The
// plugin runtime outlives sessions; each session attaches its own pi-ai Models collection
// and detaches it on close. Detaching never closes or stops the runtime.
// No authorization: plugins are trusted app code. This module imports no library code
// (plugin-builtins.js imports it at page start; rows bring their own pieces).
//
// A contribution is one provider row (plugins/core-providers-<mode>/web/provider.js documents the shape):
// {mode, providerIds, label, requestLabel?, waitingLabel?, auth: "account" |
// "transient-key" | "none", defaultModelId?, fixedModelId?, listed?, order?,
// catalog(), catalogModel(id), thinkingEfforts(id), fastModel(list), create(host),
// replaces?: [mode]}. The contribution key is free (the built-ins use their mode).
// The mode is permanent once stored (ThreadsDoc modelSettings.mode), so:
// - modes and providerIds are unique across contributions; taking an existing mode
//   needs an explicit replaces: ["<mode>"] (it may only name the row's own mode; one
//   replacement per mode). A replacement may reuse the replaced row's providerIds;
// - essential contributions (the core-providers-* built-ins) are processed first, then
//   plain ones, then explicit replacements, each in the runtime's contribution order.
//
// Core fallback (same rules as agent-extensions.js, A2): for every ESSENTIAL
// contribution the session supplied a bundled copy of (attach builtins), the runtime
// copy is used only while it is healthy: its plugin is active, the row normalizes and
// create(host) succeeds with a usable instance. Otherwise (setup failed, stopped,
// runtime closed, invalid row, create threw or returned an unusable instance) the
// bundled copy is used in its place; list().fallbacks reports "... (using built-in
// copy)". A failed create is remembered for the page, so every session falls back.
//
// The session engine (session-providers.js) does the per-session work. attach() returns
// its handle: rows() (the current rows), instantiate(row, host) → {row, instance} (with
// the fallback above), subscribe(listener) (rows changed: a runtime copy arrived,
// failed, stopped or was replaced; the engine re-creates changed rows, and the change
// applies from the next model request) and detach().
//
// P3 (docs §B1b): a provider that goes away (plugin disabled, uninstalled, failed) is
// remembered for the page: labelOf("<mode>" | "provider:<id>") still names it, so a chat
// or saved work that keeps its mode can say what it waits for. Nothing else is kept.
export const AGENT_PROVIDERS = "agent.providers";
export const READY_TIMEOUT_MS = 5000;
const MODE = /^[a-z][a-z0-9-]{1,63}$/;
const AUTH = Object.freeze(["account", "transient-key", "none"]);
const FUNCTIONS = Object.freeze(["catalog", "catalogModel", "thinkingEfforts", "fastModel", "create"]);
const message = (error) => error instanceof Error ? error.message : String(error);

/** Checks one provider row; returns {mode, providerIds, replaces}. */
function normalize(value) {
  if (!value || typeof value !== "object") throw new TypeError("agent.providers needs a provider row {mode, providerIds, label, auth, catalog(), thinkingEfforts(), create(host), ...}");
  const { mode } = value;
  if (typeof mode !== "string" || !MODE.test(mode)) throw new TypeError(`Invalid model provider mode ${JSON.stringify(mode)}: a lowercase letter, then 1-63 lowercase letters, digits or hyphens`);
  const owner = `Model provider ${mode}`;
  const ids = value.providerIds;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 128)) throw new TypeError(`${owner}: providerIds must be a non-empty array of provider ids`);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) throw new Error(`${owner} declares provider id ${twice} twice`);
  if (typeof value.label !== "string" || !value.label.trim()) throw new TypeError(`${owner} needs a label`);
  for (const field of ["requestLabel", "waitingLabel", "defaultModelId", "fixedModelId"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new TypeError(`${owner}: ${field} must be a string`);
  }
  if (value.listed !== undefined && typeof value.listed !== "boolean") throw new TypeError(`${owner}: listed must be true or false`);
  if (value.order !== undefined && !Number.isFinite(value.order)) throw new TypeError(`${owner}: order must be a number`);
  if (!AUTH.includes(value.auth)) throw new TypeError(`${owner}: auth must be one of ${AUTH.join(", ")}`);
  const missing = FUNCTIONS.find((name) => typeof value[name] !== "function");
  if (missing) throw new TypeError(`${owner} needs ${missing}()`);
  const replaces = value.replaces ?? [];
  if (!Array.isArray(replaces) || replaces.some((item) => item !== mode)) throw new Error(`${owner}: replaces may only name the mode itself (replaces: ["${mode}"])`);
  return { mode, providerIds: [...ids], replaces: replaces.length > 0 };
}

// What create(host) returned must be usable by the engine (a runtime copy only; the
// bundled rows are the app's own code and are used as they are).
function checkInstance(row, instance) {
  const owner = `Model provider ${row.mode}`;
  if (!instance || typeof instance !== "object" || typeof instance.then === "function") throw new TypeError(`${owner}: create() must synchronously return the provider's session part`);
  if (instance.provider !== undefined) {
    if (!instance.provider || typeof instance.provider !== "object") throw new TypeError(`${owner}: provider must be a pi-ai provider`);
    if (!row.providerIds.includes(instance.provider.id)) throw new Error(`${owner}: create() returned provider ${JSON.stringify(instance.provider.id)}, not one of its providerIds`);
  } else {
    if (typeof instance.streams?.stream !== "function" || typeof instance.streams?.streamSimple !== "function") throw new TypeError(`${owner}: create() needs streams {stream, streamSimple} or a complete provider`);
    // The engine resolves every gated request through credential(), except a transient key it holds itself.
    const needed = ["models", "savedModels", "choose", ...row.auth === "transient-key" ? [] : ["credential"]];
    const absent = needed.find((name) => typeof instance[name] !== "function");
    if (absent) throw new TypeError(`${owner}: create() needs ${absent}()`);
  }
  for (const name of ["subscribe", "close"]) {
    if (instance[name] !== undefined && typeof instance[name] !== "function") throw new TypeError(`${owner}: ${name} must be a function`);
  }
  return instance;
}

/**
 * createAgentProviders({onError, timeoutMs}) → adapter:
 * - connect(runtime) once composition started; unavailable(error) if it failed.
 * - ready(): page-level barrier, resolves when connected/unavailable or after timeoutMs.
 * - attach(models, {host, builtins}) → the session's handle (see above). builtins are
 *   the bundled built-in rows [{pluginId, key, order, value}] (core-providers.js
 *   coreProviderContributions); host is the default for instantiate(row, host).
 * - rows(): the provider rows in use now (runtime copies, bundled stand-ins, plugins).
 * - labelOf("<mode>" | "provider:<id>") → {label, waitingLabel} | undefined (P3; rows
 *   that went away stay named for the page).
 * - describe(): [{mode, label, auth, providerIds, pluginId, source, essential?,
 *   fallback?}] for Settings (P4 builds on it).
 * - list(): diagnostics: status, accepted, rejected, fallbacks [{pluginId, reason}].
 * - subscribe(listener) → unsubscribe; close().
 */
export function createAgentProviders({ onError = () => {}, timeoutMs = READY_TIMEOUT_MS } = {}) {
  let runtime = null, unsubscribeRuntime = () => {}, settled = false, late = false, unavailableReason;
  let resolveSettled;
  const whenSettled = new Promise((resolve) => { resolveSettled = resolve; });
  let readiness;
  let bundled = []; // essential rows supplied by the session (fallback)
  let accepted = [], rejected = [], fallbacks = new Map();
  let current = []; // accepted rows, as handed to sessions
  const items = new Map(); // row -> accepted item
  const createFailures = new WeakMap(); // runtime row value -> reason create(host) failed
  const completedRows = new WeakMap(); // runtime row value -> row with defaults
  const sessions = new Map(); // models -> {listeners, host, handle}
  const listeners = new Set();
  const reported = new Set();
  const seen = new Map(); // "<mode>" | "provider:<id>" -> {label, waitingLabel} of every row accepted on this page
  let scheduled = false, signature = "";

  function report(error, details) {
    try { onError(error instanceof Error ? error : new Error(String(error)), details); } catch { /* reporting must not break sync */ }
  }
  function reportOnce(id, error, details) {
    if (reported.has(id)) return;
    reported.add(id);
    report(error, details);
  }
  function settle() {
    if (settled) return;
    settled = true;
    resolveSettled();
  }
  // A runtime row with the defaults the engine reads (labels, listed, order, default model).
  function completed(value, order) {
    if (value.requestLabel !== undefined && value.waitingLabel !== undefined && value.listed !== undefined && value.order !== undefined && value.defaultModelId !== undefined) return value;
    if (!completedRows.has(value)) completedRows.set(value, Object.freeze({
      ...value, requestLabel: value.requestLabel ?? value.label, waitingLabel: value.waitingLabel ?? value.label,
      listed: value.listed ?? true, order: value.order ?? order, defaultModelId: value.defaultModelId ?? ""
    }));
    return completedRows.get(value);
  }
  // Why an essential plugin's runtime copy cannot be used (undefined: pending or absent).
  function unusable(record, key) {
    if (!record) return undefined;
    if (record.state === "failed") return record.reason ?? "Setup failed";
    if (record.state === "stopped") return "Stopped unexpectedly";
    if (record.state === "blocked") return record.reason ?? "Blocked";
    if (record.state === "active") return `Contributed no model provider ${key}`;
    return undefined;
  }
  function gather(byId, failed, nextFallbacks) {
    const result = [];
    const live = new Set();
    const backupOf = (pluginId, key) => bundled.find((entry) => entry.pluginId === pluginId && entry.key === key);
    for (const entry of runtime ? runtime.contributions(AGENT_PROVIDERS) : []) {
      const essential = byId.get(entry.providerId)?.essential === true;
      const backup = essential ? backupOf(entry.providerId, entry.key) : undefined;
      const base = { key: entry.key, pluginId: entry.providerId, source: "runtime", essential, order: entry.order };
      try {
        const item = { ...base, ...normalize(entry.value), value: entry.value };
        const refused = createFailures.get(entry.value);
        if (refused) throw new Error(refused);
        item.row = completed(entry.value, entry.order);
        if (backup) item.fallback = backup.value;
        result.push(item);
        live.add(`${entry.providerId}\0${entry.key}`);
      } catch (error) {
        const reason = message(error);
        failed.push({ ...base, ...(entry.value?.mode ? { mode: String(entry.value.mode) } : {}), reason: backup ? `${reason} (using built-in copy)` : reason, ...(backup ? { fallback: true } : {}) });
        if (backup && !nextFallbacks.has(entry.providerId)) nextFallbacks.set(entry.providerId, reason);
      }
    }
    for (const entry of bundled) {
      if (live.has(`${entry.pluginId}\0${entry.key}`)) continue; // the healthy runtime copy is used
      const reason = unusable(runtime ? byId.get(entry.pluginId) : undefined, entry.key);
      if (reason && !nextFallbacks.has(entry.pluginId)) nextFallbacks.set(entry.pluginId, reason);
      const base = { key: `bundled:${entry.key}`, pluginId: entry.pluginId, source: "bundled", essential: true, order: entry.order ?? 0 };
      try { result.push({ ...base, ...normalize(entry.value), value: entry.value, row: entry.value }); }
      catch (error) { failed.push({ ...base, reason: message(error) }); }
    }
    return result;
  }
  function compute() {
    const records = runtime ? runtime.list() : [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const failed = [], nextFallbacks = new Map();
    const essential = [], plain = [], replacing = [];
    for (const item of gather(byId, failed, nextFallbacks)) (item.essential ? essential : item.replaces ? replacing : plain).push(item);
    essential.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const result = [], modes = new Map(), ids = new Map(), replaced = new Map();
    for (const item of [...essential, ...plain, ...replacing]) {
      const reject = (reason) => failed.push({ key: item.key, pluginId: item.pluginId, source: item.source, essential: item.essential, mode: item.mode, reason });
      const owner = item.essential ? `core plugin ${item.pluginId}` : `plugin ${item.pluginId}`;
      const index = modes.get(item.mode);
      if (index !== undefined && !item.replaces) { reject(`Model provider mode ${item.mode} is already provided by ${result[index].owner}; declare replaces: ["${item.mode}"] to replace it`); continue; }
      if (index !== undefined && replaced.has(item.mode)) { reject(`Model provider mode ${item.mode} is already replaced by ${replaced.get(item.mode)}`); continue; }
      // A replacement may keep the provider ids of the row it replaces, nothing else that is taken.
      const clash = item.providerIds.find((id) => ids.has(id) && ids.get(id) !== item.mode);
      if (clash) { reject(`Provider id ${clash} is already used by model provider ${ids.get(clash)} (${result[modes.get(ids.get(clash))].owner})`); continue; }
      if (index !== undefined) {
        for (const id of result[index].providerIds) ids.delete(id);
        replaced.set(item.mode, owner);
        result[index] = { ...item, owner }; // keeps the replaced row's position
      } else {
        modes.set(item.mode, result.length);
        result.push({ ...item, owner });
      }
      for (const id of item.providerIds) ids.set(id, item.mode);
    }
    return { accepted: result, rejected: failed, fallbacks: nextFallbacks };
  }
  function sync() {
    scheduled = false;
    ({ accepted, rejected, fallbacks } = compute());
    const rows = accepted.map((item) => item.row);
    const changed = rows.length !== current.length || rows.some((row, index) => row !== current[index]);
    current = Object.freeze(rows);
    items.clear();
    for (const item of accepted) items.set(item.row, item);
    for (const row of rows) {
      const names = Object.freeze({ label: row.label, waitingLabel: row.waitingLabel ?? row.label });
      seen.set(row.mode, names);
      for (const id of row.providerIds) seen.set(`provider:${id}`, names);
    }
    for (const item of accepted) {
      if (item.source === "runtime") runtime?.diagnose?.(AGENT_PROVIDERS, item.key, { state: "installed", mode: item.mode, providerIds: item.providerIds, ...(item.replaces ? { replaces: [item.mode] } : {}) });
    }
    for (const item of rejected) {
      if (item.source === "runtime") runtime?.diagnose?.(AGENT_PROVIDERS, item.key, { state: "failed", reason: item.reason, ...(item.mode ? { mode: item.mode } : {}), ...(item.fallback ? { fallback: true } : {}) });
    }
    // Sessions first: their engines re-create changed rows before anyone reads the lists.
    if (changed) for (const state of [...sessions.values()]) {
      for (const listener of [...state.listeners]) {
        try { listener(); } catch (error) { report(error, { phase: "providers" }); }
      }
    }
    const next = JSON.stringify([accepted.map((item) => [item.key, item.pluginId, item.mode, item.source]), rejected, late, unavailableReason ?? null, [...fallbacks],
      runtime ? runtime.list().map((record) => [record.id, record.state, record.reason ?? ""]) : []]);
    if (next !== signature) {
      signature = next;
      for (const item of rejected) reportOnce(`${item.pluginId}\0${item.key}\0${item.reason}`, new Error(item.reason), { id: item.pluginId, phase: AGENT_PROVIDERS, key: item.key });
      for (const [pluginId, reason] of fallbacks) reportOnce(`fallback\0${pluginId}\0${reason}`, new Error(`${reason} (using built-in copy)`), { id: pluginId, phase: "fallback" });
      notify();
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { report(error, { phase: "subscribe" }); }
    }
  }

  function connect(next) {
    if (runtime) { report(new Error("Model providers are already connected to a plugin runtime"), { phase: "connect" }); return; }
    if (!next || typeof next.contributions !== "function" || typeof next.subscribe !== "function") throw new TypeError("connect needs a plugin runtime");
    runtime = next;
    unsubscribeRuntime = runtime.subscribe(schedule);
    sync(); // Synchronously: attached sessions have the runtime rows before ready resolves.
    settle();
  }
  function unavailable(error) {
    if (runtime || settled) return;
    unavailableReason = message(error ?? "Plugins are unavailable");
    report(error ?? new Error(unavailableReason), { phase: "composition" });
    settle();
    notify();
  }
  function ready() {
    if (!readiness) readiness = new Promise((resolve) => {
      if (settled) { resolve(); return; }
      const timer = globalThis.setTimeout(() => {
        if (!settled) {
          late = true;
          report(new Error(`Model provider plugins were not ready within ${timeoutMs} ms; replies use the built-in providers until they load`), { phase: "readiness" });
          notify();
        }
        resolve();
      }, timeoutMs);
      void whenSettled.then(() => { globalThis.clearTimeout(timer); resolve(); });
    });
    return readiness;
  }
  // The session part of one row: a runtime copy that cannot be built hands over to its
  // bundled copy (for every session: the failure is remembered for the page).
  function instantiate(row, host) {
    const item = items.get(row);
    if (!item || item.source === "bundled") return { row, instance: row.create(host) };
    try {
      return { row, instance: checkInstance(row, row.create(host)) };
    } catch (error) {
      const reason = message(error);
      createFailures.set(item.value, reason);
      schedule();
      if (!item.fallback) {
        reportOnce(`create\0${item.key}\0${reason}`, error, { id: item.pluginId, phase: "create", mode: item.mode });
        throw error;
      }
      reportOnce(`create\0${item.key}\0${reason}`, new Error(`${reason} (using built-in copy)`), { id: item.pluginId, phase: "create", mode: item.mode });
      return { row: item.fallback, instance: item.fallback.create(host) };
    }
  }
  function attach(models, { host, builtins } = {}) {
    if (!models || typeof models.setProvider !== "function") throw new TypeError("attach needs a pi-ai Models collection");
    if (sessions.has(models)) return sessions.get(models).handle;
    if (builtins !== undefined) {
      if (!Array.isArray(builtins) || builtins.some((entry) => typeof entry?.pluginId !== "string" || typeof entry?.key !== "string" || !entry.value || typeof entry.value !== "object")) throw new TypeError("builtins must be [{pluginId, key, order, value}]");
      bundled = builtins.map((entry) => ({ ...entry }));
    }
    let detached = false;
    const state = { listeners: new Set() };
    state.handle = Object.freeze({
      rows: () => current,
      labelOf,
      instantiate: (row, given) => instantiate(row, given ?? host),
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("subscribe expects a function");
        state.listeners.add(listener);
        return () => { state.listeners.delete(listener); };
      },
      detach() {
        if (detached) return;
        detached = true;
        state.listeners.clear();
        sessions.delete(models);
      }
    });
    sessions.set(models, state);
    sync();
    return state.handle;
  }
  function rows() {
    return current;
  }
  /** {label, waitingLabel} of a mode or "provider:<id>": a current row, else one seen earlier on this page. */
  function labelOf(key) {
    const text = String(key ?? "");
    const id = text.startsWith("provider:") ? text.slice("provider:".length) : undefined;
    const row = current.find((candidate) => id === undefined ? candidate.mode === text : candidate.providerIds.includes(id));
    if (row) return { label: row.label, waitingLabel: row.waitingLabel ?? row.label };
    return seen.get(text);
  }
  function describe() {
    return accepted.map((item) => ({
      mode: item.mode, label: item.row.label, auth: item.row.auth, providerIds: [...item.providerIds], pluginId: item.pluginId, source: item.source,
      ...(item.essential ? { essential: true } : {}), ...(fallbacks.get(item.pluginId) ? { fallback: fallbacks.get(item.pluginId) } : {})
    }));
  }
  function status() {
    return { connected: Boolean(runtime), settled, late: late && !runtime, ...(unavailableReason ? { unavailable: unavailableReason } : {}) };
  }
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe expects a function");
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  function list() {
    return {
      ...status(),
      sessions: sessions.size,
      accepted: accepted.map(({ key, pluginId, mode, providerIds, replaces, essential, source }) => ({ key, pluginId, mode, providerIds: [...providerIds], ...(replaces ? { replaces: [mode] } : {}), ...(essential ? { essential: true } : {}), source })),
      rejected: rejected.map(({ key, pluginId, mode, reason, essential, source }) => ({ key, pluginId, ...(mode ? { mode } : {}), reason, ...(essential ? { essential: true } : {}), source })),
      fallbacks: [...fallbacks].map(([pluginId, reason]) => ({ pluginId, reason }))
    };
  }
  function close() {
    unsubscribeRuntime();
    unsubscribeRuntime = () => {};
    listeners.clear();
    for (const state of sessions.values()) state.listeners.clear();
    sessions.clear();
  }
  return Object.freeze({ connect, unavailable, ready, attach, rows, labelOf, describe, status, subscribe, list, close });
}
