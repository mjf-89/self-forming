// core-skills implementation (the skills section of the prompt, moved out of index.js in X2).
// No library import.
export const SKILLS_SECTION_KEY = "skills";

/**
 * This session's skills section (core-skills). Pi style: name, description and the
 * SKILL.md path of each skill the conversation may use (agent-extensions.js gives the
 * list through host.skills: essential skills, plus a plugin's skills while the
 * conversation selects that plugin); the agent reads a skill when a task matches.
 * Shown when the conversation has the read tool, for the main conversation and for
 * helpers created with a section selection; an old helper (instructions, no
 * selection) keeps the prompt it was given.
 */
export function skillsPart(builders, host) {
  const { PromptSelectionDoc } = builders;
  async function render(input, context) {
    if (!input.agent.tools.some((tool) => tool.name === "read")) return;
    if (input.agent.instructions?.trim() && PromptSelectionDoc) {
      const selected = await input.read.snapshot(PromptSelectionDoc, input.conversationId, context);
      if (!selected?.sections) return;
    }
    if (typeof host.skills !== "function") return;
    const extensions = new Set((input.agent.extensions ?? []).map((extension) => extension.name));
    const cwd = input.env?.cwd ?? input.agent.cwd ?? host.env?.cwd;
    const listed = await host.skills({ extensions, cwd });
    if (!listed.length) return;
    const flat = (text) => String(text).replace(/\s+/g, " ").trim();
    return [
      "Skills give you specialized instructions for particular tasks. When a task matches a skill's description, read its SKILL.md with the read tool before you start and follow it. Resolve relative paths in a skill against its folder (the directory containing SKILL.md).",
      ...listed.some((skill) => skill.packaged) ? ["Skills under .skills/ are read-only copies from installed plugins; change them in the plugin's source package, not there."] : [],
      "",
      ...listed.map((skill) => `- ${skill.name}: ${flat(skill.description)} (${skill.location})`)
    ].join("\n");
  }
  return { sections: [{ key: SKILLS_SECTION_KEY, render }] };
}
