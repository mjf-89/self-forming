// core-subagents: the `subagent` tool (docs/plugins.md §9a A5). Essential built-in agent
// row (order 35) contributing the whole permanent extension "self-forming-subagents"
// (tool subagent; task kinds self-forming.subagent-anchor/-reporter/-stop; doc kinds
// self-forming.subagents, self-forming.subagent-operation: subagents.js, unchanged
// behaviour). It reaches the session only through host.harness (agent.harness@1:
// models, tools, prompt, abortTask, abortSubmission) and builds with host.pi (the host's
// pi-durable/pi-ai, plugin-pi.js), never through session-engine internals.
// The implementation is built ONCE per session (keyed by its harness handle), so the
// bundled copy installed before the Harness opens and the runtime copy share the same
// task and tool objects: pending subagent tasks resume as before, no relaunch on swap.
// Same condition as before A5: sessions with an execution environment.
// Consumed by core-agent-plugins.js. No library import at module evaluation.
import { createSubagentExtensions } from "./subagents.js";

export const SUBAGENTS_EXTENSION = "self-forming-subagents";
export const SUBAGENT_TASK_KINDS = Object.freeze(["self-forming.subagent-anchor", "self-forming.subagent-reporter", "self-forming.subagent-stop"]);
// Additive drawer hook: a session that has subagents publishes archiveSubagent({commit, context, ownerId, conversationId,
// archive}) here (a stateless function over the caller's harness commit), so the conversations drawer can archive a
// subagent by the tool's own rule (refused while active) without importing this plugin. Absent: no subagents.
export const ARCHIVE_SLOT = Symbol.for("self-forming.subagents.archive@1");
const NO_ENV = "Subagents need an execution environment; this host has none.";

const built = new WeakMap(); // harness handle -> this session's {tools, tasks}
function partFor(host) {
  const harness = host.harness;
  if (!built.has(harness)) {
    const { SubagentTools, archiveSubagent } = createSubagentExtensions({
      getTool: (name) => harness.tools.get(name),
      toolNames: (agent) => harness.tools.names(agent),
      resolveModel: (spec, parent, signal) => harness.models.resolve(spec, parent, signal),
      listModels: (parent, signal) => harness.models.list(parent, signal),
      clampThinking: (ref, level) => harness.models.clampThinking(ref, level),
      configurePrompt: (tx, conversationId, selection) => harness.prompt.configure(tx, conversationId, selection),
      abortTask: (id, context) => harness.abortTask(id, context),
      abortSubmission: (id, context, conversationId) => harness.abortSubmission(id, context, conversationId)
    }, host.pi);
    built.set(harness, Object.freeze({ tools: SubagentTools.tools, tasks: SubagentTools.tasks, archiveSubagent }));
  }
  globalThis[ARCHIVE_SLOT] = built.get(harness).archiveSubagent;
  const part = built.get(harness);
  return { tools: [...part.tools], tasks: [...part.tasks] };
}

export const row = Object.freeze({
  extension: SUBAGENTS_EXTENSION, order: 35,
  unavailable: (caps, _hostInfo, host) => !caps.executionEnv ? NO_ENV
    : host && (!host.harness || !host.pi) ? "This session has no agent.harness@1 handle." : undefined,
  tools: () => ["subagent"],
  tasks: () => [...SUBAGENT_TASK_KINDS],
  create: (_builders, host) => host.env && host.harness && host.pi ? partFor(host) : null
});
