// The host's own pi-durable/pi-ai exports for plugins (ctx.pi). Plugins build
// agent extensions with these exact objects and must not bundle another copy:
// a second pi-durable would bring its own task classes and TypeBox instance.
import {
  defineExtension,
  defineTool,
  defineTask,
  defineDoc,
  defineDocFamily,
  defineEntry,
  section,
  hook,
  wrapTool,
  wrapSection,
  GenerationTask,
  ToolTask,
  CompactionTask,
  AgentDoc,
  LiveDoc,
  InboxDoc,
  AssistantEntry,
  configure
} from "./library/pi-durable.js";
import {
  Type,
  createAssistantMessageEventStream,
  parseStreamingJson,
  calculateCost,
  resolveTranscript,
  resolveTranscriptTools,
  getDeclaredTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
  clampThinkingLevel,
  getSupportedThinkingLevels
} from "./library/pi-ai.js";

// pi-ai helpers for provider plugins (agent.providers), e.g. a ported stream API.
const ai = Object.freeze({
  createAssistantMessageEventStream,
  parseStreamingJson,
  calculateCost,
  resolveTranscript,
  resolveTranscriptTools,
  getDeclaredTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
  clampThinkingLevel,
  getSupportedThinkingLevels
});

// Shallow-frozen bag passed by identity; the library modules themselves stay fixed.
export const pluginPi = Object.freeze({
  defineExtension,
  defineTool,
  defineTask,
  defineDoc,
  defineDocFamily,
  defineEntry,
  section,
  hook,
  wrapTool,
  wrapSection,
  GenerationTask,
  ToolTask,
  CompactionTask,
  // A5 (additive): pi-durable's own docs/entries and configure(), for plugins that
  // create and configure conversations (core-subagents).
  AgentDoc,
  LiveDoc,
  InboxDoc,
  AssistantEntry,
  configure,
  Type,
  ai
});
