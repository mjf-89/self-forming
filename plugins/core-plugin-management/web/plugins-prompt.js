// core-plugin-management: the prompt section "plugins" (steers the agent to grow the app through plugins).
// A plugin-contributed section, the ordinary mechanism (docs/plugins.md §9a A3): the row's part carries
// {sections: [{key, render}]} next to the `plugins` tool, so it exists exactly where the tool exists. core-prompt only
// knows the NAME "plugins" (prompt-sections.js MAIN_PROMPT_SECTIONS / PROMPT_SECTIONS) so conversations and subagent
// `context` can select it; it renders nothing for it. No library import at module evaluation.
export const PLUGINS_SECTION_KEY = "plugins";

/** Browser host: web-only packages through the browser plugin host; otherwise the Android host (Kotlin halves too). */
export function pluginsVariant(hostInfo) {
  return hostInfo?.platform === "browser" || hostInfo?.capabilities?.nativePlugins === false ? "browser" : "android";
}

/** The section text for one variant; `cwd` is the conversation's working folder (the workspace root). */
export function pluginsText(variant, cwd) {
  const browser = variant === "browser";
  const lines = [
    `Grow this app through plugins: trusted code that adds services, contributions, settings sections, styles, agent extensions/tools and skills (web/skills/). A new feature is a new plugin: write it in ${cwd}/plugins/<id>, check it, install it with the plugins tool. It stays isolated, can be disabled or rolled back, and the built-ins remain as fallback.`,
    browser
      ? "Browser plugins are web-only (plugin.json + web/index.js): the browser plugin host stores an immutable copy and loads it on the next page load; a package with Kotlin/native parts is refused."
      : "A plugin may have a Kotlin half (native/): build and check it with scripts/plugin.sh build/check, call it from the web half with ctx.native.call. Native changes need an app restart; a built-in's Kotlin needs a new APK.",
    browser
      ? "To change existing behaviour edit the built-in that owns it in the live copy (app_update info gives sourcePath; builtin/<id>/web/). Its implementation lives in plugins/<id>/; keep it there. The safety net is the host's revision restore (previous revision), not a bundled copy: both use the same file."
      : "To change existing behaviour edit the built-in that owns it: its implementation lives in plugins/<id>/ (keep it there), in the repository and in the live copy. The safety net there is the host's revision restore (previous revision), not the bundled copy: both paths use the same file.",
    "Check and test first, then install or apply. Never claim a plugin is active without checking its state (plugins list).",
    `Before building a plugin read ${cwd}/self-forming/skills/plugins/SKILL.md${browser ? " (parts marked Android do not apply here)" : ""}.`
  ];
  return lines.join("\n");
}

/**
 * This session's `plugins` section (core-plugin-management). Shown when the conversation has the plugins tool and
 * selects the section: the main conversation by default (MAIN_PROMPT_SECTIONS), helpers when their `context` names
 * it; an old helper (instructions, no selection) keeps the prompt it was given (same rule as prompt-sections.js).
 */
export function pluginsSection(builders, host) {
  const { PromptSelectionDoc, MAIN_PROMPT_SECTIONS } = builders;
  const variant = pluginsVariant(host.hostInfo);
  return {
    key: PLUGINS_SECTION_KEY,
    async render(input, context) {
      if (!input.agent.tools.some((tool) => tool.name === "plugins")) return;
      const selected = PromptSelectionDoc ? await input.read.snapshot(PromptSelectionDoc, input.conversationId, context) : null;
      const chosen = selected?.sections ?? (input.agent.instructions?.trim() ? [] : MAIN_PROMPT_SECTIONS ?? [PLUGINS_SECTION_KEY]);
      if (!chosen.includes(PLUGINS_SECTION_KEY)) return;
      const cwd = input.env?.cwd ?? input.agent.cwd ?? host.env?.cwd;
      return pluginsText(variant, cwd);
    }
  };
}
