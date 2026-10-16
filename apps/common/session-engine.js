// apps/common/session-engine.js
// The session engine (C3 final step): Harness open/close, storage, registry, send/stop/resume.
// Verbatim remainder of the former session.js; the parts live in session-tail.js, -threads.js,
// -tree.js and -providers.js. session.js re-exports this module.
import { BACKGROUND_CONTEXT } from "./library/chord/context.js";
import { createModels, getSupportedThinkingLevels, clampThinkingLevel } from "./library/pi-ai.js";
import {
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  createRegistry,
  configure,
  AgentDoc,
  LiveDoc
} from "./library/pi-durable.js";
import { coreAgentContributions, coreSkillContributions, loadCoreBuilders, NATIVE_EXTENSION, PROMPT_EXTENSION, SERVERS_EXTENSION, SERVER_TASK_KIND, SUBAGENTS_EXTENSION } from "./core-agent-plugins.js";
import { pluginPi } from "./plugin-pi.js";
import { createSkillMirror, servedSkillSource } from "./plugin-skills.js";
import { createAgentExtensions } from "./agent-extensions.js";
// X3b: bundled copies only. Each session takes these parts from the owning plugin's service when it
// is active (options.engineParts, given by core-agent: conversations.engine@1 of core-conversations,
// servers.engine@1 of core-servers) and falls back to these static imports otherwise
// (docs/plugin-ownership.md, "bundled-fallback imports").
import * as bundledTail from "./builtin/core-conversations/web/session-tail.js";
import * as bundledThreads from "./builtin/core-conversations/web/session-threads.js";
import * as bundledTree from "./builtin/core-conversations/web/session-tree.js";
import { createServerSession as bundledCreateServerSession } from "./builtin/core-servers/web/servers-service.js";
import { createRecoveryGate } from "./recovery.js";
import { builtinPlugin } from "./builtin-plugins.js";
import { attachmentUserContent, attachedUserPresentation } from "./attachments.js";
import { createProviderTable, coreProviderContributions } from "./core-providers.js";
import { providerRow as offlineRow } from "./builtin/core-providers-offline/web/provider.js";
import { providerRow as claudeRow } from "./builtin/core-providers-claude/web/provider.js";
import { providerRow as chatgptRow } from "./builtin/core-providers-chatgpt/web/provider.js";
import { providerRow as openaiRow } from "./builtin/core-providers-openai/web/provider.js";
import { createSessionProviders } from "./session-providers.js";
import { pageHarnessListener, pageSessionFailureListener } from "./agent-sessions.js";
import { SESSION_NOT_OPEN_MESSAGE } from "./agent-contracts.js";
var context = BACKGROUND_CONTEXT;
var BUNDLED_CONVERSATIONS = Object.freeze({
  createTail: bundledTail.createTail,
  renderMessages: bundledTail.renderMessages,
  textOf: bundledTail.textOf,
  ThreadsDoc: bundledThreads.ThreadsDoc,
  agentCopy: bundledThreads.agentCopy,
  createThreads: bundledThreads.createThreads,
  createTree: bundledTree.createTree
});
var BUNDLED_SERVERS = Object.freeze({ createServerSession: bundledCreateServerSession });
// X3b: one engine part from its plugin's service ({load() → the part}), else the bundled copy.
// A part that fails to load or lacks a member of the bundled copy is reported and not used.
async function enginePart(options, id, bundled) {
  let service = null;
  try {
    service = typeof options.engineParts === "function" ? options.engineParts(id, 1) : null;
  } catch {
  }
  if (!service || typeof service.load !== "function") return bundled;
  try {
    const part = await service.load();
    const missing = Object.keys(bundled).filter((name) => typeof part?.[name] !== typeof bundled[name]);
    if (missing.length) throw new TypeError(`${id} lacks ${missing.join(", ")}`);
    return part;
  } catch (error) {
    console.error(`${id} unavailable: using the bundled copy`, error);
    return bundled;
  }
}
// X3: the conversation store normally arrives from storage@1 (core-storage) or the page's bundled
// copy (open-sessions.js). Without one (tests, forks) the engine opens the statically registered
// core-storage copy; only if a fork left core-storage out, the old openNativeDatabase export of the
// fixed native-host.js (same database name).
async function openLastResortStorage(options, env, hostInfo) {
  const coreStorage = builtinPlugin("core-storage")?.entry;
  if (typeof coreStorage?.createStorage === "function") return coreStorage.createStorage({ bridge: options.bridge, hostInfo }).open({ env, name: options.databaseName });
  const [{ openNativeDatabase }, { SqliteStorage }] = await Promise.all([import("./native-host.js"), import("./library/pi-durable/storage/sqlite.js")]);
  return SqliteStorage.open(await openNativeDatabase(options.bridge, options.databaseName ?? "self-forming"));
}
// Built-in provider rows (plugins/core-providers-<mode>/web/provider.js). The static table (core-providers.js,
// step P1a) answers getThinkingEfforts without a session; each session runs its own
// provider engine over the same rows (session-providers.js, step P1b: provider install,
// credentials, configure, recovery, modelSettings normalization — only non-secret
// preferences belong in thread metadata; AgentDoc remains the configuration of the
// last/active run).
var PROVIDER_ROWS = [offlineRow, claudeRow, chatgptRow, openaiRow];
var { getThinkingEfforts } = createProviderTable(PROVIDER_ROWS, { getSupportedThinkingLevels, clampThinkingLevel });
var DEFAULT_OPENAI_MODEL = openaiRow.defaultModelId;
var DEFAULT_CLAUDE_MODEL = claudeRow.defaultModelId;
var CLAUDE_MODELS = claudeRow.catalog().map(({ id, name }) => ({ id, name }));
// P4: one provider row as providers() reports it; instance = the row's session part, if known.
function providerEntry(row, instance) {
  let status;
  try {
    status = instance?.status?.();
  } catch {
  }
  const bound = (name) => typeof instance?.[name] === "function" ? { [name]: (...args) => instance[name](...args) } : {};
  return Object.freeze({
    mode: row.mode, label: row.label, auth: row.auth, defaultModelId: row.defaultModelId ?? "", available: true, status,
    thinkingEfforts: (modelId) => row.thinkingEfforts(modelId),
    catalog: () => row.catalog(),
    models: async (signal) => typeof instance?.models === "function" && !instance.provider ? instance.models(signal) : row.catalog(),
    ...bound("connect"),
    ...bound("subscribe")
  });
}
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
// Durable generation retries (pi-durable README "Settings", spec §8.3): a retryable model error
// (connection, 5xx, overload, rate limit; pi-ai isRetryableAssistantError) is retried while
// attempt <= maxRetries, after baseDelayMs * 2^(attempt - 1) (upstream default 2 s) capped at
// maxAgentDelayMs; any other error ends the run. 1000 retries at the 60 s cap is about 16 hours, so a
// transient outage does not end a reply. Each failed attempt stays in the transcript as an error
// entry; pi-durable leaves error replies out of the model context.
var RETRY_SETTINGS = Object.freeze({ maxRetries: 1e3, maxAgentDelayMs: 6e4 });
/** The snapshot's retry ({attempt, at, error}) while the run waits for its next attempt (pi.live.generation.retry). */
function retrySnapshot(live) {
  const retry = live?.run !== void 0 ? live.generation?.retry : void 0;
  return retry && typeof retry.at === "number" ? { retry: { attempt: live.generation.attempt, at: retry.at, error: String(retry.error ?? "") } } : {};
}
async function openAppSession(options = {}) {
  // The builders come from the core plugins' own modules (X2), loaded once per session.
  const coreBuilders = await loadCoreBuilders();
  const nativeEnvironment = options.env;
  // X4: the workspace and fetch normally arrive from workspace@1 (core-execution) / net.fetch@1
  // (core-net-native) or their bundled copies (page session options); native-host.js is only the last
  // resort (tests, forks), imported lazily.
  const workspace = options.workspace ?? (options.bridge ? (await import("./native-host.js")).createNativeWorkspace(options.bridge) : memoryWorkspace());
  const lastResortFetch = !options.fetch && options.bridge ? (await import("./native-host.js")).createNativeFetch(options.bridge) : void 0;
  const storage = options.storage ?? (options.bridge ? await openLastResortStorage(options, nativeEnvironment, options.hostInfo ?? globalThis.__piHostInfo) : new MemoryStorage());
  const models = createModels();
  const registry = createRegistry();
  // The app-update handoff (app-update-handoff.js) is owned by core-self-update (step C5):
  // its row observes commits through host.harness and calls host.appRevision.onStaged
  // (deferred, after the exact successful result is saved). The session only republishes
  // its snapshot after the page was told, so app.js render runs applyQueued.
  const appRevision = options.appRevision ? Object.freeze({
    info: (...args) => options.appRevision.info(...args),
    stage: (...args) => options.appRevision.stage(...args),
    onStaged(revision) {
      options.appRevision.onStaged?.(revision);
      publish();
    }
  }) : void 0;
  // agent.harness@1 hooks (additive, step C5): onStop(fn) runs when the user stops the
  // selected reply (session.stop), onClose(fn) when the session starts closing (before the
  // Harness closes). Both return an unsubscribe function; they may be registered before open.
  const stopHooks = /* @__PURE__ */ new Set();
  const closeHooks = /* @__PURE__ */ new Set();
  const hook = (set, name) => (fn) => {
    if (typeof fn !== "function") throw new TypeError(`agent.harness@1 ${name} needs a function`);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };
  const runHooks = (set, name) => {
    for (const fn of [...set]) {
      try {
        fn();
      } catch (error) {
        console.error(`agent.harness@1 ${name} hook failed`, error);
      }
    }
  };
  let projectGuide = "";
  if (nativeEnvironment && options.appRevision && options.bridge) {
    try {
      projectGuide = String(await workspace.read("self-forming/AGENTS.md") ?? "").trim().slice(0, 4e4);
    } catch {
    }
  }
  // This session's agent host: what the core agent plugins (core-agent-plugins.js) build
  // their tools and prompt sections from. hostInfo is the host.info the page already published.
  const hostInfo = options.hostInfo ?? globalThis.__piHostInfo;
  // Skills that installed plugins ship are copied read-only to <workspace>/.skills/
  // (plugin-skills.js) where the agent's file tools can read them. Needs the Linux
  // shell of the Android host; options.skillSource replaces the served files in tests.
  let skillMirror;
  if (nativeEnvironment && typeof nativeEnvironment.exec === "function" && hostInfo?.platform !== "browser" && hostInfo?.capabilities?.plugins === true) {
    try {
      skillMirror = createSkillMirror({ env: nativeEnvironment, source: options.skillSource ?? servedSkillSource(), onError: (error, details) => console.error("Plugin skill unavailable", details, error) });
    } catch (error) {
      console.error("Plugin skills unavailable", error);
    }
  }
  // agent.harness@1 (agent-contracts.js, step C2): this session's frozen harness handle,
  // exactly the contract members (no close/resume/root, storage read-only). Its members
  // forward to the Harness only from Harness.open until Harness.close is called and throw
  // outside that window. It is a plain value of agentHost (agent-extensions.js copies the
  // host when it attaches, before Harness.open, so a getter there would run too early).
  // onHarness(handle) after Harness.open, onHarness(null, {previous}) before it closes:
  // options.onHarness, else the page controller's (agent-sessions.js setPageAgentSessions).
  const onHarness = typeof options.onHarness === "function" ? options.onHarness : pageHarnessListener();
  let harnessState = "opening";
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  started.catch(() => {
  });
  const live = () => {
    if (harnessState === "open") return harness;
    throw new Error(harnessState === "opening" ? SESSION_NOT_OPEN_MESSAGE : "The conversation is closed.");
  };
  const harnessHandle = Object.freeze({
    rootConversationId: ROOT_CONVERSATION_ID,
    context,
    env: nativeEnvironment,
    workspace,
    started,
    abortTask: (...args) => live().abortTask(...args),
    abortSubmission: (...args) => live().abortSubmission(...args),
    snapshot: (...args) => live().snapshot(...args),
    watchDoc: (...args) => live().watchDoc(...args),
    commit: (...args) => live().commit(...args),
    inspect: (...args) => live().inspect(...args),
    conversation: (...args) => live().conversation(...args),
    subscribeCommits: (...args) => live().subscribeCommits(...args),
    getTask: (...args) => live().getTask(...args),
    waitForTask: (...args) => live().waitForTask(...args),
    onStop: hook(stopHooks, "onStop"),
    onClose: hook(closeHooks, "onClose"),
    storage: Object.freeze({
      conversation: (...args) => (live(), storage.conversation(...args)),
      scanConversations: (...args) => (live(), storage.scanConversations(...args)),
      scanSubmissions: (...args) => (live(), storage.scanSubmissions(...args)),
      task: (...args) => (live(), storage.task(...args))
    }),
    models: Object.freeze({
      resolve: (spec, parentRef, signal) => (live(), resolveModel(spec, parentRef, signal)),
      list: (parentRef, signal) => (live(), listModels(parentRef, signal)),
      clampThinking: (ref, level) => (live(), clampThinking(ref, level))
    }),
    tools: Object.freeze({
      get: (name) => (live(), getTool(name)),
      names: (ownerAgent) => (live(), toolNames(ownerAgent))
    }),
    prompt: Object.freeze({
      configure: (tx, conversationId, selection) => (live(), configurePrompt(tx, conversationId, selection))
    })
  });
  const reportHarness = (value) => {
    try {
      if (value) onHarness?.(value);
      else onHarness?.(null, { previous: harnessHandle });
    } catch (error) {
      console.error("agent.harness@1 listener failed", error);
    }
  };
  // The handle ends here: no further calls reach the Harness; started rejects if tasks never started.
  const endHarness = () => {
    harnessState = "closed";
    rejectStarted(new Error("The conversation closed before its tasks started."));
  };
  // Supervised servers (A4): the essential built-in core-servers contributes the permanent
  // extension self-forming-servers (manage_server, task kind self-forming.server) from
  // this binding and provides servers@1 over it. Condition: a native execution environment;
  // in the browser edition only while the page offers Linux (linuxShell; servers.js then requires
  // the session's environment to be the Linux one, env.shell bash, and keeps the tab-bound
  // lifetime; the JavaScript environment refuses clearly). The implementation
  // (core-servers servers.js) is built once per session, so the bundled and the runtime copy of
  // core-servers install the same task definition and pending Server tasks resume
  // exactly as before; servers@1 can use the session once its tasks are scheduled.
  const browserServers = globalThis.__piHostInfo?.platform === "browser";
  const serverParts = nativeEnvironment && (!browserServers || globalThis.__piHostInfo?.capabilities?.linuxShell === true) ? await enginePart(options, "servers.engine", BUNDLED_SERVERS) : void 0;
  const serverSession = serverParts ? serverParts.createServerSession({
    build: () => coreBuilders.createServers({
      ...browserServers ? { hostInfo: globalThis.__piHostInfo } : {},
      rootConversationId: ROOT_CONVERSATION_ID,
      abortTask: (id, abortContext) => harnessHandle.abortTask(id, abortContext)
    })
  }) : void 0;
  const agentHost = Object.freeze({
    hostInfo,
    env: nativeEnvironment,
    workspace,
    appRevision,
    apkInstaller: options.apkInstaller,
    pluginHost: hostInfo?.capabilities?.plugins === true ? options.bridge : void 0,
    projectGuide,
    harness: harnessHandle,
    // The host's pi-durable/pi-ai (the ctx.pi bag): session-bound rows that build their
    // own tools and tasks (core-subagents) use it instead of a library import.
    pi: pluginPi,
    ...skillMirror ? { skillMirror } : {},
    ...serverSession ? { servers: serverSession } : {}
  });
  // Prompt sections (self-forming-prompts) are the essential built-in core-prompt; its
  // per-conversation selection doc is permanent and written with this function
  // (main/thread reset to the main sections, subagent context and transcript).
  const { configurePrompt } = coreBuilders.createPromptExtension();
  // Page-owned plugin agent extensions (agent-extensions.js); absent in tests/old callers,
  // which get a private adapter that is never connected: only the bundled core plugins.
  const agentExtensions = options.agentExtensions;
  const extensionsAdapter = agentExtensions ?? createAgentExtensions({
    onError: (error, details) => console.error("Agent tools unavailable", details, error)
  });
  // The core self-forming-native / self-forming-prompts extensions as currently installed (by the adapter).
  const nativeExtension = () => nativeEnvironment ? registry.snapshot().extension(NATIVE_EXTENSION) : void 0;
  const promptExtension = () => registry.snapshot().extension(PROMPT_EXTENSION);
  // self-forming-servers as installed by the adapter (core-servers), where this session has servers.
  const serversExtension = () => serverSession ? registry.snapshot().extension(SERVERS_EXTENSION) : void 0;
  // self-forming-subagents as installed by the adapter (core-subagents, A5; native sessions).
  const subagentsExtension = () => nativeEnvironment ? registry.snapshot().extension(SUBAGENTS_EXTENSION) : void 0;
  const allExtensions = () => [nativeExtension(), subagentsExtension(), serversExtension(), ...extensionsAdapter.extensions(registry)].filter(Boolean);
  const getTool = (name) => {
    for (const extension of allExtensions()) {
      const tool = extension.tools?.find?.((candidate) => candidate.name === name);
      if (tool) return tool;
    }
    return void 0;
  };
  // agent: the owner's stored pi.agent, so a subagent never gets tools of plugins its owner excluded.
  const toolNames = (agent) => [...new Set(allExtensions().filter((extension) => !agent || extensionsAdapter.selects(agent, extension.name) !== false)
    .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)))];
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
  const recoveredModels = /* @__PURE__ */ new Map();
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
  // Model providers (session-providers.js): installs the offline demo now, the others on
  // demand; recovery holds are keyed by mode; transient API keys stay in its memory.
  // Rows: the page's agent.providers adapter (agent-providers.js) when given (runtime
  // copies while healthy, the bundled rows otherwise), else the bundled rows.
  // P4: the session part of each adapter row as the engine built it, for providers()
  // (Settings). The bundled-array path keeps none (built-ins have their own panels).
  const rowInstances = /* @__PURE__ */ new WeakMap();
  const watched = (handle) => handle && Object.freeze({ ...handle, instantiate(row, host) {
    const made = handle.instantiate(row, host);
    if (made?.row) rowInstances.set(made.row, made.instance);
    return made;
  } });
  let attachedProviders;
  try {
    attachedProviders = watched(options.agentProviders?.attach(models, { builtins: coreProviderContributions(PROVIDER_ROWS) }));
  } catch (error) {
    console.error("Model provider plugins unavailable", error);
  }
  // P3: the rows changed (a plugin provider arrived or went): republish what depends on them.
  let providersChanged = () => {
  };
  const providers = createSessionProviders({
    models,
    rows: attachedProviders ?? PROVIDER_ROWS,
    recovery,
    onChange: () => providersChanged(),
    host: {
      transport: () => options.fetch ?? lastResortFetch ?? globalThis.fetch.bind(globalThis),
      credentials: { chatgpt: options.chatgpt, claude: options.claude },
      env: nativeEnvironment,
      demoTokensPerSecond: options.demoTokensPerSecond,
      messages: { textOf: (...args) => conversationParts.textOf(...args), attachedUserPresentation }
    },
    storedModel: async (id) => (await harness.snapshot(AgentDoc, id, context))?.model
  });
  // Subagent model API (agent.harness@1 models).
  const resolveModel = (spec, parent, signal) => providers.resolveModel(spec, parent, signal);
  const listModels = (parent, signal) => providers.listModels(parent, signal);
  const clampThinking = (ref, level) => providers.clampThinking(ref, level);
  let sending = false;
  let transitioning = false;
  let transitionPromise = Promise.resolve();
  let metadata;
  const pendingModelSettings = new Map();
  const conversations = /* @__PURE__ */ new Map();
  const attachmentRecords = /* @__PURE__ */ new Map();
  let harness;
  // X3b: the session-tail/-threads/-tree parts (core-conversations), chosen once the Harness is open.
  let conversationParts = BUNDLED_CONVERSATIONS;
  // Default selection, read live by pi-durable at every use: the core list followed
  // by accepted plugin extensions, so new plugins join conversations that did not
  // exclude them (exclusions: pi.agent extensions.remove, see agent-extensions.js).
  // Native: prompt, self-forming-native, subagents, servers (self-forming-workspace is
  // installed but not selected, as before); otherwise the registry order: the adapter's
  // essential groups by order, i.e. prompt (core-prompt, -10), then self-forming-workspace.
  const coreSelection = () => nativeEnvironment ? [promptExtension(), nativeExtension(), subagentsExtension(), serversExtension()].filter(Boolean) : void 0;
  const harnessSettings = { compaction: { enabled: true }, retry: RETRY_SETTINGS, progress: { partialIntervalMs: 60 } };
  Object.defineProperty(harnessSettings, "extensions", { enumerable: true, get: () => extensionsAdapter.selection(coreSelection(), registry) });
  // Core agent tools (self-forming-native, self-forming-workspace) and prompt sections
  // (self-forming-prompts) are contributions of essential built-in plugins. The bundled
  // copies are installed right here, before the harness opens: no request, resume or
  // recovery waits for plugin composition to have them, and they stay when composition
  // fails or is slow. Once the page runtime is connected its own core contributions
  // replace them in place (same names, tools and sections) while they are healthy; a
  // runtime copy that fails, stops or cannot be built hands back to the bundled copy.
  // The app's own skills (self-rebuild, plugins) arrive the same way, and so does
  // self-forming-servers (core-servers): pending Server tasks persisted in the database
  // find their task definition as soon as the Harness opens, as before A4. Likewise
  // self-forming-subagents (core-subagents, A5) for pending subagent anchor/reporter/stop tasks.
  const detachAgentExtensions = extensionsAdapter.attach(registry, {
    host: agentHost,
    builtins: [...coreAgentContributions({ host: agentHost, builders: coreBuilders }), ...coreSkillContributions({ host: agentHost })]
  });
  // Readiness barrier: no model request (resume, send) before plugin composition, at most ~5 s per page
  // (agent tools and model providers wait side by side, within the same budget).
  const pluginsReady = Promise.all([agentExtensions?.ready?.(), options.agentProviders?.ready?.()]).catch(() => {
  });
  try {
    harness = await Harness.open(storage, {
      models,
      registry,
      ...nativeEnvironment ? { env: () => nativeEnvironment } : {},
      settings: harnessSettings,
      onReport(error) {
        lastError = error instanceof Error ? error.message : String(error);
        snapshot = { ...snapshot, error: lastError };
        publish();
      }
    }, context);
  } catch (error) {
    endHarness();
    detachAgentExtensions();
    attachedProviders?.detach();
    serverSession?.close();
    try {
      await storage.close(context);
    } catch {
    }
    throw error;
  }
  harnessState = "open";
  reportHarness(harnessHandle);
  // pi-durable 1.2+ (README "Errors"): a storage error fails the Harness, which closes itself; later
  // calls reject with SessionFailed. harness.closed settles with {reason: "failed", error}: show it and
  // ask the page (agent-sessions.js sessionFailed) to reopen, which is how upstream recovers.
  let failure;
  void harness.closed?.then((end) => {
    if (end?.reason !== "failed" || closed) return;
    failure = end.error ?? new Error("Conversation storage failed");
    const reason = failure instanceof Error ? failure.message : String(failure);
    lastError = `The conversation storage failed (${reason}); reopening\u2026`;
    snapshot = { ...snapshot, error: lastError };
    publish();
    endHarness();
    const listener = typeof options.onFailed === "function" ? options.onFailed : pageSessionFailureListener();
    try {
      listener?.(session, failure);
    } catch (error) {
      console.error("Session failure listener failed", error);
    }
  });
  conversationParts = await enginePart(options, "conversations.engine", BUNDLED_CONVERSATIONS);
  const { createTail, renderMessages, ThreadsDoc, agentCopy, createThreads, createTree } = conversationParts;
  const threads = createThreads({
    harness, context, workspace, nativeEnvironment, conversations, ownedMeta, drafts, attachmentRecords,
    ensureOpen: () => ensureOpen(),
    publish,
    refreshMetadata: () => refreshMetadata(),
    threadSnapshot: () => threadSnapshot(),
    shared: {
      get metadata() { return metadata; },
      set metadata(value) { metadata = value; },
      get snapshot() { return snapshot; },
      set snapshot(value) { snapshot = value; },
      get closed() { return closed; },
      get sending() { return sending; },
      get conversation() { return conversation; },
      get session() { return session; }
    }
  });
  const { describe, loadDraftAttachments, reconcileDraftAttachments, queueMetadata } = threads;
  let conversation;
  let watch;
  const reportTailError = (error) => {
    lastError = error instanceof Error ? error.message : String(error);
    if (closed) return;
    snapshot = { ...snapshot, error: lastError };
    publish();
  };
  const { openTail } = createTail({ harness, storage, context, conversations });
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
    const initialModelSettings = new Map();
    for (const id of conversations.keys()) initialModelSettings.set(id, providers.fromAgent(await harness.snapshot(AgentDoc, id, context)));
    await harness.commit(async (tx) => {
      const state = await tx.doc(ThreadsDoc);
      for (const { id } of conversations.values()) {
        if (!state.threads[String(id)]) state.threads[String(id)] = {
          title: id === main.id ? "Main" : `Thread ${state.nextThread++}`,
          draft: ""
        };
        // Migrate each existing chat from its own agent, never the selected UI. A provider
        // no row owns ("provider:<id>", display only) is not stored: read again later.
        if (!state.threads[String(id)].modelSettings && initialModelSettings.get(id).available !== false) state.threads[String(id)].modelSettings = initialModelSettings.get(id);
      }
      if (!conversations.has(state.selectedId)) state.selectedId = main.id;
    }, context);
    metadata = await harness.snapshot(ThreadsDoc, context);
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
    for (const id of conversations.keys()) {
      await harness.commit(async (tx) => {
        await configurePrompt(tx, id, {});
      }, context);
      await (await harness.conversation(id, context)).configure({
        instructions: null,
        ...nativeEnvironment ? { cwd: nativeEnvironment.cwd } : {}
      }, context);
    }
    conversation = await harness.conversation(metadata.selectedId, context);
    await loadDraftAttachments(conversation.id);
    watch = await openTail(conversation, reportTailError);
    await reconcileDraftAttachments(watch.value);
  } catch (error) {
    reportHarness(null);
    detachAgentExtensions();
    attachedProviders?.detach();
    serverSession?.close();
    endHarness();
    try {
      await harness.close(context);
    } catch {
    }
    throw error;
  }
  const treeApi = createTree({ harness, storage, context, describe, ensureOpen: () => ensureOpen(), shared: {
    get metadata() { return metadata; },
    get conversation() { return conversation; },
    threadsKind: ThreadsDoc.definition?.kind,
    isActivityTask
  } });
  const { ownedNaming } = treeApi;
  const kindOf = (id) => ownedMeta.get(id)?.kind ?? (id === ROOT_CONVERSATION_ID ? "main" : conversations.get(id)?.parent ? "fork" : "thread");
  const selectedModelSettings = () => ({ ...(ownedMeta.has(conversation.id)
    ? providers.fromAgent(watch.value.docs["pi.agent"])
    : providers.read(pendingModelSettings.get(conversation.id) ?? metadata.threads[String(conversation.id)]?.modelSettings ?? providers.fromAgent(watch.value.docs["pi.agent"]))) });
  const threadSnapshot = () => ({
    modelSettings: selectedModelSettings(),
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
    if (!next && !queued && !sending) providers.clearTransientKeys();
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
      mode: providers.modeOf(agent?.model?.provider),
      modelId: agent?.model?.modelId ?? "faux-1",
      thinkingEffort: agent?.thinkingLevel ?? "off",
      ...threadSnapshot(),
      ...retrySnapshot(view.docs["pi.live"]),
      ...lastError ? { error: lastError } : {}
    };
    publish();
    scheduleActivity();
    if (anyBusy) ensurePolling();
  };
  const observe = (selectedWatch) => selectedWatch.start(async (view) => {
    if (watch === selectedWatch) update(view);
  });
  paused = false;
  update(watch.value);
  observe(watch);
  providersChanged = () => {
    if (closed) return;
    snapshot = { ...snapshot, mode: providers.modeOf(watch.value.docs["pi.agent"]?.model?.provider), ...threadSnapshot() };
    publish();
  };
  const refresh = async () => {
    const selected = conversation;
    const selectedWatch = watch;
    const view = await selectedWatch.refresh();
    if (selected === conversation && selectedWatch === watch) update(view);
  };
  // Saved work of pending tasks/submissions waits for its provider's credentials
  // (recovery holds by mode); credential changes restore it (session-providers.js).
  providers.registerSaved(recoveredModels.values());
  const ensureOpen = () => {
    if (closed) throw new Error("The conversation is closed.");
  };
  const transition = (work) => {
    ensureOpen();
    if (transitioning || sending) throw new Error("Wait for the current message or thread change to finish.");
    transitioning = true;
    const pending = (async () => {
      try {
        await threads.metadataTail;
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
        await harness.commit(async (tx) => {
          await configurePrompt(tx, selected.id, {});
        }, context);
        await selected.configure({
          instructions: null,
          ...nativeEnvironment ? { cwd: nativeEnvironment.cwd } : {}
        }, context);
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
  const session = {
    get snapshot() {
      return snapshot;
    },
    workspace,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async send(text, config = {}, conversationId = conversation.id) {
      ensureOpen();
      if (conversationId !== conversation.id) throw new Error("The conversation changed before the message was sent.");
      config = { ...selectedModelSettings(), ...config };
      if (sending || transitioning) throw new Error("Wait for the current message or thread change to finish.");
      sending = true;
      try {
        await threads.metadataTail;
        ensureOpen();
        await pluginsReady;
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
        if (owned) await providers.ensureStored(id, config);
        if (snapshot.busy) {
          lastError = void 0;
          await target.submit({ type: "input", content: attachmentUserContent(trimmed, attachments), whenBusy: "steer" }, context);
        } else if (owned) {
          await providers.installSignedIn();
          lastError = void 0;
          await target.submit({ type: "input", content: attachmentUserContent(trimmed, []), whenBusy: "reject" }, context);
        } else {
          // A provider no row owns is refused before anything is written (P3), and so
          // is a send its provider refuses: configure first, then save the choice.
          providers.checked(config);
          const configuration = await providers.configure(config);
          // Keep programmatic send callers compatible, too. Only whitelist
          // preferences; API keys remain in memory and never enter ThreadsDoc.
          await queueMetadata(async () => {
            await harness.commit(async (tx) => {
              const state = await tx.doc(ThreadsDoc);
              state.threads[String(id)].modelSettings = providers.normalize(config);
            }, context);
            await refreshMetadata();
          });
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
        await pluginsReady;
        ensureOpen();
        await providers.installSignedIn();
        if (providers.needsCredentials(config.mode)) await providers.configure(config);
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
      runHooks(stopHooks, "onStop");
      const target = conversation;
      if (ownedMeta.has(target.id)) await target.abort(context, { background: true });
      else await target.abort(context);
      if (paused) {
        let remaining = 0;
        try {
          remaining = (await harness.inspect(context)).tasks.filter(isActivityTask).length;
        } catch {
        }
        if (!remaining) paused = false;
      }
      if (target === conversation) await refresh();
      await refreshActivity();
    },
    tree: treeApi.methods.tree,
    watchTree: treeApi.methods.watchTree,
    /** Watches any conversation; listener({ messages, busy, model, title }) runs on every change. Returns an async stop(). */
    async viewConversation(id, listener) {
      ensureOpen();
      if (typeof listener !== "function") throw new TypeError("A listener function is required.");
      const target = await harness.conversation(id, context);
      if (!target) throw new Error(`Conversation ${id} does not exist.`);
      await treeApi.index.ready();
      const title = treeApi.index.nodes().find((node) => node.id === id)?.title ?? "";
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
    async sendTo(id, text, config = {}, options = {}) {
      ensureOpen();
      const trimmed = String(text ?? "").trim();
      if (!trimmed) throw new Error("Write a message to send.");
      await providers.installSignedIn();
      const target = await harness.conversation(id, context);
      if (!target) throw new Error(`Conversation ${id} does not exist.`);
      await providers.ensureStored(id, config);
      await pluginsReady;
      ensureOpen();
      // options.whenBusy "follow-up" queues behind a running reply; options.requestId makes a repeat idempotent (pi-durable).
      await target.submit({ type: "input", content: trimmed, ...options.whenBusy === "follow-up" ? {} : { whenBusy: "steer" }, ...options.requestId ? { requestId: String(options.requestId) } : {} }, context);
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
    /** Plugins adding agent tools, with this conversation's selection: [{id, name, state, reason?, tools, errors, toggle, enabled}]. */
    plugins() {
      if (closed || !agentExtensions) return [];
      return agentExtensions.describe(watch.value.docs["pi.agent"]);
    },
    /** Include or exclude one plugin's agent extensions in one top-level conversation, from its next model request. */
    async setPluginEnabled(pluginId, enabled, conversationId = conversation.id) {
      ensureOpen();
      if (!agentExtensions) throw new Error("Plugins are not available.");
      if (!conversations.has(conversationId) || ownedMeta.has(conversationId)) throw new Error("Subagents use the plugins of their owner.");
      // One commit reads and edits pi.agent, so two quick toggles cannot lose each other.
      await harness.commit(async (tx) => {
        const stored = await tx.doc(AgentDoc, conversationId);
        const current = stored?.extensions === void 0 ? void 0 : JSON.parse(JSON.stringify(stored.extensions));
        await configure(tx, conversationId, { extensions: agentExtensions.change({ extensions: current }, pluginId, Boolean(enabled)) });
      }, context);
      if (!closed && conversationId === conversation.id) await refresh();
    },
    /**
     * Unfinished durable work that needs the given contributed extensions (asked before a
     * plugin is disabled, docs/plugins.md §9a): non-terminal tasks of their task kinds and
     * pending tool calls of their tools, in every conversation of this harness. Bounded
     * cost: the harness's in-memory task list plus at most 16 live-document reads.
     * Returns {tasks, conversations: [ids], partial}; partial = some calls not identified.
     */
    async pendingWorkFor(extensionNames = [], { tools: extraTools = [], tasks: extraKinds = [] } = {}) {
      ensureOpen();
      const wanted = new Set(extensionNames);
      const tools = new Set(extraTools), kinds = new Set(extraKinds);
      for (const extension of registry.snapshot().installed()) {
        if (!wanted.has(extension.name)) continue;
        for (const tool of extension.tools ?? []) tools.add(tool.name);
        for (const task of extension.tasks ?? []) kinds.add(task.definition.name);
      }
      const result = { tasks: 0, conversations: [], partial: false };
      if (!tools.size && !kinds.size) return result;
      const inspected = await harness.inspect(context);
      const where = /* @__PURE__ */ new Set();
      const toolTasks = /* @__PURE__ */ new Map();
      for (const { record } of inspected.tasks) {
        if (record.state?.status === "terminal") continue;
        if (kinds.has(record.kind)) {
          result.tasks++;
          where.add(record.conversationId);
        } else if (record.kind === "pi.tool" && tools.size) {
          if (!toolTasks.has(record.conversationId)) toolTasks.set(record.conversationId, []);
          toolTasks.get(record.conversationId).push(record.id);
        }
      }
      let lookups = 0;
      for (const [conversationId, taskIds] of toolTasks) {
        if (closed || lookups++ >= 16) {
          result.partial = true;
          break;
        }
        let timer;
        const live = await Promise.race([
          harness.snapshot(LiveDoc, conversationId, context).catch(() => void 0),
          new Promise((resolve) => { timer = setTimeout(resolve, 3e3); })
        ]);
        clearTimeout(timer);
        for (const taskId of taskIds) {
          const name = (live?.tools ?? []).find((tool) => tool.taskId === taskId)?.name;
          if (name === void 0) result.partial = true;
          else if (tools.has(name)) {
            result.tasks++;
            where.add(conversationId);
          }
        }
      }
      result.conversations = [...where].sort((a, b) => a - b);
      return result;
    },
    /** Model providers of this session for Settings (agent.sessions@1, P4). Read-only: nothing is installed or released. */
    providers() {
      if (closed) return [];
      const modes = new Set([...attachedProviders?.rows() ?? [], ...PROVIDER_ROWS].map((row) => row.mode));
      return [...modes].map((mode) => providers.rowOf(mode)).filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((row) => providerEntry(row, rowInstances.get(row)));
    },
    /** {label, waitingLabel} of a mode or "provider:<id>": a current row, else one seen earlier (agent.sessions@1, C7: chat #mode and recovery names). */
    providerLabel(key) {
      const names = providers.labelsOf(String(key));
      return names ? { label: names.label, waitingLabel: names.waitingLabel ?? names.label } : void 0;
    },
    /** Save next-reply preferences immediately without changing a running agent. */
    async setModelSettings(config, conversationId = conversation.id) {
      ensureOpen();
      if (transitioning || sending) throw new Error("Wait for the current message or thread change to finish.");
      if (!conversations.has(conversationId) || ownedMeta.has(conversationId)) throw new Error("Subagent models are managed by their owner.");
      const choice = providers.checked(config);
      pendingModelSettings.set(conversationId, choice);
      snapshot = { ...snapshot, ...threadSnapshot() };
      publish();
      return queueMetadata(async () => {
        try {
          await harness.commit(async (tx) => {
            const state = await tx.doc(ThreadsDoc);
            state.threads[String(conversationId)].modelSettings = choice;
          }, context);
          // Read the committed state before removing the optimistic value.
          metadata = await harness.snapshot(ThreadsDoc, context);
        } finally {
          if (pendingModelSettings.get(conversationId) === choice) pendingModelSettings.delete(conversationId);
          if (!closed) {
            snapshot = { ...snapshot, ...threadSnapshot() };
            publish();
          }
        }
      });
    },
    setDraft: threads.methods.setDraft,
    addAttachments: threads.methods.addAttachments,
    removeAttachment: threads.methods.removeAttachment,
    async switchConversation(id) {
      ensureOpen();
      if (id === conversation.id) return snapshot.conversation;
      return transition(async () => {
        let selected;
        try {
          selected = await harness.conversation(id, context);
        } catch {
          selected = void 0;
        }
        if (!selected) throw new Error("This conversation is not available.");
        return selectConversation(selected);
      });
    },
    /** Start a fresh conversation (no history) with the current model settings and the current tool set. */
    async newThread() {
      return transition(async () => {
        // Even an empty chat can have its own saved choices; never recycle it.
        // Only the stored choice is inherited (P3: never a display-only "provider:<id>").
        const inheritedModelSettings = providers.stored(selectedModelSettings());
        let baseAgent = watch.value.docs["pi.agent"];
        if (ownedMeta.has(conversation.id)) {
          try {
            baseAgent = await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context) ?? baseAgent;
          } catch {
          }
        }
        const created = await queueMetadata(() => harness.createConversation({
          ownership: { kind: "ownerless" },
          agent: agentCopy(baseAgent),
          init: async (tx, id) => {
            const state = await tx.doc(ThreadsDoc);
            state.threads[String(id)] = { title: `Conversation ${state.nextThread++ + 1}`, draft: "", ...inheritedModelSettings ? { modelSettings: inheritedModelSettings } : {} };
            state.selectedId = id;
          }
        }, context));
        const record = await storage.conversation(created.id, context);
        conversations.set(created.id, record);
        return selectConversation(created, false);
      });
    },
    archiveConversation: threads.methods.archiveConversation,
    renameConversation: threads.methods.renameConversation,
    unarchiveConversation: threads.methods.unarchiveConversation,
    async forkThread() {
      return transition(async () => {
        if (ownedMeta.has(conversation.id)) throw new Error("Fork a top-level conversation.");
        const source = conversation;
        const inheritedModelSettings = providers.stored(selectedModelSettings());
        const tail = (await source.entries({}, 1, void 0, context)).items[0];
        ensureOpen();
        const createOptions = {
          ownership: { kind: "ownerless" },
          init: async (tx, id) => {
            const state = await tx.doc(ThreadsDoc);
            state.threads[String(id)] = {
              title: `Thread ${state.nextThread++}`,
              draft: "",
              parentId: source.id,
              ...inheritedModelSettings ? { modelSettings: inheritedModelSettings } : {}
            };
            state.selectedId = id;
          }
        };
        const fork = await queueMetadata(() => tail ? source.fork(tail.id, createOptions, context) : harness.createConversation({
          ...createOptions,
          agent: agentCopy(watch.value.docs["pi.agent"])
        }, context));
        const record = await storage.conversation(fork.id, context);
        conversations.set(fork.id, record);
        return selectConversation(fork, false);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      reportHarness(null);
      providers.close();
      clearTimeout(activityTimer);
      clearTimeout(pollTimer);
      activityTimer = pollTimer = void 0;
      treeApi.index.close();
      runHooks(closeHooks, "onClose");
      closeHooks.clear();
      stopHooks.clear();
      // Only this session's registry stops following plugins; the page runtime stays.
      detachAgentExtensions();
      attachedProviders?.detach();
      serverSession?.close();
      listeners.clear();
      await transitionPromise;
      await threads.metadataTail;
      endHarness();
      const closing = harness.close(context);
      providers.clearTransientKeys();
      // A failed Harness has already closed itself; its close and the watch stop only settle.
      const settled = (promise) => failure ? promise.catch(() => {
      }) : promise;
      try {
        await Promise.all([settled(closing), settled(watch.stop())]);
      } finally {
        if (!nativeEnvironment?.backgroundExecution) await nativeEnvironment?.cleanup(context);
      }
    }
  };
  // Pending runs resume only after plugin composition (or its 5 s deadline), so a
  // recovered plugin tool call does not fail just because its plugin was still loading.
  // servers@1 (servers-service.js) uses this session from the same point on.
  const startTasks = () => {
    harness.resume();
    serverSession?.connectHost(agentHost);
    resolveStarted();
  };
  if (!agentExtensions) startTasks();
  else void pluginsReady.then(() => {
    if (!closed) startTasks();
  }).catch(reportTailError);
  for (const mode of providers.recovering) if (providers.rowOf(mode).auth !== "transient-key") void providers.restore(mode);
  return session;
}
export {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  RETRY_SETTINGS,
  getThinkingEfforts,
  openAppSession,
  retrySnapshot
};
