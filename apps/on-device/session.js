// apps/on-device/session.js
import { BACKGROUND_CONTEXT } from "./library/chord/context.js";
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  Type
} from "./library/pi-ai.js";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./library/pi-ai/providers/faux.js";
import { stream, streamSimple } from "./library/pi-ai/api/openai-responses.js";
import { OPENAI_MODELS } from "./library/pi-ai/providers/openai.models.js";
import { ANTHROPIC_MODELS } from "./library/pi-ai/providers/anthropic.models.js";
import { stream as streamClaude, streamSimple as streamClaudeSimple } from "./library/pi-ai/api/anthropic-messages.js";
import {
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  AgentDoc,
  LiveDoc
} from "./library/pi-durable.js";
import { SqliteStorage } from "./library/pi-durable/storage/sqlite.js";
import { nativeTools } from "./native-tools.js";
import { createAppUpdateHandoff } from "./app-update-handoff.js";
import { createSubagentExtensions } from "./subagents.js";
import { createReportAttribution } from "./report-attribution.js";
import { createServerExtension, SERVER_TASK_KIND } from "./servers.js";
import { createPromptExtension } from "./prompt-sections.js";
import { createRecoveryGate } from "./recovery.js";
import { safeModelErrorResponse } from "./model-error.js";
import { openNativeDatabase, createNativeFetch } from "./native-host.js";
import { createNativeWorkspace } from "./native-host.js";
import { MAX_ATTACHMENTS, prepareAttachment, attachmentUserContent, attachedUserPresentation } from "./attachments.js";
var context = BACKGROUND_CONTEXT;
var TAIL_ENTRIES = 100;
var TAIL_DEBOUNCE_MS = 120;
// Background history loading: older entries are read TAIL_ENTRIES at a time, pausing between pages.
var HISTORY_YIELD_MS = 150;
// A live refresh first reads only this many of the newest rows to find what was committed since the last read.
var REFRESH_ENTRIES = 16;
// How many of the oldest already-loaded entries are re-rendered when an older page arrives (tool previews need the call).
var HISTORY_RERENDER_ENTRIES = 8;
var DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
var CHATGPT_PROVIDER = "openai-chatgpt";
var OPENAI_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
var CLAUDE_MODELS = Object.values(ANTHROPIC_MODELS).map(({ id, name }) => ({ id, name }));
function catalogModel({ mode, modelId }) {
  if (mode === "claude") return Object.values(ANTHROPIC_MODELS).find((model) => model.id === (modelId || DEFAULT_CLAUDE_MODEL));
  if (mode === "openai" || mode === "chatgpt") return Object.values(OPENAI_MODELS).find((model) => model.id === (modelId || DEFAULT_OPENAI_MODEL));
}
function getThinkingEfforts(config) {
  const model = catalogModel(config);
  return model?.reasoning ? getSupportedThinkingLevels(model) : [];
}
function thinkingFor(model, requested) {
  if (requested !== void 0 && requested !== "" && !getSupportedThinkingLevels(model).includes(requested))
    throw new Error("Choose a thinking effort supported by this model.");
  return clampThinkingLevel(model, requested || "off");
}
var ThreadsDoc = defineDoc({
  kind: "self-forming.threads",
  version: 1,
  scope: "session",
  initial: () => ({ selectedId: ROOT_CONVERSATION_ID, nextThread: 1, threads: {} })
});
var AttachmentDoc = defineDocFamily({
  kind: "self-forming.attachment",
  version: 1,
  scope: "session",
  family: true,
  initial: (value) => value
});
function memoryWorkspace() {
  const files = /* @__PURE__ */ new Map();
  const normalize = (path) => {
    const parts = path.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
    if (path.startsWith("/") || parts.some((part) => part === "..") || path.includes(":")) {
      throw new Error("Choose a path inside the workspace.");
    }
    return parts.join("/");
  };
  return {
    async read(path) {
      const text = files.get(normalize(path));
      if (text === void 0) throw new Error("File not found.");
      return text;
    },
    async write(path, text) {
      const target = normalize(path);
      if (!target) throw new Error("A file name is required.");
      if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error("File is too large.");
      files.set(target, text);
    },
    async list(path = "") {
      const directory = normalize(path);
      const prefix = directory ? `${directory}/` : "";
      const entries = /* @__PURE__ */ new Map();
      for (const [file, text] of files) {
        if (!file.startsWith(prefix)) continue;
        const suffix = file.slice(prefix.length);
        const name = suffix.split("/")[0];
        const isDirectory = suffix.includes("/");
        entries.set(name, {
          name,
          path: `${prefix}${name}`,
          directory: isDirectory,
          size: isDirectory ? 0 : new TextEncoder().encode(text).byteLength
        });
      }
      return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
  };
}
function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function toolPresentation(name, callId, toolCalls) {
  const call = toolCalls.get(callId);
  if (!call || call.name !== name) return {};
  return argumentPresentation(name, call.arguments);
}
function argumentPresentation(name, args) {
  const value = name === "bash" ? args?.command : ["read", "write", "edit", "workspace_read", "workspace_write", "workspace_list"].includes(name) ? args?.path : void 0;
  if (typeof value !== "string") return {};
  const preview = Array.from(value.replace(/\s+/g, " ").trim());
  return preview.length ? { toolPreview: preview.length > 300 ? `${preview.slice(0, 299).join("")}\u2026` : preview.join("") } : {};
}
function displayMessage(message, id, pending = false, toolCalls = /* @__PURE__ */ new Map(), sender) {
  if (message.role === "system") return void 0;
  const attached = attachedUserPresentation(message);
  const text = attached?.text ?? textOf(message);
  const thinking = message.role === "assistant" && Array.isArray(message.content) ? message.content.filter((block) => block.type === "thinking" && !block.redacted && typeof block.thinking === "string").map((block) => block.thinking).filter(Boolean).join("\n\n") : "";
  if (message.role === "assistant" && !text && !thinking && !message.errorMessage) return void 0;
  return {
    id: message.role === "toolResult" && message.toolCallId ? `tool:${message.toolCallId}` : id,
    role: message.role === "toolResult" ? "tool" : message.role,
    ...message.role === "user" && sender ? { sender } : {},
    text: message.role === "assistant" && message.errorMessage ? `${text}${text ? "\n" : ""}${message.errorMessage}` : text,
    ...attached ? { attachments: attached.attachments } : {},
    ...message.role === "toolResult" ? {
      toolName: message.toolName,
      error: message.isError,
      ...toolPresentation(message.toolName, message.toolCallId, toolCalls)
    } : {},
    ...message.role === "assistant" ? { error: message.stopReason === "error" } : {},
    ...thinking ? { thinking } : {},
    ...pending ? { pending: true } : {}
  };
}
var byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function rememberCalls(calls, message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const block of message.content) if (block.type === "toolCall" && typeof block.id === "string") calls.set(block.id, block);
}
/**
 * Renders committed entries once (for the cache of older entries): registers all their tool calls in `calls`, then
 * returns the display messages of each entry by entry id.
 */
function renderEntries(entries, calls, senders) {
  for (const entry of entries) for (const message of entry.model ?? []) rememberCalls(calls, message);
  const rendered = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const list = [];
    for (const [index, message] of (entry.model ?? []).entries()) {
      const item = displayMessage(message, `${entry.id}:${index}`, false, calls, senders?.get(entry.id));
      if (item) list.push(item);
    }
    rendered.set(entry.id, list);
  }
  return rendered;
}
/**
 * Pure: turns a watch view into display messages. onMessage(message) sees every committed model message of the
 * entries it renders. A tail view also carries `older` = { messages, calls }, the already rendered messages (and tool
 * calls) of the entries older than its `recent` window; only `recent` and the live parts are rendered here.
 */
function renderMessages(view) {
  const live = view.docs["pi.live"] ?? {};
  const agent = view.docs["pi.agent"];
  const older = view.older;
  const recent = view.recent ?? view.entries;
  const messages = older ? older.messages.slice() : [];
  const local = /* @__PURE__ */ new Map();
  const toolCalls = older ? { get: (id) => local.get(id) ?? older.calls.get(id) } : local;
  for (const entry of recent) for (const message of entry.model ?? []) rememberCalls(local, message);
  rememberCalls(local, live.generation?.message);
  for (const entry of recent) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const rendered = displayMessage(message, `${entry.id}:${index}`, false, toolCalls, view.senders?.get(entry.id));
      if (rendered) messages.push(rendered);
    }
  }
  const partial = live.generation?.message;
  let visible = false;
  if (partial) {
    const rendered = displayMessage(partial, "partial", true, toolCalls);
    if (rendered) {
      messages.push(rendered);
      visible = true;
    }
    // Tool calls the model is still writing: one pending row each, previewed from the partial arguments.
    const blocks = Array.isArray(partial.content) ? partial.content : [];
    for (const [index, block] of blocks.entries()) {
      if (block?.type !== "toolCall") continue;
      messages.push({
        id: `partial-tool:${typeof block.id === "string" && block.id ? block.id : index}`,
        role: "tool",
        toolName: block.name,
        text: "writing\u2026",
        pending: true,
        ...argumentPresentation(block.name, block.arguments)
      });
      visible = true;
    }
  }
  let running = false;
  for (const tool of live.tools ?? []) {
    if (tool.status !== "done") {
      running = true;
      messages.push({
        id: `tool:${tool.callId}`,
        role: "tool",
        toolName: tool.name,
        ...toolPresentation(tool.name, tool.callId, toolCalls),
        text: tool.output ?? "Working\u2026",
        pending: true
      });
    }
  }
  // The model is working but nothing shows it yet (request start, or between steps).
  if (live.run !== void 0 && !visible && !running)
    messages.push({ id: "partial", role: "assistant", text: "Thinking\u2026", pending: true });
  const modelLabel = agent?.model?.provider && agent?.model?.modelId ? `${agent.model.provider}/${agent.model.modelId}` : "";
  return { messages, busy: live.run !== void 0, modelLabel };
}

