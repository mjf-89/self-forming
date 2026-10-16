// plugins/core-subagents/web/subagents.js (formerly apps/common/subagents.js, step A5).
// The subagent tool and its durable tasks/doc. No library import: pi-durable/pi-ai come
// from the host's pi bag (plugin-pi.js pluginPi, given as host.pi), the session through
// the agent.harness@1 handle (mapped to the options below in index.js).
var NEVER = ["subagent", "app_update", "app_install_apk"];
var SECTIONS = ["device", "app", "selfRebuild", "subagents", "servers", "plugins", "agentsGuide", "transcript"];
var copy = (value) => JSON.parse(JSON.stringify(value));
function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}
async function answerText(api, answer, context, { AssistantEntry }) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  return textOf(entry?.model?.[0]);
}
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
      if (size > 6e3) break;
      blocks.push(lines.join("\n"));
    }
    return blocks.reverse().join("\n") || "(no earlier messages)";
  }, context);
}
function createSubagentExtensions({ getTool, toolNames, resolveModel, listModels, clampThinking, configurePrompt, abortTask, abortSubmission }, pi) {
  const { Type, AgentDoc, AssistantEntry, InboxDoc, LiveDoc, configure, defineDoc, defineExtension, defineTask, defineTool } = pi;
  let SubagentTools;
  const parentModel = async (api, context) => (await api.snapshot(AgentDoc, api.conversationId, context))?.model;
  // A child starts as a copy of its owner's pi.agent; configure() replaces the whole
  // extensions field, so keep the owner's plugin exclusions and only drop subagents.
  function inheritedExtensions(stored) {
    const named = (names) => names.filter((name) => name !== SubagentTools.name).map((name) => ({ name }));
    if (Array.isArray(stored)) return named(stored);
    const add = named(stored?.add ?? []);
    return { ...add.length ? { add } : {}, remove: [SubagentTools, ...named(stored?.remove ?? [])] };
  }
  async function childSetup(api, context, { model, thinking, tools, sections, role, extra }) {
    const owner = await api.snapshot(AgentDoc, api.conversationId, context);
    const parent = owner?.model;
    const ref = await resolveModel(model, parent, context.abortSignal);
    const change = { extensions: inheritedExtensions(owner?.extensions) };
    if (ref) {
      change.model = ref;
      change.thinkingLevel = clampThinking(ref, thinking ?? "off") ?? "off";
    } else if (thinking) {
      change.thinkingLevel = clampThinking(parent, thinking) ?? thinking;
    }
    const available = toolNames(owner ?? {}).filter((name) => !NEVER.includes(name));
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
  const Operation = defineDoc({ kind: "self-forming.subagent-operation", version: 1, scope: "task", initial: () => ({}) });
  // The archive rule, shared by the `subagent` tool and the drawer (archiveSubagent below): a registry-entry flag on the
  // owner's self-forming.subagents doc. Archiving is refused while the subagent is active: a run in its pi.live, input
  // waiting in its pi.inbox (queued writes are not work), a reporter still delivering to it or reporting its answer, or a
  // stop task that has not finished. Returns {error} | {text, details?, changed}; runs inside the caller's commit.
  async function setArchived(tx, ownerId, name, archive) {
    const state = await tx.doc(Subagents, ownerId);
    const current = Object.hasOwn(state.agents, name) ? state.agents[name] : void 0;
    if (!current) return { error: `No subagent named ${name} among the ones you spawned.` };
    if (!archive) {
      if (!current.archived) return { text: `${name} is not archived.`, changed: false };
    } else {
      if (current.archived) return { text: `${name} is already archived.`, changed: false };
      const live = await tx.doc(LiveDoc, current.conversationId);
      const inbox = await tx.doc(InboxDoc, current.conversationId);
      const reasons = [];
      if (live.run !== void 0) reasons.push("it is working");
      if (inbox.items.some((item) => item.mode !== "write")) reasons.push("it has queued input");
      for (const id of Object.values(state.reporters)) {
        const task = await tx.task(id);
        if (task?.input.name === name && task.state.status !== "terminal") {
          reasons.push("a message to it or its report is still in progress");
          break;
        }
      }
      if (current.stopTask !== void 0) {
        const task = await tx.task(current.stopTask);
        if (task && task.state.status !== "terminal") reasons.push("it is still being stopped");
      }
      if (reasons.length) return { error: `Cannot archive ${name} while it is active (${reasons.join("; ")}). Wait for its answer, or stop it and let the stop finish, then archive.` };
    }
    if (archive) current.archived = true;
    else delete current.archived;
    return {
      text: archive ? `Archived ${name}. It is hidden from the conversation list under Archived; send to it or unarchive to bring it back.` : `Unarchived ${name}.`,
      details: { name, conversationId: current.conversationId },
      changed: true
    };
  }
  // Drawer entry (additive; reached through index.js, see ARCHIVE_SLOT): archives/unarchives the subagent whose chat is
  // `conversationId` among the ones `ownerId` spawned, by the same rule. Throws the rule's message when refused.
  // `commit` is the caller's commit(fn, context) over the session.
  async function archiveSubagent({ commit, context, ownerId, conversationId, archive }) {
    const outcome = await commit(async (tx) => {
      const state = await tx.doc(Subagents, ownerId);
      const name = Object.keys(state.agents).find((each) => state.agents[each]?.conversationId === conversationId);
      if (name === void 0) return { error: "This chat is not a subagent that can be archived." };
      const done = await setArchived(tx, ownerId, name, archive !== false);
      return done.error ? { error: done.error } : { text: done.text };
    }, context);
    if (outcome.error) throw new Error(outcome.error);
    return outcome.text;
  }
  async function runChild(api, context, args) {
    let run = (await api.snapshot(Operation, api.taskId, context))?.run;
    if (!run) {
      const setup = await childSetup(api, context, {
        model: args.model,
        thinking: args.thinking,
        tools: args.tools,
        sections: args.context,
        extra: args.instructions,
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
    return { ...run, text: await answerText(api, settled.answer, context, pi) };
  }
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
          const agent2 = (await tx.doc(Subagents, runtime.conversationId)).agents[name];
          if (!agent2 || (agent2.epoch ?? 0) !== (reporter.input.epoch ?? 0) || agent2.reported.includes(settled.answer)) return next();
          agent2.reported.push(settled.answer);
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
        for (; ; ) {
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
      "Actions: run (message): a foreground helper; waits and returns its answer. spawn (name, message): a named background subagent that keeps working while you talk with the user; its answer arrives later as a new message starting with [subagent NAME answered]. send (name, message; followUp: true queues it after the current answer instead of steering). stop (name: aborts its current work only; the subagent stays and can get more messages). archive (name): hide a subagent you spawned from the conversation list once it is done; it must be idle, so stop it first and wait for its answer. unarchive (name). Sending a message to an archived subagent unarchives it. status (name or all; archived ones are marked). models: list the models you can choose.",
      `Options for run and spawn: model: "same" (default, your model), "fast" (a smaller, cheaper model of your provider) or "provider/modelId" from the models action; match the model to the task's difficulty. thinking: off, minimal, low, medium, high. tools: tool names to allow (default: all yours except subagent, app_update and app_install_apk). context: sections of your instructions to give it: device (workspace and shell), app (editing this app), subagents, servers (manage_server), plugins (grow the app through plugins; needs the plugins tool), agentsGuide (the project guidelines from AGENTS.md: design, self-modification, safety; for app work), transcript (recent conversation with the user); default [device]. instructions: extra guidance appended to its instructions.`
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union(["run", "spawn", "send", "stop", "archive", "unarchive", "status", "models"].map((value) => Type.Literal(value))),
      name: Type.Optional(Type.String({ maxLength: 60 })),
      message: Type.Optional(Type.String({ maxLength: 8e3 })),
      followUp: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String({ maxLength: 120 })),
      thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high"].map((value) => Type.Literal(value)))),
      tools: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 40 })),
      context: Type.Optional(Type.Array(Type.Union(SECTIONS.map((value) => Type.Literal(value))), { maxItems: SECTIONS.length })),
      instructions: Type.Optional(Type.String({ maxLength: 4e3 }))
    }),
    // Admission receipts and the separate Stop task make each action safe to resume.
    replay: "safe",
    async execute(args, api, context) {
      const { action, name, message, followUp } = args;
      const reply = (text, extra) => ({ content: [{ type: "text", text }], ...extra ? { details: extra } : {} });
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
        return reply(`${text || "(no answer)"}

[subagent model: ${details.model}]`, details);
      }
      const registry = await api.snapshot(Subagents, api.conversationId, context) ?? { agents: {}, reporters: {} };
      if (action === "status") {
        // `all` (or no name) lists every registered subagent, archived ones included (marked); a subagent actually
        // named "all" is still found by its name.
        const every = name === void 0 || name.toLowerCase() === "all" && !Object.hasOwn(registry.agents, name);
        const names = every ? Object.keys(registry.agents) : [name];
        const lines = [];
        for (const each of names) {
          const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : void 0;
          if (!found) continue;
          const busy = (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== void 0;
          lines.push(`${each}: ${busy ? "working" : "idle"} \xB7 ${found.model ?? "same as main"}${found.tools ? ` \xB7 tools: ${found.tools.join(", ")}` : ""}${found.archived ? " \xB7 archived" : ""}`);
        }
        return reply(lines.length ? lines.join("\n") : every ? "No subagents." : `No subagent named ${name}.`);
      }
      if (!name) return reply(`${action} needs a name.`);
      const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : void 0;
      if ((action === "archive" || action === "unarchive") && !agent) throw new Error(`No subagent named ${name} among the ones you spawned.`);
      if (action !== "spawn" && !agent) return reply(`No subagent named ${name}.`);
      if (action === "archive" || action === "unarchive") {
        const outcome = await api.commit(async (tx) => {
          const saved = await tx.doc(Operation, api.taskId);
          if (saved.result) return { result: copy(saved.result) };
          const done = await setArchived(tx, api.conversationId, name, action === "archive");
          if (done.error) return { error: done.error };
          if (!done.changed) return { result: reply(done.text) };
          saved.result = reply(done.text, done.details);
          return { result: copy(saved.result) };
        }, context);
        if (outcome.error) throw new Error(outcome.error);
        return outcome.result;
      }
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
        model: args.model,
        thinking: args.thinking,
        tools: args.tools,
        sections: args.context,
        extra: args.instructions,
        role: `You are the subagent "${name}", working in the background for the main assistant on the user's Android device. Work on the main assistant's requests and answer each with a concise report of what you did and found. You cannot talk to the user.`
      }) : void 0;
      const result = await api.commit(async (tx) => {
        const operation2 = await tx.doc(Operation, api.taskId);
        if (operation2.result) return copy(operation2.result);
        const state = await tx.doc(Subagents, api.conversationId);
        const background = { ownership: { kind: "conversation" }, background: true };
        if (setup) {
          if (Object.hasOwn(state.agents, name)) {
            operation2.result = reply(`${name} already exists; use send.`);
            return copy(operation2.result);
          }
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          await configure(tx, child.id, setup.change);
          await configurePrompt(tx, child.id, setup.prompt);
          state.agents[name] = { conversationId: child.id, reported: [], model: setup.label, tools: setup.tools };
        }
        const current = state.agents[name];
        const wasArchived = current.archived === true;
        // Messaging an archived subagent brings it back, in the same commit.
        if (wasArchived) delete current.archived;
        const { conversationId } = current;
        state.reporters[api.taskId] = await tx.createTask(Reporter, { name, conversationId, message, epoch: current.epoch ?? 0, followUp: action === "send" && followUp === true }, background);
        const text = setup ? `Started ${name} (model: ${setup.label}). Its answer will arrive as a new message.` : `Sent to ${name}${wasArchived ? " (unarchived)" : ""}. Its answer will arrive as a new message.`;
        operation2.result = reply(text, { name, conversationId, model: current.model, tools: current.tools });
        return copy(operation2.result);
      }, context);
      return result;
    }
  });
  SubagentTools = defineExtension({ name: "self-forming-subagents", tasks: [Anchor, Reporter, Stop], tools: [subagentTool] });
  return { SubagentTools, Subagents, archiveSubagent };
}
export {
  createSubagentExtensions
};
