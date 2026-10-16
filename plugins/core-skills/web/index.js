// core-skills: lists the Agent Skills a conversation may use (docs/plugins.md §9a A3b).
// Essential built-in agent row (order -5): adds the part with section "skills" to the
// permanent extension "self-forming-prompts", after the core sections. Consumed by
// core-agent-plugins.js. No library import at module evaluation.

import { skillsPart, SKILLS_SECTION_KEY } from "./skills-section.js";

export { SKILLS_SECTION_KEY };

export const row = Object.freeze({
  extension: "self-forming-prompts", order: -5,
  unavailable: () => undefined,
  tools: () => [],
  sections: () => [SKILLS_SECTION_KEY],
  create: (builders, host) => skillsPart(builders, host)
});
