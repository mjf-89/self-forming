// core-conversations: the conversations drawer as a plugin (step C7 of
// docs/plugins-providers-agent-core.md). Essential built-in (bundle self-forming-core, reload
// "page") that requires agent.sessions@1: conversations.js lists, opens, forks, renames and
// archives conversations through sessions.current() (watchTree, the event-driven list, with
// tree polling for sessions without it; switchConversation, newThread,
// forkThread, renameConversation, archiveConversation, unarchiveConversation). app.js puts the
// drawer's nodes in place at load (mountBundled: the header button looks the same before
// composition) and wires the bundled copy (initConversations) when composition fails or
// core-conversations did not wire it; only the first wiring counts. Page-owned: stopping the
// plugin leaves the drawer as it is. No library import at evaluation.
// X3b: also provides conversations.engine@1, the session engine's conversation parts in this folder
// (session-tail.js, session-threads.js, session-tree.js; they import the library, so they are loaded
// lazily): {load() → {createTail, renderMessages, textOf, ThreadsDoc, agentCopy, createThreads,
// createTree}}. The engine takes them from here while the plugin is active (core-agent hands it the
// runtime's service) and uses its bundled static copies otherwise. Doc kinds are unchanged.
import { initConversations, mountBundled, conversationsMountedBy } from "./conversations.js";
export { initConversations, mountBundled, conversationsMountedBy };
const AGENT_SESSIONS_SERVICE = "agent.sessions";
export const CONVERSATIONS_ENGINE_SERVICE = "conversations.engine";

/** The engine parts of this plugin (conversations.engine@1 load()). */
export async function loadEngineParts() {
  const [tail, threads, tree] = await Promise.all([import("./session-tail.js"), import("./session-threads.js"), import("./session-tree.js")]);
  return Object.freeze({
    createTail: tail.createTail, renderMessages: tail.renderMessages, textOf: tail.textOf,
    ThreadsDoc: threads.ThreadsDoc, agentCopy: threads.agentCopy, createThreads: threads.createThreads,
    createTree: tree.createTree
  });
}

/** Wires the drawer on sessions (agent.sessions@1); by: "core-conversations" or "bundled". */
export function mountConversations({ sessions, by = "bundled", showError } = {}) {
  if (typeof sessions?.current !== "function") throw new TypeError("mountConversations needs the agent.sessions@1 facade");
  const onSession = typeof sessions.onSession === "function" ? (listener) => sessions.onSession(listener) : void 0;
  return initConversations({ getSession: () => sessions.current(), onSession, by, ...showError ? { showError } : {} });
}

export function create({ document: doc = globalThis.document } = {}) {
  return {
    setup(ctx) {
      ctx.provide(CONVERSATIONS_ENGINE_SERVICE, 1, Object.freeze({ load: loadEngineParts }));
      const sessions = ctx.get(AGENT_SESSIONS_SERVICE, 1);
      if (!sessions || !doc) return; // no page (tests, forks)
      mountConversations({ sessions, by: "core-conversations" });
    }
  };
}