// Android build tools (JDK, Gradle, SDK): installed in the background after the first start so the agent can rebuild the app.
// The Android SDK License is accepted on the user's behalf by this install (the welcome text says so and links to it).
var toolchainKnownReady = false;
var TOOLCHAIN_READY = "pi-android status 2>/dev/null | grep -q '^Android platform'";
var shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function toolchainStartCommand(workspace) {
  const dir = `${workspace}/.self-forming`;
  // Exit quietly when installed. Otherwise start one detached installer; `flock -n` makes a second start (or an install that is
  // already running) a no-op. The installer reuses verified downloads and finished tool folders, so a later start resumes it.
  return [
    `mkdir -p ${shellQuote(dir)}`,
    `${TOOLCHAIN_READY} && exit 0`,
    `nohup flock -n ${shellQuote(`${dir}/toolchain.lock`)} sh -c 'exec >"$1" 2>&1; pi-android install --accept-licenses && pi-android doctor' sh ${shellQuote(`${dir}/toolchain.log`)} </dev/null >/dev/null 2>&1 &`,
    "exit 0"
  ].join("\n");
}
async function runQuiet(env, command, timeout) {
  let timer;
  try {
    const pending = env.exec(command, { timeout }, context);
    pending.catch(() => {
    });
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), (timeout + 5) * 1000);
    });
    const result = await Promise.race([pending, limit]);
    return result.ok ? result.value.exitCode : void 0;
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
}
async function openAppSession(options = {}) {
  const nativeEnvironment = options.env;
  const workspace = options.workspace ?? (options.bridge ? createNativeWorkspace(options.bridge) : memoryWorkspace());
  const storage = options.storage ?? (options.bridge ? await SqliteStorage.open(await openNativeDatabase(options.bridge, options.databaseName ?? "self-forming")) : new MemoryStorage());
  const models = createModels();
  const demo = fauxProvider({
    api: "self-forming-offline",
    tokensPerSecond: options.demoTokensPerSecond ?? 100,
    tokenSize: { min: 4, max: 4 }
  });
  models.setProvider(demo.provider);
  const offlineStep = (transcript) => {
    demo.appendResponses([offlineStep]);
    let userIndex = -1;
    for (let i = transcript.messages.length - 1; i >= 0; i--) {
      if (transcript.messages[i]?.role === "user") {
        userIndex = i;
        break;
      }
    }
    const user = transcript.messages[userIndex];
    const attached = user ? attachedUserPresentation(user) : void 0;
    const text = attached ? [attached.text, `Attached files: ${attached.attachments.map((item) => item.name).join(", ")}.`].filter(Boolean).join("\n\n") : user ? textOf(user) : "Hello from Self Forming";
    const results = transcript.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
    const failed = results.find((result) => result.isError);
    if (failed) return fauxAssistantMessage(`The offline demo could not complete its file check: ${textOf(failed)}`);
    if (!results.some((result) => result.toolName === (nativeEnvironment ? "write" : "workspace_write"))) {
      return fauxAssistantMessage(fauxToolCall(
        nativeEnvironment ? "write" : "workspace_write",
        nativeEnvironment ? { path: "demo-note.txt", content: text } : { path: "demo-note.txt", text }
      ), { stopReason: "toolUse" });
    }
    const read = results.find((result) => result.toolName === (nativeEnvironment ? "read" : "workspace_read"));
    if (!read) return fauxAssistantMessage(fauxToolCall(nativeEnvironment ? "read" : "workspace_read", { path: "demo-note.txt" }), { stopReason: "toolUse" });
    return fauxAssistantMessage(`I saved your message to demo-note.txt and read it back:

${textOf(read)}

This is a scripted offline demo. The agent loop, file tools and conversation storage are real.`);
  };
  demo.setResponses([offlineStep]);
  const registry = createRegistry();
  const appUpdateHandoff = createAppUpdateHandoff((revision) => {
    options.appRevision?.onStaged?.(revision);
    publish();
  });
  const nativeExtension = nativeEnvironment ? nativeTools(options.appRevision, appUpdateHandoff.stage,
    globalThis.__piHostInfo?.capabilities?.secrets === true, nativeEnvironment.backgroundExecution, options.apkInstaller) : void 0;
  if (nativeExtension) registry.install(nativeExtension);
  let projectGuide = "";
  if (nativeEnvironment && options.appRevision && options.bridge) {
    try { projectGuide = String(await workspace.read("self-forming/AGENTS.md") ?? "").trim().slice(0, 40000); } catch { }
  }
  const { PromptExtension, configurePrompt } = createPromptExtension({
    nativeEnvironment, appRevision: options.appRevision, apkInstaller: options.apkInstaller, projectGuide
  });
  registry.install(PromptExtension);
  // Subagents (pi-durable owned conversations): `subagent` runs foreground (run) or background (spawn) helpers with
  // a chosen model, tools and context sections.
  let subagentExtensions = [];
  // Supervised background servers (tmux + a durable background task owned by the root conversation).
  const serverExtensions = nativeEnvironment ? [createServerExtension({
    rootConversationId: ROOT_CONVERSATION_ID,
    abortTask: (id, abortContext) => harness.abortTask(id, abortContext)
  })] : [];
  const allExtensions = () => [nativeExtension, ...subagentExtensions, ...serverExtensions].filter(Boolean);
  const getTool = (name) => {
    for (const extension of allExtensions()) {
      const tool = extension.tools?.find?.((candidate) => candidate.name === name);
      if (tool) return tool;
    }
    return void 0;
  };
  const toolNames = () => allExtensions().flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
  const { SubagentTools, Subagents } = createSubagentExtensions({
    getTool,
    toolNames,
    resolveModel: (spec, parent, signal) => resolveModel(spec, parent, signal),
    listModels: (parent, signal) => listModels(parent, signal),
    clampThinking: (ref, level) => clampThinking(ref, level),
    configurePrompt,
    abortTask: (id, abortContext) => harness.abortTask(id, abortContext),
    abortSubmission: (id, abortContext, conversationId) => harness.abortSubmission(id, abortContext, conversationId)
  });
  subagentExtensions = nativeEnvironment ? [SubagentTools] : [];
  for (const extension of [...subagentExtensions, ...serverExtensions]) registry.install(extension);
  registry.install(defineExtension({ name: "self-forming-workspace", tools: [
    defineTool({
      name: "workspace_read",
      description: "Read a UTF-8 text file in the private workspace.",
      parameters: Type.Object({ path: Type.String() }),
      replay: "safe",
      async execute({ path }) {
        return { content: [{ type: "text", text: await workspace.read(path) }] };
      }
    }),
    defineTool({
      name: "workspace_write",
      description: "Write a UTF-8 text file in the private workspace, replacing existing contents.",
      parameters: Type.Object({ path: Type.String(), text: Type.String() }),
      replay: "unsafe",
      executionMode: "sequential",
      async execute({ path, text }) {
        await workspace.write(path, text);
        return { content: [{ type: "text", text: `Saved ${path}` }] };
      }
    }),
    defineTool({
      name: "workspace_list",
      description: "List files in a directory of the private workspace.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      replay: "safe",
      async execute({ path }) {
        return { content: [{ type: "text", text: JSON.stringify(await workspace.list(path)) }] };
      }
    })
  ] }));
  let snapshot = {
    messages: [],
    busy: false,
    paused: false,
    anyBusy: false,
    owned: false,
    title: "Main",
    kind: "main",
    persistence: options.bridge ? "native" : "memory",
    mode: "offline",
    modelId: "faux-1"
  };
  const listeners = /* @__PURE__ */ new Set();
  if (options.onChange) listeners.add(options.onChange);
  const publish = () => {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
      }
    }
  };
  let lastError;
  let paused = false;
  let anyBusy = false;
  const recoveredModels = new Map();
  const authSubscriptions = [];
  const isActivityTask = (task) => task.record.kind !== SERVER_TASK_KIND;
  let activityTimer;
  let pollTimer;
  let activitySeq = 0;
  const ownedMeta = /* @__PURE__ */ new Map();
  const drafts = /* @__PURE__ */ new Map();
  let closed = false;
  const recovery = createRecoveryGate(() => {
    if (closed) return;
    paused = recovery.waiting.length > 0;
    snapshot = { ...snapshot, paused, recoveryProviders: recovery.waiting };
    publish();
  });
  let sending = false;
  let transitioning = false;
  let transitionPromise = Promise.resolve();
  let metadataTail = Promise.resolve();
  let metadata;
  const conversations = /* @__PURE__ */ new Map();
  const attachmentRecords = /* @__PURE__ */ new Map();
  async function loadDraftAttachments(id) {
    for (const key of metadata.threads[String(id)]?.attachments ?? []) {
      if (!attachmentRecords.has(key)) {
        const saved2 = await harness.snapshot(AttachmentDoc, key, context);
        if (!saved2?.attachment) throw new Error("A saved attachment is unavailable.");
        attachmentRecords.set(key, saved2);
      }
      const saved = attachmentRecords.get(key);
      if (!nativeEnvironment && typeof saved.text === "string")
        await workspace.write(saved.attachment.path, saved.text);
    }
  }
  async function reconcileDraftAttachments(view) {
    const id = view.conversation.id;
    const draftIds = metadata.threads[String(id)]?.attachments ?? [];
    if (!draftIds.length) return;
    const sent = /* @__PURE__ */ new Set();
    for (const entry of view.entries) for (const message of entry.model ?? [])
      for (const attachment of attachedUserPresentation(message)?.attachments ?? []) sent.add(attachment.id);
    if (!draftIds.some((key) => sent.has(key))) return;
    await harness.commit(async (tx) => {
      const state = await tx.doc(ThreadsDoc);
      state.threads[String(id)].attachments = draftIds.filter((key) => !sent.has(key));
    }, context);
    metadata = await harness.snapshot(ThreadsDoc, context);
  }
  const queueMetadata = (work) => {
    const pending = metadataTail.then(work);
    metadataTail = pending.catch(() => {
    });
    return pending;
  };
  let secret = "";
  let harness;
  try {
    harness = await Harness.open(storage, {
      models,
      registry,
      ...nativeEnvironment ? { env: () => nativeEnvironment } : {},
      settings: {
        ...nativeExtension ? { extensions: [PromptExtension, nativeExtension, ...subagentExtensions, ...serverExtensions] } : {},
        compaction: { enabled: true },
        progress: { partialIntervalMs: 60 }
      },
      onReport(error) {
        lastError = error instanceof Error ? error.message : String(error);
        snapshot = { ...snapshot, error: lastError };
        publish();
      }
    }, context);
  } catch (error) {
    try {
      await storage.close(context);
    } catch {
    }
    throw error;
  }
  let conversation;
  let watch;
  const reportTailError = (error) => {
    lastError = error instanceof Error ? error.message : String(error);
    if (closed) return;
    snapshot = { ...snapshot, error: lastError };
    publish();
  };
  // ---------- tail view: the newest TAIL_ENTRIES entries are read live; older ones load in the background ----------
  /**
   * Reads the newest active entries of a conversation (newest first) until at least TAIL_ENTRIES are collected and,
   * when stopAtId is given, until the oldest one is not newer than stopAtId (so a burst of commits leaves no gap).
   * Honours the head marker: the newest marker cuts off everything before its head. Returns the entries, the marker,
   * the cursor of the next older page and whether the whole active history was reached.
   */
  const readNewest = async (target, stopAtId) => {
    const picked = [];
    let marker;
    let cursor;
    let done = false;
    let newestRow;
    for (;;) {
      const page = await target.entries({}, TAIL_ENTRIES, cursor, context);
      newestRow ??= page.items[0]?.id;
      for (const entry of page.items) {
        if (entry.head !== void 0) {
          marker ??= entry;
          continue;
        }
        if (marker && entry.id < marker.head) {
          done = true;
          break;
        }
        picked.push(entry);
      }
      cursor = page.next;
      if (done || cursor === void 0) break;
      if (picked.length >= TAIL_ENTRIES && (stopAtId === void 0 || picked[picked.length - 1].id <= stopAtId)) break;
    }
    return { picked, marker, newestRow, cursor: done ? void 0 : cursor, exhausted: done || cursor === void 0 };
  };
  /**
   * Cheap live refresh: the entries committed after row `newestId` as { fresh: active entries newest first,
   * newestRow }, or undefined when the whole window has to be re-read (a head marker was committed, or too much
   * happened at once).
   */
  const readSince = async (target, newestId) => {
    const fresh = [];
    let cursor;
    let newestRow;
    for (;;) {
      const page = await target.entries({}, REFRESH_ENTRIES, cursor, context);
      newestRow ??= page.items[0]?.id;
      for (const entry of page.items) {
        if (entry.id <= newestId) return { fresh, newestRow: newestRow > newestId ? newestRow : newestId };
        if (entry.head !== void 0) return void 0;
        fresh.push(entry);
      }
      cursor = page.next;
      if (cursor === void 0 || fresh.length >= TAIL_ENTRIES) return void 0;
    }
  };
  /**
   * A watch-like handle ({ value, start(listener), stop() } plus refresh()/poke()) of a conversation's tail view:
   * { conversation, entries: all loaded entries oldest first, recent: the newest window (TAIL_ENTRIES) of them,
   *   older: { messages, calls } (rendered older entries, see renderMessages), truncated: older entries are not
   *   loaded yet, loadingHistory: the background loader is (still) running, docs: { "pi.live", "pi.agent" } }.
   * pi.live / pi.agent are watched; entry commits of the conversation are noticed through subscribeCommits. Changes
   * are re-read at most once per TAIL_DEBOUNCE_MS, and only the newest window is re-read (and merged with the cached
   * older entries) when an entry was committed. After start() the older history is loaded page by page in the
   * background (HISTORY_YIELD_MS apart) and the listener is called after each page; stop() ends the loader at once.
   */
  const openTail = async (target, onError, { history = true } = {}) => {
    const id = target.id;
    const record = conversations.get(id) ?? await storage.conversation(id, context);
    if (!record) throw new Error(`Conversation ${id} does not exist.`);
    const watchers = [];
    let value;
    let stopped = false;
    let started = false;
    let listener;
    let timer;
    let running = false;
    let again = false;
    let entriesDirty = true;
    let issued = 0;
    let appliedDocs = 0;
    let appliedEntries = 0;
    let unsubscribe;
    let schedule = () => {};
    const attribution = createReportAttribution(storage, context);
    let senderVersion = 0;
    let docsNow = {};
    // Entries: the newest window (re-read on every refresh) and the older ones (loaded once, never re-read).
    let windowEntries = [];
    let windowIds = /* @__PURE__ */ new Set();
    let windowMarker;
    let windowMarkerId;
    let newestRowId;
    let initialized = false;
    let olderEntries = [];
    const olderIds = /* @__PURE__ */ new Set();
    const rendered = /* @__PURE__ */ new Map();
    const calls = /* @__PURE__ */ new Map();
    let olderMessages = [];
    let olderDirty = false;
    let hist = { cursor: void 0, marker: void 0, done: false };
    let epoch = 0;
    let loaderRunning = false;
    let loaderFailed = false;
    let wake;
    const buildValue = () => {
      if (olderDirty) {
        olderMessages = olderEntries.flatMap((entry) => rendered.get(entry.id) ?? []);
        olderDirty = false;
      }
      return {
        conversation: record,
        entries: olderEntries.length ? olderEntries.concat(windowEntries) : windowEntries,
        recent: windowEntries,
        senders: attribution.senders,
        older: { messages: olderMessages, calls },
        truncated: !hist.done,
        loadingHistory: history && !hist.done && !loaderFailed && !stopped,
        docs: docsNow
      };
    };
    const addOlder = (entries) => {
      if (!entries.length) return;
      for (const [entryId, messages] of renderEntries(entries, calls, attribution.senders)) rendered.set(entryId, messages);
      for (const entry of entries) olderIds.add(entry.id);
      if (olderEntries.length && entries[0].id < olderEntries[olderEntries.length - 1].id)
        olderEntries = [...olderEntries, ...entries].sort(byId);
      else olderEntries = olderEntries.concat(entries);
      olderDirty = true;
    };
    /** Merges a freshly read newest window with the cached older entries (everything is deduplicated by entry id). */
    const applyWindow = (result) => {
      if (result.fresh) {
        // Incremental read: the new entries on top of the current window (same head marker as before).
        const merged = /* @__PURE__ */ new Map();
        for (const entry of result.fresh) merged.set(entry.id, entry);
        for (const entry of windowEntries) merged.set(entry.id, entry);
        result = { picked: [...merged.values()].sort((a, b) => byId(b, a)), marker: windowMarker, newestRow: result.newestRow };
      }
      if (newestRowId === void 0 || result.newestRow > newestRowId) newestRowId = result.newestRow;
      const newestFirst = result.picked;
      const next = newestFirst.slice(0, TAIL_ENTRIES).reverse();
      const markerId = result.marker?.id;
      if (!initialized || markerId !== windowMarkerId) {
        // First read, or the head marker changed (rewind): whatever was cached may no longer be active.
        initialized = true;
        windowMarker = result.marker;
        windowMarkerId = markerId;
        epoch++;
        olderEntries = [];
        olderIds.clear();
        rendered.clear();
        calls.clear();
        olderMessages = [];
        olderDirty = true;
        windowEntries = [];
        hist = { cursor: result.cursor, marker: result.marker, done: result.exhausted };
        wake?.();
      }
      const nextIds = new Set(next.map((entry) => entry.id));
      const oldest = next.length ? next[0].id : void 0;
      const fresh = /* @__PURE__ */ new Map();
      for (const entry of newestFirst.slice(TAIL_ENTRIES)) if (!olderIds.has(entry.id)) fresh.set(entry.id, entry);
      if (oldest !== void 0) for (const entry of windowEntries)
        if (!nextIds.has(entry.id) && entry.id < oldest && !olderIds.has(entry.id)) fresh.set(entry.id, entry);
      addOlder([...fresh.values()].sort(byId));
      windowEntries = next;
      windowIds = nextIds;
    };
    /** Prepends one page (newest first) of older history; returns nothing, updates hist. */
    const applyHistoryPage = (page) => {
      const items = [];
      let done = false;
      for (const entry of page.items) {
        if (entry.head !== void 0) {
          hist.marker ??= entry;
          continue;
        }
        if (hist.marker && entry.id < hist.marker.head) {
          done = true;
          break;
        }
        if (olderIds.has(entry.id) || windowIds.has(entry.id)) continue;
        items.push(entry);
      }
      hist.cursor = page.next;
      hist.done = done || page.next === void 0;
      items.reverse();
      if (!items.length) return;
      const previousOldest = olderEntries.slice(0, HISTORY_RERENDER_ENTRIES);
      addOlder(items);
      // Tool results right behind the page boundary may belong to calls of this page.
      for (const [entryId, messages] of renderEntries(previousOldest, calls, attribution.senders)) rendered.set(entryId, messages);
    };
    const loadSenders = async (entries) => {
      await attribution.load(entries, id);
      if (senderVersion !== attribution.version) {
        senderVersion = attribution.version;
        // Old entries keep their cached message objects between streaming ticks. Recreate them
        // when newly resolved durable provenance changes a sender, even if the text is unchanged.
        for (const [entryId, messages] of renderEntries(olderEntries, calls, attribution.senders)) rendered.set(entryId, messages);
        olderDirty = true;
      }
    };
    const nap = (ms) => new Promise((resolve) => {
      const finish = () => {
        clearTimeout(handle);
        if (wake === finish) wake = void 0;
        resolve();
      };
      const handle = setTimeout(finish, ms);
      wake = finish;
    });
    const yieldToUi = async () => {
      await nap(HISTORY_YIELD_MS);
      if (stopped || typeof requestIdleCallback !== "function") return;
      await new Promise((resolve) => {
        wake = resolve;
        requestIdleCallback(() => {
          if (wake === resolve) wake = void 0;
          resolve();
        }, { timeout: 1e3 });
      });
    };
    const startHistory = () => {
      if (!history || !started || stopped || loaderRunning || hist.done) return;
      loaderRunning = true;
      loaderFailed = false;
      const mine = epoch;
      void (async () => {
        try {
          while (!stopped && mine === epoch && !hist.done) {
            await yieldToUi();
            if (stopped || mine !== epoch) break;
            const page = await target.entries({}, TAIL_ENTRIES, hist.cursor, context);
            if (stopped || mine !== epoch) break;
            await loadSenders(page.items);
            if (stopped || mine !== epoch) break;
            applyHistoryPage(page);
            value = buildValue();
            try { await listener?.(value); } catch { }
          }
        } catch (error) {
          loaderFailed = true;
          if (!stopped) onError?.(error);
        } finally {
          loaderRunning = false;
          if (!stopped) {
            if (mine !== epoch && !loaderFailed) startHistory();
            else if (mine === epoch) {
              // Finished (loadingHistory drops) or failed (retried on the next refresh).
              value = buildValue();
              if (loaderFailed) try { await listener?.(value); } catch { }
            }
          }
        }
      })();
    };
    try {
      // Subscribe before the first snapshot: placement can happen while the provenance scan awaits storage.
      if (typeof harness.subscribeCommits === "function") unsubscribe = harness.subscribeCommits((publication) => {
        if (stopped) return;
        const changedSender = attribution.observe(publication);
        for (const change of publication.changes) {
          if (change.type === "entry" && change.value?.conversationId === id) entriesDirty = true;
        }
        if (changedSender || entriesDirty) schedule();
      });
      for (const Doc of [LiveDoc, AgentDoc]) {
        const docWatch = await harness.watchDoc(Doc, id, context);
        if (docWatch) watchers.push([Doc, docWatch]);
      }
      const read = async () => {
        const ticket = ++issued;
        const wantEntries = entriesDirty;
        entriesDirty = false;
        try {
          let result;
          if (wantEntries) {
            const newestId = windowEntries.length ? windowEntries[windowEntries.length - 1].id : void 0;
            const since = newestRowId !== void 0 && newestId !== void 0 ? await readSince(target, newestRowId) : void 0;
            result = since ?? await readNewest(target, newestId);
          }
          await loadSenders(result?.fresh ?? result?.picked ?? []);
          const docs = {};
          for (const Doc of [LiveDoc, AgentDoc]) {
            const watched = watchers.find(([candidate]) => candidate === Doc)?.[1];
            const current = watched?.value ?? (watched ? await harness.snapshot(Doc, id, context) : void 0);
            if (current) docs[Doc.definition.kind] = current;
          }
          if (result && ticket > appliedEntries) {
            appliedEntries = ticket;
            applyWindow(result);
          }
          if (ticket > appliedDocs) {
            appliedDocs = ticket;
            docsNow = docs;
          }
          value = buildValue();
        } catch (error) {
          if (wantEntries) entriesDirty = true;
          throw error;
        }
        if (loaderFailed) startHistory();
        return value;
      };
      value = await read();
      const run = async () => {
        timer = void 0;
        if (stopped) return;
        if (running) {
          again = true;
          return;
        }
        running = true;
        try {
          do {
            again = false;
            await read();
            if (!stopped) await listener?.(value);
          } while (again && !stopped);
        } catch (error) {
          if (!stopped) onError?.(error);
        } finally {
          running = false;
        }
      };
      schedule = () => {
        if (stopped || !started || timer) return;
        timer = setTimeout(run, TAIL_DEBOUNCE_MS);
      };
      const poke = () => {
        entriesDirty = true;
        schedule();
      };
      return {
        get value() {
          return value;
        },
        start(next) {
          if (started) throw new Error("Watch is already started");
          started = true;
          listener = next;
          for (const [, docWatch] of watchers) docWatch.start(async () => {
            if (typeof harness.subscribeCommits !== "function") entriesDirty = true;
            schedule();
          });
          schedule();
          startHistory();
        },
        poke,
        /** Re-reads now (entries included) and returns the newest view. */
        async refresh() {
          entriesDirty = true;
          return read();
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          timer = void 0;
          wake?.();
          try { unsubscribe?.(); } catch { }
          await Promise.allSettled(watchers.map(([, docWatch]) => docWatch.stop()));
        }
      };
    } catch (error) {
      stopped = true;
      try { unsubscribe?.(); } catch { }
      await Promise.allSettled(watchers.map(([, docWatch]) => docWatch.stop()));
      throw error;
    }
  };
  try {
    const main = await harness.root(context, { agent: {
      model: { provider: "faux", modelId: "faux-1" },
      ...nativeEnvironment ? { cwd: nativeEnvironment.cwd } : {},
      instructions: null
    } });
    let cursor;
    do {
      const page = await storage.scanConversations({}, 128, cursor, context);
      for (const record of page.items) if (!record.owner) conversations.set(record.id, record);
      cursor = page.next;
    } while (cursor);
    await harness.commit(async (tx) => {
      const state = await tx.doc(ThreadsDoc);
      for (const { id } of conversations.values()) {
        if (!state.threads[String(id)]) state.threads[String(id)] = {
          title: id === main.id ? "Main" : `Thread ${state.nextThread++}`,
          draft: ""
        };
      }
      if (!conversations.has(state.selectedId)) state.selectedId = main.id;
    }, context);
    metadata = await harness.snapshot(ThreadsDoc, context);
    // Resume all durable work through the scheduler. Only model authentication may wait;
    // a child generation is ordinary work inside its background owner's scope.
    const inspected = await harness.inspect(context);
    const activity = inspected.tasks.filter(isActivityTask);
    anyBusy = activity.length > 0 || inspected.submissions.length > 0;
    const recoveringConversations = new Set(inspected.submissions.map((item) => item.conversationId));
    for (const { record } of activity) {
      recoveringConversations.add(record.conversationId);
      if (record.kind === "self-forming.subagent-reporter" && record.input?.conversationId !== void 0)
        recoveringConversations.add(record.input.conversationId);
      const ref = record.state?.checkpoint?.model;
      if (ref?.provider && ref.modelId) recoveredModels.set(`${ref.provider}/${ref.modelId}`, ref);
    }
    for (const id of recoveringConversations) {
      const agent = await harness.snapshot(AgentDoc, id, context);
      if (agent?.model) recoveredModels.set(`${agent.model.provider}/${agent.model.modelId}`, agent.model);
    }
    // Existing main chats/threads receive named sections; legacy children retain their own saved instructions.
    for (const id of conversations.keys()) {
      await harness.commit(async (tx) => { await configurePrompt(tx, id, {}); }, context);
      await (await harness.conversation(id, context)).configure({ instructions: null,
        ...nativeEnvironment ? { cwd: nativeEnvironment.cwd } : {} }, context);
    }
    conversation = await harness.conversation(metadata.selectedId, context);
    await loadDraftAttachments(conversation.id);
    watch = await openTail(conversation, reportTailError);
    await reconcileDraftAttachments(watch.value);
  } catch (error) {
    try {
      await harness.close(context);
    } catch {
    }
    throw error;
  }
  const namedAgentsOf = async (parentId) => {
    try { return (await harness.snapshot(Subagents, parentId, context))?.agents ?? {}; } catch { return {}; }
  };
  /** Naming of an owned conversation, shared by tree() and the viewed conversation. */
  const ownedNaming = async (record, agentsFor = namedAgentsOf) => {
    const name = Object.entries(await agentsFor(record.owner.conversationId)).find(([, entry]) => entry?.conversationId === record.id)?.[0];
    if (name !== void 0) return { kind: "subagent", title: name };
    return { kind: "task", title: "Subagent" };
  };
  const kindOf = (id) => ownedMeta.get(id)?.kind ?? (id === ROOT_CONVERSATION_ID ? "main" : conversations.get(id)?.parent ? "fork" : "thread");
  const describe = (id, includeAttachments = false) => {
    const owner = ownedMeta.get(id);
    if (owner && !conversations.has(id)) return {
      id,
      title: owner.title,
      isMain: false,
      draft: drafts.get(id) ?? "",
      ...includeAttachments ? { attachments: [] } : {},
      ...owner.parentId !== void 0 ? { parentId: owner.parentId } : {}
    };
    const record = conversations.get(id);
    const saved = metadata.threads[String(id)];
    const parentId = record?.parent?.conversationId ?? saved?.parentId;
    return {
      id,
      title: saved?.title ?? (id === ROOT_CONVERSATION_ID ? "Main" : "Thread"),
      isMain: id === ROOT_CONVERSATION_ID,
      draft: saved?.draft ?? "",
      ...saved?.archived ? { archived: true } : {},
      ...includeAttachments ? { attachments: (saved?.attachments ?? []).map((key) => attachmentRecords.get(key)?.attachment).filter(Boolean) } : {},
      ...parentId !== void 0 ? { parentId } : {}
    };
  };
  const threadSnapshot = () => ({
    conversation: describe(conversation.id, true),
    threads: [...conversations.keys()].sort((a, b) => a - b).map((id) => describe(id))
  });
  const refreshMetadata = async () => {
    metadata = await harness.snapshot(ThreadsDoc, context);
    if (!closed) {
      snapshot = { ...snapshot, ...threadSnapshot() };
      publish();
    }
  };
  // ---------- global activity: is any conversation (viewed or not) running? ----------
  const refreshActivity = async () => {
    if (closed) return;
    const seq = ++activitySeq;
    let tasks = 0;
    let queued = 0;
    try {
      const inspected = await harness.inspect(context);
      tasks = inspected.tasks.filter(isActivityTask).length;
      queued = inspected.submissions.length;
    } catch {
      tasks = queued = 0;
    }
    if (closed || seq !== activitySeq) return;
    const next = tasks > 0;
    if (next !== anyBusy) {
      anyBusy = next;
      snapshot = { ...snapshot, anyBusy };
      publish();
    }
    if (!next && !queued && !sending) secret = "";
  };
  const scheduleActivity = () => {
    if (closed || activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = void 0;
      void refreshActivity();
    }, 200);
  };
  const ensurePolling = () => {
    if (closed || pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = void 0;
      await refreshActivity();
      if (anyBusy) ensurePolling();
    }, 1500);
  };
  const update = (view) => {
    if (closed || view.conversation.id !== conversation.id) return;
    const agent = view.docs["pi.agent"];
    const { messages, busy } = renderMessages(view);
    if (busy && !anyBusy) anyBusy = true;
    snapshot = {
      messages: paused ? messages.filter((item) => !(item.id === "partial" && item.text === "Thinking\u2026")) : messages,
      truncated: view.truncated === true,
      loadingHistory: view.loadingHistory === true,
      busy,
      paused,
      recoveryProviders: recovery.waiting,
      anyBusy,
      owned: ownedMeta.has(conversation.id),
      title: describe(conversation.id).title,
      kind: kindOf(conversation.id),
      persistence: options.bridge ? "native" : "memory",
      mode: agent?.model?.provider === CHATGPT_PROVIDER ? "chatgpt" : agent?.model?.provider === "anthropic" ? "claude" : agent?.model?.provider === "openai" ? "openai" : "offline",
      modelId: agent?.model?.modelId ?? "faux-1",
      thinkingEffort: agent?.thinkingLevel ?? "off",
      ...threadSnapshot(),
      ...lastError ? { error: lastError } : {}
    };
    publish();
    scheduleActivity();
    if (anyBusy) ensurePolling();
  };
  const observe = (selectedWatch) => selectedWatch.start(async (view) => {
    if (watch === selectedWatch) update(view);
  });
  // The scheduler resumes saved work; paused is reserved for recovered requests waiting for credentials.
  paused = false;
  update(watch.value);
  observe(watch);
  const refresh = async () => {
    const selected = conversation;
    const selectedWatch = watch;
    const view = await selectedWatch.refresh();
    if (selected === conversation && selectedWatch === watch) update(view);
  };
  // ---------- model providers: every signed-in provider is installed with its whole catalog, so the chat and
  // its subagents can each use any model the user has access to ----------
  const providerIdOf = (kind) => kind === "claude" ? "anthropic" : kind === "chatgpt" ? CHATGPT_PROVIDER : kind === "openai" ? "openai" : "faux";
  const kindOfProvider = (provider) => provider === "anthropic" ? "claude" : provider === CHATGPT_PROVIDER ? "chatgpt" : provider === "openai" ? "openai" : "offline";
  const chatgptModel = (selected) => {
    const known = Object.values(OPENAI_MODELS).find((candidate) => candidate.id === selected.id);
    return {
      ...known ?? { id: selected.id, api: "openai-responses", reasoning: false, input: ["text"], contextWindow: 128e3, maxTokens: 16384 },
      name: selected.name,
      provider: CHATGPT_PROVIDER,
      baseUrl: OPENAI_BASE_URL,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
  };
  const catalogs = /* @__PURE__ */ new Map();
  const installProvider = (kind, list) => {
    const claude = kind === "claude";
    const subscription = kind === "chatgpt";
    const label = claude ? "Claude" : subscription ? "ChatGPT" : "OpenAI";
    const transport = options.fetch ?? (options.bridge ? createNativeFetch(options.bridge) : globalThis.fetch.bind(globalThis));
    const fetch = async (input, init) => safeModelErrorResponse(await transport(input, init), { provider: label, input, init });
    const requestModel = (candidate) => claude ? candidate : { ...candidate, api: "openai-responses", provider: "openai", baseUrl: OPENAI_BASE_URL };
    catalogs.set(kind, list);
    models.setProvider(createProvider({
      id: providerIdOf(kind),
      models: list,
      auth: { apiKey: { name: label, resolve: async ({ signal }) => {
        await recovery.wait(kind, signal);
        if (!subscription && !claude) return secret ? { auth: { apiKey: secret } } : void 0;
        const token = await (claude ? options.claude : options.chatgpt).getAccessToken(signal);
        if (!token) throw new Error(`Sign in to ${label} again to continue.`);
        return { auth: { apiKey: token } };
      } } },
      api: {
        stream: (model2, transcript, settings) => (claude ? streamClaude : stream)(requestModel(model2), transcript, { ...settings, fetch }),
        streamSimple: (model2, transcript, settings) => (claude ? streamClaudeSimple : streamSimple)(requestModel(model2), transcript, { ...settings, fetch })
      }
    }));
  };
  /** Installs and returns the catalog of a provider the user can use now; throws a friendly error otherwise. */
  const providerCatalog = async (kind, signal) => {
    if (kind === "claude") {
      let token;
      try { token = await options.claude?.getAccessToken(signal); } catch { token = void 0; }
      if (!token) throw new Error("Sign in to Claude in Settings to use Claude models.");
      const list = Object.values(ANTHROPIC_MODELS);
      installProvider("claude", list);
      recovery.release("claude");
      return list;
    }
    if (kind === "chatgpt") {
      let token;
      try { token = await options.chatgpt?.getAccessToken(signal); } catch { token = void 0; }
      if (!token) throw new Error("Sign in to ChatGPT in Settings to use ChatGPT models.");
      const list = (await options.chatgpt.listModels()).map(chatgptModel);
      installProvider("chatgpt", list);
      recovery.release("chatgpt");
      return list;
    }
    if (kind === "openai") {
      if (!secret) throw new Error("OpenAI API-key models are only available while a reply that uses the key is running.");
      const list = catalogs.get("openai") ?? Object.values(OPENAI_MODELS);
      installProvider("openai", list);
      recovery.release("openai");
      return list;
    }
    return [{ id: "faux-1", name: "Offline demo" }];
  };
  const installSignedInProviders = async () => {
    for (const kind of ["claude", "chatgpt"]) {
      try { await providerCatalog(kind); } catch { /* not signed in */ }
    }
  };
  // Register saved model identities before starting the scheduler. Authentication waits are
  // abortable model requests, so a missing sign-in/API key cannot block server supervision.
  const recoveringByProvider = new Map();
  for (const ref of recoveredModels.values()) {
    const kind = kindOfProvider(ref.provider);
    if (kind === "offline") continue;
    if (!recoveringByProvider.has(kind)) recoveringByProvider.set(kind, []);
    recoveringByProvider.get(kind).push(ref);
  }
  const registerSavedProvider = (kind, refs) => {
    const list = kind === "claude" ? Object.values(ANTHROPIC_MODELS) : kind === "openai" ? Object.values(OPENAI_MODELS)
      : Object.values(OPENAI_MODELS).map((item) => chatgptModel(item));
    for (const ref of refs) if (!list.some((item) => item.id === ref.modelId) && kind === "chatgpt")
      list.push(chatgptModel({ id: ref.modelId, name: ref.modelId }));
    recovery.hold(kind);
    installProvider(kind, list);
  };
  for (const [kind, refs] of recoveringByProvider) registerSavedProvider(kind, refs);
  const checkingAuth = new Set();
  const restoreRecoveryAuth = async (kind) => {
    if (closed || !recovery.has(kind) || checkingAuth.has(kind)) return;
    checkingAuth.add(kind);
    try { await providerCatalog(kind); } catch { /* Keep requests saved and waiting for sign-in or Resume. */ }
    finally { checkingAuth.delete(kind); }
  };
  for (const [kind, auth] of [["chatgpt", options.chatgpt], ["claude", options.claude]]) {
    const unsubscribe = auth?.subscribe?.((state) => {
      if (state.signedIn) void restoreRecoveryAuth(kind);
    });
    if (unsubscribe) authSubscriptions.push(unsubscribe);
  }
  // Idle saved children have no recovery task at startup. Admit later messages with their own
  // saved model and an auth gate too, rather than silently finishing them with no_model.
  const ensureStoredProvider = async (id, config = {}) => {
    const ref = (await harness.snapshot(AgentDoc, id, context))?.model;
    const kind = kindOfProvider(ref?.provider);
    if (kind === "offline") return;
    if (!catalogs.has(kind)) registerSavedProvider(kind, [ref]);
    if (kind === "openai") {
      if (config.apiKey?.trim()) secret = config.apiKey.trim();
      if (secret) recovery.release(kind);
      else recovery.hold(kind);
    } else if (recovery.has(kind)) await restoreRecoveryAuth(kind);
  };
  const fastModelOf = (kind, list) => {
    const preferred = kind === "claude" ? ["claude-haiku-4-5"] : kind === "openai" ? ["gpt-4.1-mini"] : [];
    return list.find((m) => preferred.includes(m.id)) ?? list.find((m) => /mini|nano|haiku|flash|small/i.test(m.id)) ?? list[0];
  };
  /**
   * A model spec for a subagent: "same" (undefined: inherit), "fast" (a small model of the parent's provider),
   * or "provider/modelId".
   */
  const resolveModel = async (spec, parent, signal) => {
    const value = String(spec ?? "same").trim();
    if (!value || value === "same") return void 0;
    if (value === "fast") {
      const kind = kindOfProvider(parent?.provider);
      const pick = fastModelOf(kind, await providerCatalog(kind, signal));
      if (!pick) throw new Error("No model is available for this provider.");
      return { provider: providerIdOf(kind), modelId: pick.id };
    }
    const slash = value.indexOf("/");
    const provider = slash > 0 ? value.slice(0, slash) : "";
    const modelId = value.slice(slash + 1);
    const kind = kindOfProvider(provider);
    if (slash <= 0 || (kind === "offline" && provider !== "faux")) throw new Error(`Unknown model "${value}". Use the models action to list the available ones.`);
    const list = await providerCatalog(kind, signal);
    if (!list.some((m) => m.id === modelId)) throw new Error(`${value} is not available. Use the models action to list the available ones.`);
    return { provider, modelId };
  };
  const listModels = async (parent, signal) => {
    const lines = [`same: your model${parent ? ` (${parent.provider}/${parent.modelId})` : ""}`, "fast: a smaller, cheaper model of your provider"];
    for (const kind of ["claude", "chatgpt", "openai"]) {
      let list;
      try { list = await providerCatalog(kind, signal); } catch { continue; }
      for (const m of list) lines.push(`${providerIdOf(kind)}/${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`);
    }
    return lines.join("\n");
  };
  const clampThinking = (ref, level) => {
    if (!level) return void 0;
    const model = catalogs.get(kindOfProvider(ref?.provider))?.find((m) => m.id === ref?.modelId);
    return model ? clampThinkingLevel(model, level) : level;
  };
  const configureProvider = async (config) => {
    if (config.mode === "offline") return { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" };
    if (!["chatgpt", "claude", "openai"].includes(config.mode)) throw new Error("Choose a supported model provider.");
    let model;
    if (config.mode === "claude") {
      model = catalogModel(config);
      if (!model) throw new Error("Choose a Claude model from the bundled catalog.");
      try {
        if (!await options.claude?.getAccessToken()) throw new Error("No credential");
      } catch {
        throw new Error("Sign in to Claude again to continue.");
      }
      installProvider("claude", Object.values(ANTHROPIC_MODELS));
    } else if (config.mode === "chatgpt") {
      if (!options.chatgpt) throw new Error("Sign in to ChatGPT before sending a message.");
      try {
        if (!await options.chatgpt.getAccessToken()) throw new Error("No credential");
      } catch {
        throw new Error("Sign in to ChatGPT again to continue.");
      }
      const available = await options.chatgpt.listModels();
      const selected = config.modelId?.trim() ? available.find((entry) => entry.id === config.modelId.trim()) : available[0];
      if (!selected) throw new Error("Choose a model available in your ChatGPT account.");
      model = chatgptModel(selected);
      installProvider("chatgpt", available.map(chatgptModel));
    } else {
      const modelId = config.modelId?.trim() || DEFAULT_OPENAI_MODEL;
      const known = Object.values(OPENAI_MODELS).find((candidate) => candidate.id === modelId);
      if (!known) throw new Error("This model is not in the bundled OpenAI catalog. Choose gpt-4.1-mini or another supported model.");
      if (!config.apiKey?.trim()) throw new Error("Enter your OpenAI API key to start.");
      secret = config.apiKey.trim();
      model = known;
      installProvider("openai", Object.values(OPENAI_MODELS));
    }
    recovery.release(config.mode);
    void installSignedInProviders();
    return { model: { provider: providerIdOf(config.mode), modelId: model.id }, thinkingLevel: thinkingFor(model, config.thinkingEffort) };
  };
  const ensureOpen = () => {
    if (closed) throw new Error("The conversation is closed.");
  };
  const transition = (work) => {
    ensureOpen();
    if (transitioning) throw new Error("Wait for the thread change to finish.");
    transitioning = true;
    const pending = (async () => {
      try {
        await metadataTail;
        ensureOpen();
        return await work();
      } finally {
        transitioning = false;
      }
    })();
    transitionPromise = pending.catch(() => {
    });
    return pending;
  };
  const selectConversation = async (selected, persist = true) => {
    let nextWatch;
    try {
      const record = conversations.get(selected.id) ?? await storage.conversation(selected.id, context);
      const owned = Boolean(record?.owner);
      if (owned && !ownedMeta.has(selected.id)) {
        ownedMeta.set(selected.id, { ...await ownedNaming(record), parentId: record.owner.conversationId });
      }
      if (!owned) {
        await harness.commit(async (tx) => { await configurePrompt(tx, selected.id, {}); }, context);
        await selected.configure({ instructions: null,
          ...nativeEnvironment ? { cwd: nativeEnvironment.cwd } : {} }, context);
      }
      nextWatch = await openTail(selected, reportTailError);
      ensureOpen();
      if (persist && conversations.has(selected.id) && metadata.selectedId !== selected.id) await queueMetadata(() => harness.commit(async (tx) => {
        const state = await tx.doc(ThreadsDoc);
        state.selectedId = selected.id;
      }, context));
      ensureOpen();
      metadata = await harness.snapshot(ThreadsDoc, context);
      await reconcileDraftAttachments(nextWatch.value);
      await loadDraftAttachments(selected.id);
      ensureOpen();
      const previous = watch;
      conversation = selected;
      watch = nextWatch;
      nextWatch = void 0;
      lastError = void 0;
      update(watch.value);
      observe(watch);
      await previous.stop();
      return snapshot.conversation;
    } finally {
      await nextWatch?.stop();
    }
  };
  const unsubscribeAppUpdates = harness.subscribeCommits(appUpdateHandoff.committed);
  const session = {
    get snapshot() {
      return snapshot;
    },
    workspace,
    /** Android build tools: installed() is true/false (undefined if unknown); ensure() starts the detached background install if needed. */
    toolchain: {
      async installed() {
        if (!nativeEnvironment || closed) return void 0;
        const code = await runQuiet(nativeEnvironment, TOOLCHAIN_READY, 20);
        if (code === 0) toolchainKnownReady = true;
        return code === void 0 ? void 0 : code === 0;
      },
      async ensure() {
        if (!nativeEnvironment?.backgroundExecution || closed || toolchainKnownReady || options.toolchain === false) return;
        await runQuiet(nativeEnvironment, toolchainStartCommand(nativeEnvironment.cwd), 30);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async send(text, config = { mode: "offline" }) {
      ensureOpen();
      if (sending || transitioning) throw new Error("Wait for the current message or thread change to finish.");
      sending = true;
      try {
        await metadataTail;
        ensureOpen();
        const target = conversation;
        const id = target.id;
        const owned = ownedMeta.has(id);
        const trimmed = String(text ?? "").trim();
        let attachments = [];
        if (!owned) {
          await loadDraftAttachments(id);
          attachments = describe(id, true).attachments;
        }
        if (!trimmed && !attachments.length) return;
        if (owned) await ensureStoredProvider(id, config);
        if (snapshot.busy) {
          lastError = void 0;
          await target.submit({ type: "input", content: attachmentUserContent(trimmed, attachments), whenBusy: "steer" }, context);
        } else if (owned) {
          await installSignedInProviders();
          lastError = void 0;
          await target.submit({ type: "input", content: attachmentUserContent(trimmed, []), whenBusy: "reject" }, context);
        } else {
          const configuration = await configureProvider(config);
          lastError = void 0;
          await target.configure(configuration, context);
          await target.submit({ type: "input", content: attachmentUserContent(trimmed, attachments), whenBusy: "reject" }, context);
        }
        if (attachments.length) {
          const sent = new Set(attachments.map((item) => item.id));
          await queueMetadata(async () => {
            await harness.commit(async (tx) => {
              const state = await tx.doc(ThreadsDoc);
              const thread = state.threads[String(id)];
              thread.attachments = (thread.attachments ?? []).filter((key) => !sent.has(key));
            }, context);
            await refreshMetadata();
          });
        }
        if (watch.value.conversation.id === id) watch.poke();
        scheduleActivity();
        ensurePolling();
      } finally {
        sending = false;
      }
    },
    async resume(config = { mode: "offline" }) {
      ensureOpen();
      if (!paused) return;
      if (sending || transitioning) throw new Error("Wait for the current reply or thread change, or stop it first.");
      sending = true;
      try {
        await installSignedInProviders();
        if (["chatgpt", "claude", "openai"].includes(config.mode)) await configureProvider(config);
        paused = recovery.waiting.length > 0;
        snapshot = { ...snapshot, paused };
        publish();
        harness.resume();
        scheduleActivity();
        ensurePolling();
      } finally {
        sending = false;
      }
    },
    async stop() {
      ensureOpen();
      if (transitioning) throw new Error("Wait for the thread change to finish.");
      appUpdateHandoff.clear();
      const target = conversation;
      if (ownedMeta.has(target.id)) await target.abort(context, { background: true });
      else await target.abort(context);
      if (paused) {
        let remaining = 0;
        try { remaining = (await harness.inspect(context)).tasks.filter(isActivityTask).length; } catch { }
        if (!remaining) paused = false;
      }
      if (target === conversation) await refresh();
      await refreshActivity();
    },
    /** Conversation tree: main, threads, forks, background subagents and foreground tasks, depth-first, oldest first. */
    async tree() {
      ensureOpen();
      const records = [];
      let cursor;
      do {
        const page = await storage.scanConversations({}, 128, cursor, context);
        records.push(...page.items);
        cursor = page.next;
      } while (cursor);
      const ids = new Set(records.map((record) => record.id));
      const parentOf = (record) => record.owner?.conversationId ?? record.parent?.conversationId;
      const agentsOf = /* @__PURE__ */ new Map();
      const namedAgents = async (parentId) => {
        if (!agentsOf.has(parentId)) {
          let agents = {};
          try { agents = (await harness.snapshot(Subagents, parentId, context))?.agents ?? {}; } catch { }
          agentsOf.set(parentId, agents);
        }
        return agentsOf.get(parentId);
      };
      const nodes = /* @__PURE__ */ new Map();
      for (const record of records) {
        const parentId = parentOf(record);
        let agent, live;
        try { agent = await harness.snapshot(AgentDoc, record.id, context); } catch { }
        try { live = await harness.snapshot(LiveDoc, record.id, context); } catch { }
        const model = agent?.model?.provider && agent?.model?.modelId ? `${agent.model.provider}/${agent.model.modelId}` : "";
        let kind, title;
        if (record.owner) {
          ({ kind, title } = await ownedNaming(record, namedAgents));
        } else if (record.id === ROOT_CONVERSATION_ID) { kind = "main"; title = describe(record.id).title; }
        else if (record.parent) { kind = "fork"; title = describe(record.id).title; }
        else { kind = "thread"; title = describe(record.id).title; }
        const busy = live?.run !== void 0;
        const node = { id: record.id, parentId, kind, title, busy, selected: record.id === conversation.id, model };
        node.archived = !record.owner && record.id !== ROOT_CONVERSATION_ID && metadata.threads[String(record.id)]?.archived === true;
        node.finished = kind === "task" && !busy;
        node.empty = false;
        if (!record.owner && record.id !== ROOT_CONVERSATION_ID) {
          try { node.empty = (await (await harness.conversation(record.id, context)).entries({}, 1, void 0, context)).items.length === 0; } catch { }
        }
        nodes.set(record.id, node);
      }
      const children = /* @__PURE__ */ new Map();
      const roots = [];
      for (const node of [...nodes.values()].sort((a, b) => a.id - b.id)) {
        if (node.parentId !== void 0 && ids.has(node.parentId)) {
          if (!children.has(node.parentId)) children.set(node.parentId, []);
          children.get(node.parentId).push(node);
        } else roots.push(node);
      }
      const out = [];
      const visit = (node) => { out.push(node); for (const child of children.get(node.id) ?? []) visit(child); };
      for (const root of roots) visit(root);
      return out;
    },
    /** Watches any conversation; listener({ messages, busy, model, title }) runs on every change. Returns an async stop(). */
    async viewConversation(id, listener) {
      ensureOpen();
      if (typeof listener !== "function") throw new TypeError("A listener function is required.");
      const target = await harness.conversation(id, context);
      if (!target) throw new Error(`Conversation ${id} does not exist.`);
      const title = (await session.tree()).find((node) => node.id === id)?.title ?? "";
      const watcher = await openTail(target, void 0, { history: false });
      let stopped = false;
      const emit = (view) => {
        if (stopped || closed) return;
        const { messages, busy, modelLabel } = renderMessages(view);
        listener({ messages, busy, model: modelLabel, title });
      };
      emit(watcher.value);
      watcher.start(async (view) => emit(view));
      return async () => {
        if (stopped) return;
        stopped = true;
        await watcher.stop();
      };
    },
    /** Sends text to any conversation: steers if it is busy, starts a reply if idle. Does not wait for the answer. */
    async sendTo(id, text, config = {}) {
      ensureOpen();
      const trimmed = String(text ?? "").trim();
      if (!trimmed) throw new Error("Write a message to send.");
      await installSignedInProviders();
      const target = await harness.conversation(id, context);
      if (!target) throw new Error(`Conversation ${id} does not exist.`);
      await ensureStoredProvider(id, config);
      await target.submit({ type: "input", content: trimmed, whenBusy: "steer" }, context);
      if (watch.value.conversation.id === id) watch.poke();
      scheduleActivity();
      ensurePolling();
    },
    /** Aborts a conversation; background work is stopped too unless it is the selected conversation. */
    async stopConversation(id) {
      ensureOpen();
      const target = await harness.conversation(id, context);
      if (!target) throw new Error(`Conversation ${id} does not exist.`);
      if (id === conversation.id && !ownedMeta.has(id)) await target.abort(context);
      else await target.abort(context, { background: true });
      scheduleActivity();
    },
    /** Steer the running reply: the text is delivered to the agent at its next step, without waiting for it to finish. */
    async steer(text) {
      ensureOpen();
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return;
      if (!snapshot.busy) throw new Error("Nothing is running to steer.");
      await conversation.submit({ type: "input", content: attachmentUserContent(trimmed, []), whenBusy: "steer" }, context);
      await refresh();
    },
    async setDraft(text) {
      ensureOpen();
      if (typeof text !== "string") throw new TypeError("The draft must be text.");
      const id = conversation.id;
      if (ownedMeta.has(id)) {
        if ((drafts.get(id) ?? "") === text) return;
        drafts.set(id, text);
        if (!closed) {
          snapshot = { ...snapshot, ...threadSnapshot() };
          publish();
        }
        return;
      }
      return queueMetadata(async () => {
        if (metadata.threads[String(id)]?.draft === text) return;
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          state.threads[String(id)].draft = text;
        }, context);
        await refreshMetadata();
      });
    },
    async addAttachments(files, conversationId = conversation.id) {
      ensureOpen();
      if (sending) throw new Error("Wait for the current reply before attaching files.");
      if (!conversations.has(conversationId)) {
        throw new Error(ownedMeta.has(conversationId) ? "Attach files in a top-level conversation." : "This thread is not available.");
      }
      const selected = Array.from(files);
      if (!selected.length) return;
      return queueMetadata(async () => {
        const existing = metadata.threads[String(conversationId)].attachments ?? [];
        if (existing.length + selected.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
        const prepared = [];
        for (const file of selected) prepared.push(await prepareAttachment(file, { env: nativeEnvironment, workspace, context }));
        await harness.commit(async (tx) => {
          for (const item of prepared) await tx.doc(AttachmentDoc, item.attachment.id, item);
          const state = await tx.doc(ThreadsDoc);
          state.threads[String(conversationId)].attachments = [...existing, ...prepared.map((item) => item.attachment.id)];
        }, context);
        for (const item of prepared) attachmentRecords.set(item.attachment.id, item);
        await refreshMetadata();
      });
    },
    async removeAttachment(id) {
      ensureOpen();
      if (sending) throw new Error("Wait for the current reply before changing attachments.");
      const conversationId = conversation.id;
      if (ownedMeta.has(conversationId)) throw new Error("Attach files in a top-level conversation.");
      return queueMetadata(async () => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          const thread = state.threads[String(conversationId)];
          thread.attachments = (thread.attachments ?? []).filter((key) => key !== id);
        }, context);
        await refreshMetadata();
      });
    },
    async switchConversation(id) {
      ensureOpen();
      if (id === conversation.id) return snapshot.conversation;
      return transition(async () => {
        let selected;
        try { selected = await harness.conversation(id, context); } catch { selected = void 0; }
        if (!selected) throw new Error("This conversation is not available.");
        return selectConversation(selected);
      });
    },
    /** Start a fresh conversation (no history) with the current model settings and the current tool set. */
    async newThread() {
      return transition(async () => {
        // An empty, idle chat is reused instead of piling up blank ones (newest first).
        let tasks = [];
        try { tasks = (await harness.inspect(context)).tasks; } catch { }
        for (const candidateId of [...conversations.keys()].sort((a, b) => b - a)) {
          if (candidateId === ROOT_CONVERSATION_ID) continue;
          const saved = metadata.threads[String(candidateId)];
          if (!saved || saved.archived || saved.draft || (saved.attachments ?? []).length) continue;
          if (tasks.some((task) => task.record.conversationId === candidateId)) continue;
          let candidate;
          try { candidate = await harness.conversation(candidateId, context); } catch { continue; }
          if (!candidate) continue;
          const live = await harness.snapshot(LiveDoc, candidateId, context).catch(() => void 0);
          if (live?.run !== void 0) continue;
          if ((await candidate.entries({}, 1, void 0, context)).items.length) continue;
          ensureOpen();
          if (candidateId === conversation.id) return snapshot.conversation;
          return selectConversation(candidate);
        }
        let baseAgent = watch.value.docs["pi.agent"];
        if (ownedMeta.has(conversation.id)) {
          try { baseAgent = await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context) ?? baseAgent; } catch { }
        }
        const created = await queueMetadata(() => harness.createConversation({
          ownership: { kind: "ownerless" },
          agent: { ...baseAgent },
          init: async (tx, id) => {
            const state = await tx.doc(ThreadsDoc);
            state.threads[String(id)] = { title: `Conversation ${state.nextThread++ + 1}`, draft: "" };
            state.selectedId = id;
          }
        }, context));
        const record = await storage.conversation(created.id, context);
        conversations.set(created.id, record);
        return selectConversation(created, false);
      });
    },
    /** Hides a top-level chat (not the main one) from the list; its history is kept. */
    async archiveConversation(id) {
      ensureOpen();
      if (id === ROOT_CONVERSATION_ID) throw new Error("The main conversation cannot be archived.");
      if (!conversations.has(id)) throw new Error("Only conversations can be archived.");
      if (id === conversation.id) await session.switchConversation(ROOT_CONVERSATION_ID);
      await queueMetadata(async () => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          if (state.threads[String(id)]) state.threads[String(id)].archived = true;
        }, context);
        await refreshMetadata();
      });
    },
    /** Renames a top-level chat (main, thread or fork). */
    async renameConversation(id, title) {
      ensureOpen();
      const name = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) throw new Error("Enter a name.");
      if (!conversations.has(id)) throw new Error("Subagent chats are named by their agent and cannot be renamed.");
      await queueMetadata(async () => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          if (state.threads[String(id)]) state.threads[String(id)].title = name;
          else state.threads[String(id)] = { title: name, draft: "" };
        }, context);
        await refreshMetadata();
      });
      if (!closed && id === conversation.id) {
        snapshot = { ...snapshot, title: describe(id).title };
        publish();
      }
    },
    async unarchiveConversation(id) {
      ensureOpen();
      if (!conversations.has(id) || id === ROOT_CONVERSATION_ID) throw new Error("Only conversations can be restored.");
      await queueMetadata(async () => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          if (state.threads[String(id)]) delete state.threads[String(id)].archived;
        }, context);
        await refreshMetadata();
      });
    },
    async forkThread() {
      return transition(async () => {
        if (ownedMeta.has(conversation.id)) throw new Error("Fork a top-level conversation.");
        const source = conversation;
        const tail = (await source.entries({}, 1, void 0, context)).items[0];
        ensureOpen();
        const createOptions = {
          ownership: { kind: "ownerless" },
          init: async (tx, id) => {
            const state = await tx.doc(ThreadsDoc);
            state.threads[String(id)] = {
              title: `Thread ${state.nextThread++}`,
              draft: "",
              parentId: source.id
            };
            state.selectedId = id;
          }
        };
        const fork = await queueMetadata(() => tail ? source.fork(tail.id, createOptions, context) : harness.createConversation({
          ...createOptions,
          agent: { ...watch.value.docs["pi.agent"] }
        }, context));
        const record = await storage.conversation(fork.id, context);
        conversations.set(fork.id, record);
        return selectConversation(fork, false);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const unsubscribe of authSubscriptions) unsubscribe();
      clearTimeout(activityTimer);
      clearTimeout(pollTimer);
      activityTimer = pollTimer = void 0;
      appUpdateHandoff.close();
      unsubscribeAppUpdates();
      listeners.clear();
      await transitionPromise;
      await metadataTail;
      const closing = harness.close(context);
      secret = "";
      try {
        await Promise.all([closing, watch.stop()]);
      } finally {
        if (!nativeEnvironment?.backgroundExecution) await nativeEnvironment?.cleanup(context);
      }
    }
  };
  harness.resume();
  for (const kind of recoveringByProvider.keys()) if (kind !== "openai") void restoreRecoveryAuth(kind);
  void session.toolchain.ensure().catch(() => {
  });
  return session;
}
export {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  getThinkingEfforts,
  openAppSession
};
