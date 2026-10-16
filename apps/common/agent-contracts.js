// apps/common/agent-contracts.js
// Service contracts of the future core-agent plugin: agent.sessions@1 (chat-facing) and
// agent.harness@1 (subagents, servers, report attribution, toolchain, plugins).
// Source: docs/plugins-providers-agent-core.md §B2, step C0. Plain frozen data, no imports.
// Nothing imports this module yet; tests/plugin-c0-*.test.mjs check that the session
// returned by openAppSession (session.js) and its consumers match it, so drift is caught.
// A change here changes a public contract: add a new version (@2) instead of editing @1.
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

/** Message the page facade throws while no session is open (conversations.js ready()). */
const SESSION_NOT_OPEN_MESSAGE = "Still opening the conversation, try again in a moment.";

const AGENT_SESSIONS_V1 = deepFreeze({
  id: "agent.sessions@1",
  service: "agent.sessions",
  version: 1,
  // Page-owned facade (C1): current() -> session | null; onSession(listener) -> unsubscribe;
  // subscribe(listener) follows the current session across reopen. C7 (additive): the
  // read-only getter foreground (false while the app is in the background; sessions close
  // then), which the chat (core-chat) reads to lock its controls.
  facade: ["current", "onSession", "subscribe", "foreground"],
  /** Read-only getters of the facade (C7). */
  facadeGetters: ["foreground"],
  notOpenMessage: SESSION_NOT_OPEN_MESSAGE,
  // Members of the session object, grouped as in §B2. Same signatures/results as session.js.
  groups: {
    state: ["snapshot", "subscribe"],
    replies: ["send", "resume", "stop", "steer"],
    composer: ["setDraft", "setModelSettings", "addAttachments", "removeAttachment"],
    // Drawer index (additive, docs/plugins-ui-editions.md "Drawer index"): watchTree(listener) ->
    // unsubscribe. listener(nodes) at once with the cheap list (same nodes and order as tree():
    // depth-first, oldest first), then whenever details (model, busy, empty) arrive or a commit
    // changes the tree (conversation created, renamed, archived, run started/finished, subagent
    // named); listener(null, error) if the list cannot be built. Kept by the session from commit
    // events, no rescans; tree() is answered from the same index. Follows one session: subscribe
    // again after onSession reports a new one.
    conversations: ["tree", "watchTree", "switchConversation", "newThread", "forkThread", "archiveConversation", "unarchiveConversation", "renameConversation"],
    otherConversations: ["viewConversation", "sendTo", "stopConversation"],
    plugins: ["plugins", "setPluginEnabled", "pendingWorkFor"],
    // P4 (read-only, for Settings): providers() -> [{mode, label, auth, defaultModelId,
    // available, status, thinkingEfforts(modelId), catalog(), models(signal),
    // connect?(), subscribe?(listener)}], one per model provider row of this session.
    // C7 (additive): providerLabel("<mode>" | "provider:<id>") -> {label, waitingLabel} |
    // undefined: a current row's names, else a row seen earlier (missing providers, P3).
    providers: ["providers", "providerLabel"]
  },
  /** Read-only getters on the session object. */
  getters: ["snapshot"],
  /** Callable members (every group member except the getters). */
  methods: [
    "subscribe",
    "send", "resume", "stop", "steer",
    "setDraft", "setModelSettings", "addAttachments", "removeAttachment",
    "tree", "watchTree", "switchConversation", "newThread", "forkThread", "archiveConversation", "unarchiveConversation", "renameConversation",
    "viewConversation", "sendTo", "stopConversation",
    "plugins", "setPluginEnabled", "pendingWorkFor",
    "providers", "providerLabel"
  ],
  /** Signatures as documented (parameter names only; defaults live in session.js). */
  signatures: {
    subscribe: ["listener"],
    send: ["text", "config", "conversationId"],
    resume: ["config"],
    stop: [],
    steer: ["text"],
    setDraft: ["text"],
    setModelSettings: ["config", "conversationId"],
    addAttachments: ["files", "conversationId"],
    removeAttachment: ["id"],
    tree: [],
    watchTree: ["listener"],
    switchConversation: ["id"],
    newThread: [],
    forkThread: [],
    archiveConversation: ["id"],
    unarchiveConversation: ["id"],
    renameConversation: ["id", "title"],
    viewConversation: ["id", "listener"],
    sendTo: ["id", "text", "config", "options"],
    stopConversation: ["id"],
    plugins: [],
    setPluginEnabled: ["pluginId", "enabled", "conversationId"],
    pendingWorkFor: ["extensionNames", "{tools, tasks}"],
    providers: [],
    providerLabel: ["key"]
  },
  /** Added by a later step; not offered by session.js yet (providers() landed with P4). */
  planned: {},
  /** Members of today's session object that are deliberately NOT part of the contract. */
  excluded: {
    close: "lifecycle, owned by core-agent (createSessionCloser)",
    workspace: "goes through execution@1"
  },
  snapshot: {
    required: ["messages", "truncated", "loadingHistory", "busy", "paused", "recoveryProviders", "anyBusy", "owned", "title", "kind", "persistence", "mode", "modelId", "thinkingEffort", "modelSettings", "conversation", "threads"],
    // retry (additive): {attempt, at, error} while the reply waits to retry (pi.live.generation.retry).
    optional: ["error", "retry"]
  },
  /** snapshot.conversation (the selected conversation, with its draft attachments). */
  conversation: {
    required: ["id", "title", "isMain", "draft", "attachments"],
    optional: ["archived", "parentId"]
  },
  /** Each entry of snapshot.threads. */
  thread: {
    required: ["id", "title", "isMain", "draft"],
    optional: ["archived", "parentId"]
  }
});

