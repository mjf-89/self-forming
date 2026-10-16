// Bundles (docs/plugins.md §9b2): named, versioned lists of plugin ids that Settings →
// Plugins shows as one row. Plain data plus helpers: a bundle carries no code and adds
// no dependency semantics; the runtime still resolves, gates and falls back per plugin.
// Ids that do not exist (yet) are simply absent; plugins in no bundle stay individual.
// An id ending in "*" matches every plugin id with that prefix (e.g. core-providers-*).

export const PLUGIN_BUNDLES = Object.freeze([
  Object.freeze({
    id: "self-forming-core", label: "self-forming-core", version: "1.0.0",
    // What every conversation runs on: sessions, chat, drawer, models, secrets, prompt, skills, file/shell tools, execution, network, storage.
    plugins: Object.freeze(["core-agent", "core-chat", "core-conversations", "core-providers-*", "core-secrets", "core-prompt", "core-skills", "core-workspace-tools", "core-tools", "core-execution", "exec-js", "exec-linux", "core-git", "core-net-native", "core-net-page", "core-storage"])
  }),
  Object.freeze({
    id: "self-forming-tools", label: "self-forming-tools", version: "1.0.0",
    // Optional extras a fork can leave out (self-modification, background work, delegation).
    // core-toolchain: the Android build tools install (C4).
    plugins: Object.freeze(["core-self-update", "core-plugin-management", "core-servers", "core-subagents", "core-toolchain"])
  }),
  Object.freeze({
    id: "self-forming-net", label: "self-forming-net", version: "1.0.0",
    // Optional network routes over libs/cors-rot (N3): more providers of net.fetch@1, started only when selected in Settings → Providers.
    plugins: Object.freeze(["net-tor", "net-tailscale"])
  }),
  Object.freeze({
    id: "self-forming-look", label: "self-forming-look", version: "1.0.0",
    // The look of an edition (T2): ordinary plugins that only contribute styles; the last one present is used.
    plugins: Object.freeze(["look-*"])
  }),
]);

function matches(pattern, id) {
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : pattern === id;
}

/** The first bundle (in table order) that lists this plugin id, or null. */
export function bundleOf(id, bundles = PLUGIN_BUNDLES) {
  if (typeof id !== "string") return null;
  return bundles.find((bundle) => bundle.plugins.some((pattern) => matches(pattern, id))) ?? null;
}

/**
 * Splits rows ({id, ...}) into display entries, keeping the rows' order:
 * {bundle, rows} for each bundle with at least one present member (placed where its
 * first member was), {row} for each plugin in no bundle. Unknown/absent ids are ignored.
 */
export function groupByBundle(rows, bundles = PLUGIN_BUNDLES) {
  const entries = [];
  const byBundle = new Map();
  for (const row of rows ?? []) {
    const bundle = bundleOf(row?.id, bundles);
    if (!bundle) { entries.push({ row }); continue; }
    let entry = byBundle.get(bundle.id);
    if (!entry) { entry = { bundle, rows: [] }; byBundle.set(bundle.id, entry); entries.push(entry); }
    entry.rows.push(row);
  }
  return entries;
}

/** "N · all active" or "N · K not active" for a bundle's members. */
export function bundleSummary(count, notActive) {
  return notActive ? `${count} · ${notActive} not active` : `${count} · all active`;
}
