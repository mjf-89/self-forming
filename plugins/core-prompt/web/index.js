// core-prompt: the system prompt sections (docs/plugins.md §9a A3). Essential built-in
// agent row: it contributes the whole permanent extension "self-forming-prompts" built by
// prompt-sections.js (this folder, moved verbatim in X2) createPromptExtension. The row is consumed by
// core-agent-plugins.js (runtime definition and per-session bundled copy).
// No library import at module evaluation; the builders arrive through create(builders, host).

// Permanent identifiers (never rename): extension, doc kind self-forming.prompt-sections,
// section keys in prompt order (prompt-sections.js PROMPT_SECTIONS with its key mapping).
export const PROMPT_EXTENSION = "self-forming-prompts";
export const PROMPT_SECTION_KEYS = Object.freeze(["device", "app", "self-rebuild", "subagents", "servers", "agents-guide", "transcript"]);
// PromptSelectionDoc / subagent context names of the keys that differ.
const SELECTION_NAMES = Object.freeze({ "self-rebuild": "selfRebuild", "agents-guide": "agentsGuide" });

export const row = Object.freeze({
  extension: PROMPT_EXTENSION, order: -10,
  // Every host gets a system prompt; each section decides from the session's host and
  // the conversation's tools whether it has something to say.
  unavailable: () => undefined,
  tools: () => [],
  sections: () => PROMPT_SECTION_KEYS,
  load: () => import("./prompt-sections.js"),
  create: (builders, host) => promptPart(builders, host)
});

/**
 * This session's self-forming-prompts: exactly prompt-sections.js createPromptExtension
 * with the session's host (env, app revision, APK installer, project guide), plus one
 * section wrap per core key. A wrap leaves the core section itself untouched; when
 * another plugin explicitly replaced that key (agent-extensions.js replaces), it
 * applies this conversation's PromptSelectionDoc to the replacement as well, so a
 * helper that was not given e.g. "device" does not get a plugin's device section.
 */
function promptPart(builders, host) {
  if (typeof builders.createPromptExtension !== "function") throw new TypeError("core-prompt needs the prompt-sections.js builders");
  const { PromptExtension } = builders.createPromptExtension({
    nativeEnvironment: host.env, appRevision: host.appRevision, apkInstaller: host.apkInstaller, projectGuide: host.projectGuide ?? ""
  });
  const own = new Map((PromptExtension.sections ?? []).map((item) => [item.key, item]));
  const { PromptSelectionDoc, MAIN_PROMPT_SECTIONS } = builders;
  const gate = (key, replacement) => ({
    ...replacement,
    async render(input, context) {
      const selected = await input.read.snapshot(PromptSelectionDoc, input.conversationId, context);
      // Same rule as prompt-sections.js: null selection = old helper (instructions only) or main context.
      const chosen = selected?.sections ?? (input.agent.instructions?.trim() ? [] : MAIN_PROMPT_SECTIONS);
      return chosen.includes(SELECTION_NAMES[key] ?? key) ? replacement.render(input, context) : undefined;
    }
  });
  const wraps = PromptSelectionDoc && MAIN_PROMPT_SECTIONS ? [...own.keys()].map((key) => ({ section: key, wrap: (current) => current === own.get(key) ? current : gate(key, current) })) : [];
  return { name: PromptExtension.name, sections: [...own.values()], ...(PromptExtension.wraps?.length || wraps.length ? { wraps: [...PromptExtension.wraps ?? [], ...wraps] } : {}) };
}
