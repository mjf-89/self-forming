// apps/common/app-update-handoff.js
function createAppUpdateHandoff(onReady) {
  let pending;
  let closed = false;
  return {
    stage(revision, call) {
      if (closed) return;
      pending = revision && call ? { revision, ...call, notified: false } : void 0;
    },
    committed(publication) {
      const update = pending;
      if (closed || !update || update.notified) return;
      for (const change of publication.changes) {
        const entry = change.value;
        if (change.type !== "entry" || entry?.kind !== "pi.tool-result" || entry.byTaskId !== update.taskId || entry.conversationId !== update.conversationId) continue;
        const result = entry.model?.find((message) => message.role === "toolResult" && message.toolName === "app_update" && message.toolCallId === update.callId);
        if (!result) continue;
        if (result.isError || result.details?.action !== "apply" || result.details?.staged !== true || result.details?.revision !== update.revision) {
          pending = void 0;
          return;
        }
        update.notified = true;
        queueMicrotask(() => {
          if (closed || pending !== update) return;
          pending = void 0;
          onReady(update.revision);
        });
        return;
      }
    },
    clear() {
      pending = void 0;
    },
    close() {
      closed = true;
      pending = void 0;
    }
  };
}
export {
  createAppUpdateHandoff
};
