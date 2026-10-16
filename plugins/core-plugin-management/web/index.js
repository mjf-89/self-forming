// core-plugin-management: the `plugins` agent tool (docs/plugins.md §9a A2). Essential
// built-in agent row, merged into the permanent extension "self-forming-native" (order
// 30). Also contributes the app's own plugins skill: single source web/skills/plugins/SKILL.md (scripts/gen-builtins.sh derives
// skills/plugins/SKILL.md for the Android source tree and plugins-skill-text.js). Android reads it at
// self-forming/skills/plugins/SKILL.md (SelfSource); the browser has no source tree, so create() seeds the text into
// <workspace>/.skills/core-plugin-management/plugins/SKILL.md (the plugin-skill folder layout). Consumed by core-agent-plugins.js.
// N1: also the generic Settings → Providers section (providers-settings.js, settings.sections key "providers", slot
// "providers" → #providers-panel): one selector for every service with several providers (the page gives the runtime's
// selection/subscribe through serve's third argument).
// Also (S1c) contributes the Settings → Plugins screen (plugin-settings.js, markup in
// plugins-panel.js) as settings.sections key "plugins", slot "plugins" (#plugins-panel), from the
// row's serve(). app.js mounts the same nodes as the bundled fallback (mountBundled) and wires them
// (initPluginSettings), so the screen exists even when composition fails. This file must not
// import plugin-settings.js (it imports the registry, which imports this file).
import { section, PLUGINS_SLOT, PLUGINS_PANEL_ID } from "./plugins-panel.js";
import { providersSection, providerSlot, providerSlotName, section as providersPanel, PROVIDERS_SLOT, PROVIDERS_PANEL_ID } from "./providers-settings.js";
import { mountBundledPanel } from "../../../provider-panels.js";
import { pluginsSection, PLUGINS_SECTION_KEY, pluginsVariant, pluginsSkillPath } from "./plugins-prompt.js";
import SKILL_TEXT from "./plugins-skill-text.js";

// Equals settings-sections.js SETTINGS_SECTIONS (declared statically, like core-secrets).
const SETTINGS_SECTIONS = "settings.sections";
export const SECTION_KEY = "plugins";

export const PROVIDERS_KEY = "providers";
export { providerSlot, providerSlotName, providersSection };
export { section, PLUGINS_SLOT, PLUGINS_PANEL_ID, PROVIDERS_SLOT, PROVIDERS_PANEL_ID };

/** Bundled fallback: the Plugins nodes into #plugins-panel unless already attached. */
export const mountBundled = (doc = document) => mountBundledPanel(section, doc);
/** Bundled fallback of Settings → Providers: its (empty, hidden) node into #providers-panel; rows come with the runtime. */
export const mountBundledProviders = (doc = document) => mountBundledPanel(providersPanel, doc);

const NO_SHELL = "Offered only with the file and shell tools; this host has no execution environment.";
// Name and description equal the SKILL.md frontmatter.
const skillDefinition = (path) => Object.freeze({ name: "plugins", description: "Create, check and compile trusted web/Kotlin plugins without rebuilding the APK", path });
export const PLUGINS_SKILL = skillDefinition(pluginsSkillPath("android"));
export const PLUGINS_SKILL_BROWSER = skillDefinition(pluginsSkillPath("browser"));

/** Browser: write the skill text where the prompt names it (no source tree to unpack). Best effort; replaces a stale copy. */
export async function seedPluginsSkill(env, path = PLUGINS_SKILL_BROWSER.path) {
  const base = String(env?.cwd ?? "").replace(/\/+$/, "");
  if (!base || typeof env.writeFile !== "function") return false;
  const file = `${base}/${path}`;
  try {
    const current = typeof env.readTextFile === "function" ? await env.readTextFile(file, {}) : undefined;
    if (current?.ok && current.value === SKILL_TEXT) return true;
    await env.createDir?.(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    const written = await env.writeFile(file, new TextEncoder().encode(SKILL_TEXT), {});
    return !(written && written.ok === false);
  } catch { return false; }
}

export const row = Object.freeze({
  extension: "self-forming-native", order: 30,
  unavailable: (caps) => !caps.executionEnv ? NO_SHELL : caps.plugins ? undefined : "This host cannot install plugins.",
  tools: () => ["plugins"],
  // The prompt section "plugins" (plugins-prompt.js) lives next to the tool; core-prompt only knows its name for selection.
  sections: () => [PLUGINS_SECTION_KEY],
  // Offered wherever plugins can be installed; its Android-only parts (Kotlin, scripts/plugin.sh) are marked in the skill.
  skills: (caps) => caps.plugins ? [caps.nativePlugins === false ? PLUGINS_SKILL_BROWSER : PLUGINS_SKILL] : [],
  serve: (ctx, _builders, page = {}) => {
    ctx.contribute(SETTINGS_SECTIONS, SECTION_KEY, section, 20);
    ctx.contribute(SETTINGS_SECTIONS, PROVIDERS_KEY, providersSection(page), 25);
  },
  load: () => import("./plugin-tool.js"),
  create: (builders, host) => host.env && host.pluginHost ? (pluginsVariant(host.hostInfo) === "browser" && void seedPluginsSkill(host.env), { tools: [builders.pluginManagementTool(host.pluginHost, pluginsVariant(host.hostInfo))], sections: [pluginsSection(builders, host)] }) : null
});
