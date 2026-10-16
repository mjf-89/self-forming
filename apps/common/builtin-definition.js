// Runtime definition shell of a built-in plugin, from its plugin.json in the generated
// registry (builtin-plugins.js): id, version, reload, essential, provides, requires, uses.
// The engines (plugin-builtins.js, core-agent-plugins.js and the dev tools module) add `setup`
// (and `name`/`unavailable` where they always did). A caller's own row without a registry
// entry (tests, forks) gets the `fallback` manifest fields instead. No library import.
import { builtinPlugin } from "./builtin-plugins.js";

const copy = (list) => (list ?? []).map(({ id, version, default: isDefault }) => ({ id, version, ...isDefault === true ? { default: true } : {} }));

/**
 * options.version: the definition version (default: the manifest's); options.provides:
 * replaces the manifest's provides (e.g. none while blocked); options.fallback: manifest
 * fields used when the id is not in the registry.
 */
export function definitionShell(id, { version, provides, fallback = {} } = {}) {
  const manifest = builtinPlugin(id)?.manifest ?? { id, ...fallback };
  return {
    id, version: version ?? manifest.version ?? "1.0.0", reload: manifest.reload ?? "page",
    ...manifest.essential ? { essential: true } : {},
    provides: copy(provides ?? manifest.provides), requires: copy(manifest.requires), uses: copy(manifest.uses)
  };
}
