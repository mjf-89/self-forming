// Subagents on pi-durable owned conversations (pi-mono packages/durable: README "Abort and Subagents",
// test/examples/22-subagent-foreground.ts and 23-subagent-background.ts). Provider-independent: models are chosen as
// "same", "fast" or "provider/modelId" and resolved by the host session.
//
// subagent run   (foreground): the call owns a child conversation, waits for its answer and returns it. Stop aborts it.
// subagent spawn (background): a named child owned by a background anchor task; each message is delivered by a
//   background reporter task that posts the answer back as a follow-up input. Survives Stop and app restarts.
import { Type } from "./library/pi-ai.js";
import { AgentDoc, AssistantEntry, InboxDoc, LiveDoc, configure, defineDoc, defineExtension, defineTask, defineTool } from "./library/pi-durable.js";

const NEVER = ["subagent", "app_update", "app_install_apk"]; // no nesting; only the main agent applies app revisions
const SECTIONS = ["device", "app", "selfRebuild", "subagents", "servers", "agentsGuide", "transcript"];
const copy = (value) => JSON.parse(JSON.stringify(value));

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function answerText(api, answer, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  return textOf(entry?.model?.[0]);
}

/** The recent user/assistant exchange of the main conversation, oldest first, at most ~6000 characters. */
async function transcriptText(api, context) {
  return api.commit(async (tx) => {
    const page = await tx.scanEntries({ conversationId: api.conversationId }, 40);
    const blocks = [];
    let size = 0;
    for (const record of page.items) {
      const entry = await tx.entry(record.id);
      const lines = [];
      for (const message of entry?.model ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = textOf(message).trim();
        if (text) lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text.slice(0, 600)}`);
      }
      if (!lines.length) continue;
      size += lines.join("\n").length;
      if (size > 6000) break;
      blocks.push(lines.join("\n"));
    }
    return blocks.reverse().join("\n") || "(no earlier messages)";
  }, context);
}

export function createSubagentExtensions({ getTool, toolNames, resolveModel, listModels, clampThinking, configurePrompt, abortTask, abortSubmission }) {
  let SubagentTools;

  const parentModel = async (api, context) => (await api.snapshot(AgentDoc, api.conversationId, context))?.model;

  /** Builds the child's pi.agent change from the requested model, thinking level, tools and context sections. */
  async function childSetup(api, context, { model, thinking, tools, sections, role, extra }) {
    const parent = await parentModel(api, context);
    const ref = await resolveModel(model, parent, context.abortSignal);
    const change = { extensions: { remove: [SubagentTools] } };
    if (ref) {
      change.model = ref;
      change.thinkingLevel = clampThinking(ref, thinking ?? "off") ?? "off";
    } else if (thinking) {
      change.thinkingLevel = clampThinking(parent, thinking) ?? thinking;
    }
    const available = toolNames().filter((name) => !NEVER.includes(name));
    if (tools) {
      const unknown = tools.filter((name) => !available.includes(name));
      if (unknown.length) throw new Error(`Tools not available to this subagent: ${unknown.join(", ")}. Available: ${available.join(", ")}.`);
      change.tools = tools.map(getTool).filter(Boolean);
    } else {
      change.tools = available.map(getTool).filter(Boolean);
    }
    const chosen = sections ?? ["device"];
    const unknownSections = chosen.filter((name) => !SECTIONS.includes(name));
    if (unknownSections.length) throw new Error(`Unknown context sections: ${unknownSections.join(", ")}. Use: ${SECTIONS.join(", ")}.`);
    const prompt = { sections: chosen };
    if (chosen.includes("transcript")) prompt.transcript = await transcriptText(api, context);
    change.instructions = [role, extra].filter(Boolean).join("\n\n");
    const label = ref ? `${ref.provider}/${ref.modelId}` : `same as main${parent ? ` (${parent.provider}/${parent.modelId})` : ""}`;
    return { change, prompt, label, tools: change.tools.map((tool) => tool.name) };
  }

  // Each invocation retains its admitted operation, independently of the tool result commit.
  const Operation = defineDoc({ kind: "self-forming.subagent-operation", version: 1, scope: "task", initial: () => ({}) });

  /** Foreground: a child owned by this tool call; returns its answer. */
  async function runChild(api, context, args) {
    let run = (await api.snapshot(Operation, api.taskId, context))?.run;
    if (!run) {
      const setup = await childSetup(api, context, {
        model: args.model, thinking: args.thinking, tools: args.tools, sections: args.context, extra: args.instructions,
        role: "You are a subagent helping the main assistant on the user's Android device. Do the task you are given and answer with a concise report of what you did and found. You cannot talk to the user."
      });
      run = await api.commit(async (tx) => {
        const operation = await tx.doc(Operation, api.taskId);
        if (operation.run) return copy(operation.run);
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, setup.change);
        await configurePrompt(tx, created.id, setup.prompt);
        operation.run = { conversationId: created.id, model: setup.label, tools: setup.tools };
        return copy(operation.run);
      }, context);
    }
    await api.details(run, context);
    const handle = await api.conversation(run.conversationId, context);
    const settled = await (await handle.submit({ type: "input", content: args.message, requestId: `subagent-run:${api.taskId}` }, context)).wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`The subagent did not finish (${settled.status}${settled.reason ? `: ${settled.reason}` : ""}).`);
    }
    return { ...run, text: await answerText(api, settled.answer, context) };
  }

  // ─── background subagents ──────────────────────────────────────────────────
  const Subagents = defineDoc({
    kind: "self-forming.subagents",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ agents: {}, reporters: {} })
  });

  const Anchor = defineTask({
    name: "self-forming.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context)
    },
    abort: (_anchor, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
  });

  const Reporter = defineTask({
    name: "self-forming.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { name, conversationId, message, followUp } = reporter.input;
        const agent = (await runtime.snapshot(Subagents, runtime.conversationId, context))?.agents[name];
        if (!agent || (agent.epoch ?? 0) !== (reporter.input.epoch ?? 0)) return finishReporter(reporter, runtime, context);
        if (agent.stopTask) await runtime.waitForTask(agent.stopTask, context);
        const subagent = await runtime.conversation(conversationId, context);
        const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer", requestId: `subagent:${reporter.id}` };
        const settled = await (await subagent.submit(request, context)).wait(context);
        await runtime.commit(async (tx) => {
          const next = (report) => ({ status: "running", checkpoint: { phase: "report", report } });
          if (settled.status === "unanswered") return next(settled.reason === "aborted" ? void 0 : `[subagent ${name} failed: ${settled.reason}]`);
          if (settled.type !== "input") return next();
          const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];
          if (!agent || (agent.epoch ?? 0) !== (reporter.input.epoch ?? 0) || agent.reported.includes(settled.answer)) return next();
          agent.reported.push(settled.answer);
          const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
          return next(`[subagent ${name} answered] ${textOf(answer)}`);
        }, context);
      },
      report: async (reporter, runtime, context) => {
        const report = reporter.state.checkpoint.report;
        const agent = (await runtime.snapshot(Subagents, runtime.conversationId, context))?.agents[reporter.input.name];
        if (report !== void 0 && agent && (agent.epoch ?? 0) === (reporter.input.epoch ?? 0)) {
          const main = await runtime.conversation(runtime.conversationId, context);
          await main.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `subagent-report:${reporter.id}` }, context);
        }
        await finishReporter(reporter, runtime, context);
      }
    },
    abort: (reporter, runtime, context) => finishReporter(reporter, runtime, context, "aborted")
  });

  async function finishReporter(reporter, runtime, context, status = "completed") {
    await runtime.commit(async (tx) => {
      const state = await tx.doc(Subagents, runtime.conversationId);
      for (const [call, id] of Object.entries(state.reporters)) if (id === reporter.id) delete state.reporters[call];
      return { status: "terminal", outcome: { status, result: null } };
    }, context);
  }

  // Stop captures the old inputs, drains their delivery tasks, then follows only those inputs across
  // generation handovers. A resumed Stop never aborts a newer, unrelated run of the same child.
  const Stop = defineTask({
    name: "self-forming.subagent-stop",
    version: 1,
    initial: () => ({ phase: "drain" }),
    phases: {
      drain: async (task, runtime, context) => {
        for (const id of task.input.reporters) {
          await abortTask(id, context);
          await runtime.waitForTask(id, context);
        }
        await runtime.commit(async (tx) => {
          const inputs = new Set(task.input.inputs);
          for (const id of task.input.reporters) {
            const submitted = await tx.submissionByRequest(task.input.conversationId, `subagent:${id}`);
            if (submitted) inputs.add(submitted.id);
          }
          return { status: "running", checkpoint: { phase: "cancel", inputs: [...inputs] } };
        }, context);
      },
      cancel: async (task, runtime, context) => {
        const inputs = task.state.checkpoint.inputs;
        for (const id of inputs) await abortSubmission(id, context, task.input.conversationId);
        for (;;) {
          const live = await runtime.snapshot(LiveDoc, task.input.conversationId, context);
          if (!live?.run?.inputs.some((id) => inputs.includes(id))) break;
          await abortTask(live.run.taskId, context);
          await runtime.waitForTask(live.run.taskId, context);
        }
        await runtime.commit(async (tx) => {
          const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[task.input.name];
          if (agent?.stopTask === task.id) delete agent.stopTask;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      }
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
  });

  const subagentTool = defineTool({
    name: "subagent",
    description: [
      "Delegate work to subagents, each with its own model, tools and context.",
      "Actions: run (message): a foreground helper; waits and returns its answer. spawn (name, message): a named background subagent that keeps working while you talk with the user; its answer arrives later as a new message starting with [subagent NAME answered]. send (name, message; followUp: true queues it after the current answer instead of steering). stop (name). status (name or all). models: list the models you can choose.",
      "Options for run and spawn: model: \"same\" (default, your model), \"fast\" (a smaller, cheaper model of your provider) or \"provider/modelId\" from the models action; match the model to the task's difficulty. thinking: off, minimal, low, medium, high. tools: tool names to allow (default: all yours except subagent, app_update and app_install_apk). context: sections of your instructions to give it: device (workspace and shell), app (editing this app), subagents, servers (manage_server), agentsGuide (the project guidelines from AGENTS.md: design, self-modification, safety; for app work), transcript (recent conversation with the user); default [device]. instructions: extra guidance appended to its instructions."
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union(["run", "spawn", "send", "stop", "status", "models"].map((value) => Type.Literal(value))),
      name: Type.Optional(Type.String({ maxLength: 60 })),
      message: Type.Optional(Type.String({ maxLength: 8000 })),
      followUp: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String({ maxLength: 120 })),
      thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high"].map((value) => Type.Literal(value)))),
      tools: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 40 })),
      context: Type.Optional(Type.Array(Type.Union(SECTIONS.map((value) => Type.Literal(value))), { maxItems: SECTIONS.length })),
      instructions: Type.Optional(Type.String({ maxLength: 4000 }))
    }),
    // Admission receipts and the separate Stop task make each action safe to resume.
    replay: "safe",
    async execute(args, api, context) {
      const { action, name, message, followUp } = args;
      const reply = (text, extra) => ({ content: [{ type: "text", text }], ...(extra ? { details: extra } : {}) });
      const operation = await api.snapshot(Operation, api.taskId, context);
      if (operation?.result) return operation.result;
      const finishStop = async (stop) => {
        const settled = await api.waitForTask(stop.taskId, context);
        if (settled.state.outcome.status !== "completed") throw new Error(`Stopping ${name} did not finish.`);
        return stop.result;
      };
      if (operation?.stop) return finishStop(operation.stop);
      if (action === "models") return reply(await listModels(await parentModel(api, context), context.abortSignal));
      if (action === "run") {
        if (!message) return reply("run needs a message.");
        const { text, ...details } = await runChild(api, context, args);
        return reply(`${text || "(no answer)"}\n\n[subagent model: ${details.model}]`, details);
      }
      const registry = await api.snapshot(Subagents, api.conversationId, context) ?? { agents: {}, reporters: {} };
      if (action === "status") {
        const names = name === void 0 ? Object.keys(registry.agents) : [name];
        const lines = [];
        for (const each of names) {
          const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : void 0;
          if (!found) continue;
          const busy = (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== void 0;
          lines.push(`${each}: ${busy ? "working" : "idle"} · ${found.model ?? "same as main"}${found.tools ? ` · tools: ${found.tools.join(", ")}` : ""}`);
        }
        return reply(lines.length ? lines.join("\n") : "No subagents.");
      }
      if (!name) return reply(`${action} needs a name.`);
      const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : void 0;
      if (action !== "spawn" && !agent) return reply(`No subagent named ${name}.`);
      if (action === "stop") {
        if (!abortTask || !abortSubmission) throw new Error("This session cannot stop subagents.");
        const stop = await api.commit(async (tx) => {
          const saved = await tx.doc(Operation, api.taskId);
          if (saved.stop) return copy(saved.stop);
          const state = await tx.doc(Subagents, api.conversationId);
          const current = state.agents[name];
          const live = await tx.doc(LiveDoc, current.conversationId);
          const inbox = await tx.doc(InboxDoc, current.conversationId);
          const reporters = [];
          for (const id of Object.values(state.reporters)) {
            const task = await tx.task(id);
            if (task?.input.name === name && task.state.status !== "terminal") reporters.push(id);
          }
          const inputs = [...live.run?.inputs ?? [], ...inbox.items.filter((item) => item.mode !== "write").map((item) => item.id)];
          current.epoch = (current.epoch ?? 0) + 1;
          const taskId = await tx.createTask(Stop, { name, conversationId: current.conversationId, reporters, inputs }, { ownership: { kind: "task", taskId: api.taskId } });
          current.stopTask = taskId;
          saved.stop = { taskId, result: reply(`Stopped ${name}.`, { name, conversationId: current.conversationId }) };
          return copy(saved.stop);
        }, context);
        return finishStop(stop);
      }
      if (!message) return reply(`${action} needs a message.`);
      if (action === "spawn" && agent) return reply(`${name} already exists; use send.`);
      const setup = action === "spawn" ? await childSetup(api, context, {
        model: args.model, thinking: args.thinking, tools: args.tools, sections: args.context, extra: args.instructions,
        role: `You are the subagent "${name}", working in the background for the main assistant on the user's Android device. Work on the main assistant's requests and answer each with a concise report of what you did and found. You cannot talk to the user.`
      }) : void 0;
      const result = await api.commit(async (tx) => {
        const operation = await tx.doc(Operation, api.taskId);
        if (operation.result) return copy(operation.result);
        const state = await tx.doc(Subagents, api.conversationId);
        const background = { ownership: { kind: "conversation" }, background: true };
        if (setup) {
          if (Object.hasOwn(state.agents, name)) {
            operation.result = reply(`${name} already exists; use send.`);
            return copy(operation.result);
          }
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          await configure(tx, child.id, setup.change);
          await configurePrompt(tx, child.id, setup.prompt);
          state.agents[name] = { conversationId: child.id, reported: [], model: setup.label, tools: setup.tools };
        }
        const current = state.agents[name];
        const { conversationId } = current;
        state.reporters[api.taskId] = await tx.createTask(Reporter, { name, conversationId, message, epoch: current.epoch ?? 0, followUp: action === "send" && followUp === true }, background);
        const text = setup ? `Started ${name} (model: ${setup.label}). Its answer will arrive as a new message.` : `Sent to ${name}. Its answer will arrive as a new message.`;
        operation.result = reply(text, { name, conversationId, model: current.model, tools: current.tools });
        return copy(operation.result);
      }, context);
      return result;
    }
  });
  SubagentTools = defineExtension({ name: "self-forming-subagents", tasks: [Anchor, Reporter, Stop], tools: [subagentTool] });

  return { SubagentTools, Subagents };
}
