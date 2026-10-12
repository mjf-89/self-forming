// Activate only after the exact updating tool has committed its successful result.
// Other conversations can stay busy: harness.close preserves their unfinished work.
export function createAppUpdateHandoff(onReady) {
  let pending;
  let closed = false;
  return {
    stage(revision, call) {
      if (closed) return;
      pending = revision && call ? { revision, ...call, notified: false } : undefined;
    },
    committed(publication) {
      const update = pending;
      if (closed || !update || update.notified) return;
      for (const change of publication.changes) {
        const entry = change.value;
        if (change.type !== "entry" || entry?.kind !== "pi.tool-result" ||
            entry.byTaskId !== update.taskId || entry.conversationId !== update.conversationId) continue;
        const result = entry.model?.find(message => message.role === "toolResult" &&
          message.toolName === "app_update" && message.toolCallId === update.callId);
        if (!result) continue;
        if (result.isError || result.details?.action !== "apply" || result.details?.staged !== true ||
            result.details?.revision !== update.revision) {
          pending = undefined;
          return;
        }
        update.notified = true;
        // Commit observers must not call Session APIs. Leave the observer before the UI closes the harness.
        queueMicrotask(() => {
          if (closed || pending !== update) return;
          pending = undefined;
          onReady(update.revision);
        });
        return;
      }
    },
    clear() { pending = undefined; },
    close() { closed = true; pending = undefined; }
  };
}
