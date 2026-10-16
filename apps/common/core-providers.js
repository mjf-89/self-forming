// The built-in model providers as a table (step P1a of
// docs/plugins-providers-agent-core.md): one row per mode in plugins/core-providers-<mode>/web/provider.js,
// static parts only (mode, providerIds, labels, defaultModelId, catalog,
// thinkingEfforts, fastModel). createProviderTable() turns rows into the pure lookups
// session.js used to hardcode: catalogModel, getThinkingEfforts, thinkingFor,
// modelSettings, agentModelSettings, providerIdOf, modeOf (kindOfProvider) and
// fastModelOf. Behaviour is unchanged and pinned by tests/plugin-p0-providers.test.mjs,
// including the odd parts that later steps change on purpose:
// - an unknown stored mode (and a pi.agent provider no row owns) becomes "offline"
//   (UNKNOWN_MODE_FALLBACK; P3 keeps unknown values instead);
// - unknown modes map to the provider id "faux" (the fallback row's first id).
// The session-bound parts (provider install, credentials, configure, recovery) are each
// row's create(host), run by the session engine session-providers.js (P1b).
// P2: each row is also the agent.providers contribution of an essential built-in plugin
// core-providers-<mode> (plugin-builtins.js createCoreProviderPlugins, loading the row
// lazily in setup), consumed by the page adapter agent-providers.js; every session gives
// the adapter the same rows as its bundled fallback (coreProviderContributions).
//
// The rows live in the provider plugins (plugins/core-providers-<mode>/: plugin.json,
// web/index.js exporting `provider` {mode, order, load}, web/provider.js the row itself);
// the generated registry builtin-plugins.js imports the entries. No library import and no
// row import at module evaluation: plugin-builtins.js imports this file without the bundled
// library, and loads the rows lazily (entry.load, loadCoreProviderRows). session.js
// imports the row files itself.
import { BUILTIN_PLUGINS } from "./builtin-plugins.js";

/** The mode every unknown mode or provider id falls back to today (P3 changes this). */
export const UNKNOWN_MODE_FALLBACK = "offline";

/**
 * Built-in provider plugins, from the registry: id (permanent, docs §C), mode, order
 * (claude 10, chatgpt 20, openai 30; offline 0 is accepted but not listed) and a lazy
 * loader of the row module (plugins/<id>/web/provider.js).
 */
export const CORE_PROVIDER_ROWS = Object.freeze(BUILTIN_PLUGINS
  .filter((item) => item.entry.provider)
  .map(({ manifest, entry }) => Object.freeze({ id: manifest.id, ...entry.provider }))
  .sort((a, b) => a.order - b.order));

/** The built-in rows themselves, in table order (loads the row modules and pi-ai). */
export async function loadCoreProviderRows(rows = CORE_PROVIDER_ROWS) {
  return Promise.all(rows.map(async (entry) => (await entry.load()).providerRow));
}

/**
 * The bundled copies of the built-in rows for agentProviders.attach(models, {builtins}):
 * [{pluginId, key, order, value}] (key = mode, as the runtime plugins contribute them).
 * rows: the loaded row objects (session.js imports them).
 */
export function coreProviderContributions(rows, entries = CORE_PROVIDER_ROWS) {
  return entries.flatMap((entry) => {
    const row = rows.find((candidate) => candidate.mode === entry.mode);
    return row ? [{ pluginId: entry.id, key: entry.mode, order: entry.order, value: row }] : [];
  });
}

const FAST_PATTERN = /mini|nano|haiku|flash|small/i;

/**
 * Pure lookups over provider rows. `thinking` takes the library's thinking helpers
 * ({getSupportedThinkingLevels, clampThinkingLevel}) so this file stays library-free.
 * Every function is a closure (no `this`), so they can be destructured and re-exported.
 */
export function createProviderTable(rows, { getSupportedThinkingLevels, clampThinkingLevel } = {}) {
  const table = [...rows].sort((a, b) => a.order - b.order);
  const modes = new Set();
  const ids = new Set();
  for (const row of table) {
    if (modes.has(row.mode)) throw new Error(`Duplicate model provider mode "${row.mode}".`);
    modes.add(row.mode);
    for (const id of row.providerIds) {
      if (ids.has(id)) throw new Error(`Duplicate model provider id "${id}".`);
      ids.add(id);
    }
  }
  const rowOf = (mode) => table.find((row) => row.mode === mode);
  const fallback = rowOf(UNKNOWN_MODE_FALLBACK);
  if (!fallback) throw new Error(`The provider table needs the "${UNKNOWN_MODE_FALLBACK}" row.`);

  /** pi.agent provider id -> mode; ids no row owns (and undefined) -> "offline". */
  const modeOf = (provider) => table.find((row) => row.providerIds.includes(provider))?.mode ?? UNKNOWN_MODE_FALLBACK;
  /** mode -> the pi.agent provider id for new configurations; unknown -> "faux". */
  const providerIdOf = (mode) => (rowOf(mode) ?? fallback).providerIds[0];
  /** The bundled catalog model for a choice; undefined for offline/unknown modes. */
  const catalogModel = ({ mode, modelId }) => rowOf(mode)?.catalogModel(modelId);
  const getThinkingEfforts = ({ mode, modelId }) => rowOf(mode)?.thinkingEfforts(modelId) ?? [];
  const thinkingFor = (model, requested) => {
    if (requested !== void 0 && requested !== "" && !getSupportedThinkingLevels(model).includes(requested))
      throw new Error("Choose a thinking effort supported by this model.");
    return clampThinkingLevel(model, requested || "off");
  };
  // Only non-secret preferences belong in thread metadata. AgentDoc remains the
  // configuration of the last/active run, including owned subagents and recovery.
  const modelSettings = (value = {}) => {
    const mode = rowOf(value.mode) ? value.mode : UNKNOWN_MODE_FALLBACK;
    const fixed = rowOf(mode).fixedModelId;
    const modelId = fixed !== void 0 ? fixed : typeof value.modelId === "string" ? value.modelId.trim().slice(0, 300) : "";
    const thinkingEffort = typeof value.thinkingEffort === "string" && getThinkingEfforts({ mode, modelId }).includes(value.thinkingEffort) ? value.thinkingEffort : "";
    return { mode, modelId, thinkingEffort };
  };
  const agentModelSettings = (agent) => modelSettings({
    mode: modeOf(agent?.model?.provider),
    modelId: agent?.model?.modelId,
    thinkingEffort: agent?.thinkingLevel
  });
  /** Subagent "fast": the row's preference if listed, else a small-looking model, else the first. */
  const fastModelOf = (mode, list) => {
    const preferred = rowOf(mode)?.fastModel(list);
    return (preferred !== void 0 ? list.find((model) => model.id === preferred) : void 0)
      ?? list.find((model) => FAST_PATTERN.test(model.id)) ?? list[0];
  };
  return Object.freeze({
    rows: Object.freeze(table),
    modes: Object.freeze(table.map((row) => row.mode)),
    rowOf,
    modeOf,
    providerIdOf,
    catalogModel,
    getThinkingEfforts,
    thinkingFor,
    modelSettings,
    agentModelSettings,
    fastModelOf
  });
}
