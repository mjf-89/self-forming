// plugins/core-conversations/web/session-tree.js
// Conversation tree and owned-conversation naming (C3c, out of session.js); the event-driven
// conversation index behind tree()/watchTree() ("Drawer index", docs/plugins-ui-editions.md).
// The selected conversation and the thread metadata the engine reassigns are reached
// through the `shared` accessor object the engine passes in.
import { AgentDoc, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, defineDoc } from "../../../library/pi-durable.js";
// Read-only view of the permanent doc kind self-forming.subagents (written by the
// core-subagents plugin, A5; same kind/version/scope as its definition): background
// subagents are named in the tree by the name given at spawn. Without that plugin the
// doc is empty and owned conversations show as "Subagent" tasks.
var Subagents = defineDoc({
  kind: "self-forming.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} })
});
// Conversation index (docs/plugins-ui-editions.md "Drawer index"): one per session, built on first use.
// The cheap list comes from one conversation scan, the in-memory threads metadata and the subagent
// registries; details (model, busy, empty) are filled lazily with at most DETAIL_CONCURRENCY bounded
// lookups. Afterwards it is kept current only from commit events: the observer reads the changes a commit
// carries and never calls a Session API (AGENTS.md "How activation works"); it schedules one coalesced publish.
var LOOKUP_MS = 4e3;
var DETAIL_CONCURRENCY = 2;
var PUBLISH_MS = 30;
var TIMED_OUT = Symbol("timed out");
// Busy = the conversation's pi.live has a run, or its pi.inbox holds queued input. A lookup that timed out
// still applies when it answers late, and a row whose busy state is not known yet is asked again (backing off)
// until it is: there is no start-up guess.
var BUSY_RETRY_MS = 2e3;
var BUSY_RETRY_MAX_MS = 15e3;
function hasQueuedInput(inbox) {
  return Array.isArray(inbox?.items) && inbox.items.some((item) => item?.mode !== "write");
}
function bounded(promise, late = void 0) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => void 0),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(late), LOOKUP_MS);
    })
  ]).finally(() => clearTimeout(timer));
}
function createConversationIndex({ harness, storage, context, shared, Subagents, ThreadsKind = "self-forming.threads" }) {
  const AGENT_KIND = AgentDoc.definition?.kind ?? "pi.agent";
  const LIVE_KIND = LiveDoc.definition?.kind ?? "pi.live";
  const INBOX_KIND = InboxDoc.definition?.kind ?? "pi.inbox";
  const SUBAGENTS_KIND = Subagents.definition?.kind ?? "self-forming.subagents";
  const records = /* @__PURE__ */ new Map();
  const agentsByParent = /* @__PURE__ */ new Map();
  // id -> { value, known }: known = from a commit or a finished lookup (a commit always wins over a lookup).
  const busy = /* @__PURE__ */ new Map();
  const queued = /* @__PURE__ */ new Map();
  const model = /* @__PURE__ */ new Map();
  const empty = /* @__PURE__ */ new Map();
  let busyRetries = 0;
  let retryTimer;
  let threads;
  let building;
  let filling;
  let built = false;
  let closed = false;
  let unsubscribe;
  let timer;
  let lastKey;
  const listeners = /* @__PURE__ */ new Set();
  const set = (map, id, value) => {
    const previous = map.get(id);
    map.set(id, { value, known: true });
    return !previous || !previous.known || previous.value !== value;
  };
  const addRecord = (record) => {
    if (!record || typeof record.id !== "number") return false;
    const previous = records.get(record.id);
    records.set(record.id, { id: record.id, parent: record.parent, owner: record.owner });
    return !previous;
  };
  // Commit observer: plain bookkeeping on the values the commit carries, then one deferred publish.
  const observe = (commit) => {
    if (closed) return;
    let changed = false;
    try {
      for (const change of commit?.changes ?? []) {
        if (change.type === "conversation") {
          if (addRecord(change.value)) {
            changed = true;
            // A conversation forked from an entry shows its parent's history; any other starts empty.
            if (!empty.get(change.value.id)?.known) empty.set(change.value.id, { value: change.value.parent === void 0, known: true });
          }
        } else if (change.type === "entry") {
          const id = change.value?.conversationId;
          if (id !== void 0 && empty.get(id)?.value !== false) changed = set(empty, id, false) || changed;
        } else if (change.type === "document") {
          const kind = change.record?.kind;
          const id = change.conversationId;
          const value = change.value;
          if (kind === ThreadsKind) {
            if (value?.threads) {
              threads = value.threads;
              changed = true;
            }
          } else if (kind === SUBAGENTS_KIND && id !== void 0) {
            agentsByParent.set(id, value?.agents ?? {});
            changed = true;
          } else if (kind === LIVE_KIND && id !== void 0) {
            changed = set(busy, id, value?.run !== void 0 && value !== null) || changed;
          } else if (kind === INBOX_KIND && id !== void 0) {
            changed = set(queued, id, hasQueuedInput(value)) || changed;
          } else if (kind === AGENT_KIND && id !== void 0) {
            const m = value?.model;
            changed = set(model, id, m?.provider && m?.modelId ? `${m.provider}/${m.modelId}` : "") || changed;
          }
        }
      }
    } catch {
    }
    if (changed && built) schedule();
  };
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = void 0;
      publish();
    }, PUBLISH_MS);
  };
  // A registry that did not answer in time stays unknown (its rows are not taken for run helpers) and is asked again by details().
  const loadAgents = async (parentId) => {
    const value = await bounded(harness.snapshot(Subagents, parentId, context), TIMED_OUT);
    if (value === TIMED_OUT || agentsByParent.has(parentId)) return;
    agentsByParent.set(parentId, value?.agents ?? {});
  };
  const threadOf = (id) => (threads ?? shared.metadata?.threads)?.[String(id)];
  const isUnknown = (id) => !busy.get(id)?.known || !queued.get(id)?.known;
  const FLAGS = [
    [busy, LiveDoc, (live) => live?.run !== void 0 && live !== null],
    [queued, InboxDoc, hasQueuedInput]
  ];
  // Ask again (with growing pauses) for rows whose busy state is still unknown.
  const retryBusy = () => {
    if (closed || retryTimer) return;
    const delay = Math.min(BUSY_RETRY_MS * 2 ** busyRetries++, BUSY_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = void 0;
      for (const id of [...records.keys()]) if (isUnknown(id)) void lookupBusy(id);
    }, delay);
  };
  function lookupFlag([map, doc, read], id) {
    if (closed || map.get(id)?.known) return Promise.resolve();
    const lookup = Promise.resolve().then(() => harness.snapshot(doc, id, context));
    const know = (value) => {
      if (closed || map.get(id)?.known) return;
      map.set(id, { value: read(value), known: true });
      schedule();
    };
    return bounded(lookup.then((value) => ({ value }), () => TIMED_OUT), TIMED_OUT).then((answer) => {
      if (answer !== TIMED_OUT) return know(answer.value);
      // Late or failed: a late answer still applies; ask again meanwhile.
      lookup.then(know, () => {
      });
      retryBusy();
    });
  }
  const lookupBusy = (id) => Promise.all(FLAGS.map((flag) => lookupFlag(flag, id)));
  function nodes() {
    const parentOf = (record) => record.owner?.conversationId ?? record.parent?.conversationId;
    const selectedId = shared.conversation?.id;
    const everyone = [];
    const gone = /* @__PURE__ */ new Set();
    for (const record of records.values()) {
      const id = record.id;
      let kind, title, entry;
      let named = true;
      if (record.owner) {
        named = agentsByParent.has(record.owner.conversationId);
        const agents = agentsByParent.get(record.owner.conversationId) ?? {};
        const found = Object.entries(agents).find(([, candidate]) => candidate?.conversationId === id);
        const name = found?.[0];
        entry = found?.[1];
        if (name !== void 0) {
          kind = "subagent";
          title = name;
        } else {
          kind = "task";
          title = "Subagent";
        }
      } else {
        kind = id === ROOT_CONVERSATION_ID ? "main" : record.parent ? "fork" : "thread";
        title = threadOf(id)?.title ?? (id === ROOT_CONVERSATION_ID ? "Main" : "Thread");
      }
      const isBusy = busy.get(id)?.value === true || queued.get(id)?.value === true;
      const node = { id, parentId: parentOf(record), kind, title, busy: isBusy, selected: id === selectedId, model: model.get(id)?.value ?? "" };
      // Threads archive through ThreadsDoc; a spawned subagent through the archived flag of its registry entry.
      node.archived = kind === "subagent" ? entry?.archived === true : !record.owner && id !== ROOT_CONVERSATION_ID && threadOf(id)?.archived === true;
      // A foreground run helper is one-shot: listed while it works, gone once idle. It stays while its owner's
      // registry or its own busy state is not known yet, and while it is the open conversation.
      if (kind === "task" && named && !isBusy && !isUnknown(id) && !node.selected) gone.add(id);
      node.empty = !record.owner && id !== ROOT_CONVERSATION_ID ? empty.get(id)?.value ?? false : false;
      everyone.push(node);
    }
    const parents = new Map(everyone.map((node) => [node.id, node.parentId]));
    const dropped = (id, seen = /* @__PURE__ */ new Set()) => id !== void 0 && !seen.has(id) && (gone.has(id) || dropped(parents.get(id), seen.add(id)));
    const all = everyone.filter((node) => !dropped(node.id));
    const ids = new Set(all.map((node) => node.id));
    const children = /* @__PURE__ */ new Map();
    const roots = [];
    for (const node of all.sort((a, b) => a.id - b.id)) {
      if (node.parentId !== void 0 && ids.has(node.parentId)) {
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node);
      } else roots.push(node);
    }
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const visit = (node) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      out.push(node);
      for (const child of children.get(node.id) ?? []) visit(child);
    };
    for (const root of roots) visit(root);
    return out;
  }
  function publish(force = false) {
    if (closed || !built || !listeners.size) return;
    const list = nodes();
    const key = JSON.stringify(list);
    if (!force && key === lastKey) return;
    lastKey = key;
    for (const listener of [...listeners]) {
      try {
        listener(list.map((node) => ({ ...node })));
      } catch {
      }
    }
  }
  async function build() {
    unsubscribe = harness.subscribeCommits(observe);
    const scanned = [];
    let cursor;
    do {
      const page = await storage.scanConversations({}, 128, cursor, context);
      scanned.push(...page.items);
      cursor = page.next;
    } while (cursor);
    for (const record of scanned) if (!records.has(record.id)) addRecord(record);
    // Names of owned conversations: the registry of each owner (usually cached by the harness).
    const owners = new Set([...records.values()].filter((record) => record.owner && !agentsByParent.has(record.owner.conversationId)).map((record) => record.owner.conversationId));
    await Promise.all([...owners].map((parentId) => loadAgents(parentId)));
    built = true;
  }
  function ready() {
    if (closed) return Promise.reject(new Error("The conversation is closed."));
    if (!building) {
      building = build().catch((error) => {
        building = void 0;
        try { unsubscribe?.(); } catch {}
        unsubscribe = void 0;
        throw error;
      });
    }
    return building;
  }
  // Details: one AgentDoc, one LiveDoc and (top-level, non-main) one entry page per row, once.
  function details() {
    if (filling) return filling;
    filling = (async () => {
      await ready();
      const unnamed = new Set([...records.values()].filter((record) => record.owner && !agentsByParent.has(record.owner.conversationId)).map((record) => record.owner.conversationId));
      if (unnamed.size) {
        await Promise.all([...unnamed].map((parentId) => loadAgents(parentId)));
        schedule();
      }
      const queue = nodes().map((node) => node.id);
      const worker = async () => {
        while (queue.length && !closed) {
          const id = queue.shift();
          const record = records.get(id);
          if (!record) continue;
          const needsEmpty = !record.owner && id !== ROOT_CONVERSATION_ID && !empty.get(id)?.known;
          const [agent, , page] = await Promise.all([
            model.get(id)?.known ? void 0 : bounded(harness.snapshot(AgentDoc, id, context)),
            lookupBusy(id),
            needsEmpty ? bounded((async () => (await harness.conversation(id, context)).entries({}, 1, void 0, context))()) : void 0
          ]);
          if (closed) return;
          if (agent && !model.get(id)?.known) model.set(id, { value: agent.model?.provider && agent.model?.modelId ? `${agent.model.provider}/${agent.model.modelId}` : "", known: true });
          if (page && !empty.get(id)?.known) empty.set(id, { value: page.items.length === 0, known: true });
          schedule();
        }
      };
      await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
    })();
    filling.catch(() => {
      filling = void 0;
    });
    return filling;
  }
  function watch(listener) {
    listeners.add(listener);
    let active = true;
    ready().then(() => {
      if (!active || closed) return;
      try {
        listener(nodes());
      } catch {
      }
      void details().catch(() => {
      });
    }, (error) => {
      if (!active || closed) return;
      try {
        listener(null, error);
      } catch {
      }
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }
  function close() {
    closed = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = retryTimer = void 0;
    listeners.clear();
    try { unsubscribe?.(); } catch {}
    unsubscribe = void 0;
  }
  return { ready, details, nodes, watch, close, observe };
}
function createTree({ harness, storage, context, describe, ensureOpen, shared }) {
  const namedAgentsOf = async (parentId) => {
    try {
      return (await harness.snapshot(Subagents, parentId, context))?.agents ?? {};
    } catch {
      return {};
    }
  };
  const ownedNaming = async (record, agentsFor = namedAgentsOf) => {
    const name = Object.entries(await agentsFor(record.owner.conversationId)).find(([, entry]) => entry?.conversationId === record.id)?.[0];
    if (name !== void 0) return { kind: "subagent", title: name };
    return { kind: "task", title: "Subagent" };
  };
  const index = createConversationIndex({ harness, storage, context, shared, Subagents, ThreadsKind: shared.threadsKind });
  const methods = {
    /** Conversation tree: main, threads, forks, background subagents and foreground tasks, depth-first, oldest first. Answered from the index once its details are filled. */
    async tree() {
      ensureOpen();
      await index.ready();
      await index.details();
      ensureOpen();
      return index.nodes();
    },
    /**
     * Live tree (agent.sessions@1, additive): listener(nodes) at once with the cheap list (ids, parents, kinds,
     * titles, archived), then whenever details (model, busy, empty) arrive or a commit changes the tree.
     * listener(null, error) if the list cannot be built. Returns unsubscribe().
     */
    watchTree(listener) {
      ensureOpen();
      if (typeof listener !== "function") throw new TypeError("watchTree needs a listener");
      return index.watch(listener);
    }
  };
  return { namedAgentsOf, ownedNaming, methods, index };
}
export {
  createConversationIndex,
  createTree
};
