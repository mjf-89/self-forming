// plugins/core-conversations/web/session-threads.js
// Thread metadata, drafts and attachments (C3b): verbatim move out of session.js. The
// state the engine owns and reassigns (metadata, snapshot, closed, sending, conversation,
// session) is reached through the `shared` accessor object the engine passes in.
import { ROOT_CONVERSATION_ID, defineDoc, defineDocFamily } from "../../../library/pi-durable.js";
import { MAX_ATTACHMENTS, prepareAttachment, attachedUserPresentation } from "../../../attachments.js";
// A stored pi.agent keeps extension/tool NAMES; an AgentChange takes objects with
// a name. Copy a stored agent into a new conversation without losing them.
function agentCopy(agent = {}) {
  const named = (names) => names.map((name) => ({ name }));
  const copy = { ...agent };
  const extensions = agent.extensions;
  if (Array.isArray(extensions)) copy.extensions = named(extensions);
  else if (extensions) copy.extensions = { ...extensions.add ? { add: named(extensions.add) } : {}, ...extensions.remove ? { remove: named(extensions.remove) } : {} };
  if (Array.isArray(agent.tools)) copy.tools = named(agent.tools);
  else if (agent.tools) copy.tools = { remove: named(agent.tools.remove ?? []) };
  return copy;
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
function createThreads({ harness, context, workspace, nativeEnvironment, conversations, ownedMeta, drafts, attachmentRecords, ensureOpen, publish, refreshMetadata, threadSnapshot, shared }) {
  let metadataTail = Promise.resolve();
  async function loadDraftAttachments(id) {
    for (const key of shared.metadata.threads[String(id)]?.attachments ?? []) {
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
    const draftIds = shared.metadata.threads[String(id)]?.attachments ?? [];
    if (!draftIds.length) return;
    const sent = /* @__PURE__ */ new Set();
    for (const entry of view.entries) for (const message of entry.model ?? [])
      for (const attachment of attachedUserPresentation(message)?.attachments ?? []) sent.add(attachment.id);
    if (!draftIds.some((key) => sent.has(key))) return;
    await harness.commit(async (tx) => {
      const state = await tx.doc(ThreadsDoc);
      state.threads[String(id)].attachments = draftIds.filter((key) => !sent.has(key));
    }, context);
    shared.metadata = await harness.snapshot(ThreadsDoc, context);
  }
  const queueMetadata = (work) => {
    const pending = metadataTail.then(work);
    metadataTail = pending.catch(() => {
    });
    return pending;
  };
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
    const saved = shared.metadata.threads[String(id)];
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
  // True when `id` is `ancestor` or one of its descendants (forks below forks, subagents below their owner).
  const isAtOrBelow = (id, ancestor) => {
    const seen = new Set();
    for (let current = id; current !== void 0 && !seen.has(current); current = conversations.get(current)?.parent?.conversationId ?? ownedMeta.get(current)?.parentId) {
      if (current === ancestor) return true;
      seen.add(current);
    }
    return false;
  };
  // Subagents are archived by core-subagents (it publishes archiveSubagent in ARCHIVE_SLOT while its session part exists).
  const ARCHIVE_SLOT = Symbol.for("self-forming.subagents.archive@1");
  async function setSubagentArchived(id, archive) {
    const node = (await shared.session.tree()).find((each) => each.id === id);
    if (node?.kind !== "subagent" || node.parentId === void 0) throw new Error(archive ? "Only conversations and spawned subagents can be archived." : "Only conversations and spawned subagents can be restored.");
    const hook = globalThis[ARCHIVE_SLOT];
    if (typeof hook !== "function") throw new Error("Subagents are not available in this session.");
    await hook({ commit: (work, ctx) => harness.commit(work, ctx), context, ownerId: node.parentId, conversationId: id, archive });
    if (archive && isAtOrBelow(shared.conversation.id, id)) await shared.session.switchConversation(ROOT_CONVERSATION_ID);
  }
  const methods = {
    async setDraft(text) {
      ensureOpen();
      if (typeof text !== "string") throw new TypeError("The draft must be text.");
      const id = shared.conversation.id;
      if (ownedMeta.has(id)) {
        if ((drafts.get(id) ?? "") === text) return;
        drafts.set(id, text);
        if (!shared.closed) {
          shared.snapshot = { ...shared.snapshot, ...threadSnapshot() };
          publish();
        }
        return;
      }
      return queueMetadata(async () => {
        if (shared.metadata.threads[String(id)]?.draft === text) return;
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          state.threads[String(id)].draft = text;
        }, context);
        await refreshMetadata();
      });
    },
    async addAttachments(files, conversationId = shared.conversation.id) {
      ensureOpen();
      if (shared.sending) throw new Error("Wait for the current reply before attaching files.");
      if (!conversations.has(conversationId)) {
        throw new Error(ownedMeta.has(conversationId) ? "Attach files in a top-level conversation." : "This thread is not available.");
      }
      const selected = Array.from(files);
      if (!selected.length) return;
      return queueMetadata(async () => {
        const existing = shared.metadata.threads[String(conversationId)].attachments ?? [];
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
      if (shared.sending) throw new Error("Wait for the current reply before changing attachments.");
      const conversationId = shared.conversation.id;
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
    /**
     * Hides a chat (not the main one) from the list; its history is kept. Threads and forks: the ThreadsDoc flag (a fork's
     * descendants go with it: the drawer hides everything under an archived row, and the open chat moves to Main when it is
     * the row or below it). A spawned subagent: the registry flag of its owner's self-forming.subagents entry, set by
     * core-subagents (same rule as the subagent tool: refused with its message while the subagent is active). One-shot run
     * helpers (task-owned) cannot be archived.
     */
    async archiveConversation(id) {
      ensureOpen();
      if (id === ROOT_CONVERSATION_ID) throw new Error("The main conversation cannot be archived.");
      if (!conversations.has(id)) {
        await setSubagentArchived(id, true);
        return;
      }
      if (isAtOrBelow(shared.conversation.id, id)) await shared.session.switchConversation(ROOT_CONVERSATION_ID);
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
      if (!shared.closed && id === shared.conversation.id) {
        shared.snapshot = { ...shared.snapshot, title: describe(id).title };
        publish();
      }
    },
    async unarchiveConversation(id) {
      ensureOpen();
      if (id === ROOT_CONVERSATION_ID) throw new Error("Only conversations can be restored.");
      if (!conversations.has(id)) {
        await setSubagentArchived(id, false);
        return;
      }
      await queueMetadata(async () => {
        await harness.commit(async (tx) => {
          const state = await tx.doc(ThreadsDoc);
          if (state.threads[String(id)]) delete state.threads[String(id)].archived;
        }, context);
        await refreshMetadata();
      });
    },
  };
  return {
    describe,
    loadDraftAttachments,
    reconcileDraftAttachments,
    queueMetadata,
    get metadataTail() {
      return metadataTail;
    },
    methods
  };
}
export {
  AttachmentDoc,
  ThreadsDoc,
  agentCopy,
  createThreads
};