const AGENT_HARNESS_V1 = deepFreeze({
  id: "agent.harness@1",
  service: "agent.harness",
  version: 1,
  // Page facade: current() -> handle | null; onSession(listener) gets the handle after
  // Harness.open and null before close. Session-bound contributions get it as host.harness.
  facade: ["current", "onSession"],
  /** Plain values of the handle. started: Promise resolved once tasks resumed (startTasks). */
  values: ["rootConversationId", "context", "env", "workspace", "started"],
  /** Methods of the handle, forwarded to the session's pi-durable Harness under the same name. */
  methods: ["abortTask", "abortSubmission", "snapshot", "watchDoc", "commit", "inspect", "conversation", "subscribeCommits", "getTask", "waitForTask"],
  /** Session hooks (added additively in step C5, for core-self-update's app-update handoff):
   *  onStop(fn) runs when the user stops the selected reply, onClose(fn) when the session starts
   *  closing (before the Harness closes); each returns an unsubscribe function and may be
   *  registered before Harness.open. Not forwarded to the Harness. */
  hooks: ["onStop", "onClose"],
  /** Read-only storage view (forwarded to the session's Storage under the same name). */
  storage: ["conversation", "scanConversations", "scanSubmissions", "task"],
  /** Grouped helpers, and the session.js function each one forwards today (createSubagentExtensions options). */
  models: { resolve: "resolveModel", list: "listModels", clampThinking: "clampThinking" },
  tools: { get: "getTool", names: "toolNames" },
  prompt: { configure: "configurePrompt" },
  /** Never on the handle. Commit observers must never call session methods. */
  forbidden: ["close", "resume", "root"],
  /** Not in the §B2 list but used today; kept so the contract matches the code (see C0 report). */
  addedToDocList: {
    getTask: "servers-service.js connect(): harness.getTask",
    waitForTask: "servers-service.js connect(): harness.waitForTask"
  }
});

const AGENT_CONTRACTS = deepFreeze({
  [AGENT_SESSIONS_V1.id]: AGENT_SESSIONS_V1,
  [AGENT_HARNESS_V1.id]: AGENT_HARNESS_V1
});

export {
  AGENT_CONTRACTS,
  AGENT_HARNESS_V1,
  AGENT_SESSIONS_V1,
  SESSION_NOT_OPEN_MESSAGE
};
