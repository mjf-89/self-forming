// Display identity is separate from the model's user role. Only durable reporter provenance
// identifies a subagent; a human typing the same report prefix remains the human sender.
export function createReportAttribution(storage, context) {
  const loaded = new Map();
  const pending = new Map();
  const tasks = new Map();
  const senders = new Map();
  let version = 0;
  const identity = (record) => {
    if (record.type !== "input" || !Number.isSafeInteger(record.entry)) return;
    const match = /^subagent-report:(\d+)$/.exec(record.requestId ?? "");
    if (!match || !Number.isSafeInteger(Number(match[1]))) return;
    return Number(match[1]);
  };
  const remember = (record) => {
    const taskId = identity(record);
    if (taskId === void 0 || senders.has(record.entry)) return false;
    const current = pending.get(record.entry);
    if (current?.record.id === record.id) return false;
    pending.set(record.entry, { record, taskId });
    return true;
  };
  const loadConversation = (conversationId) => {
    if (!loaded.has(conversationId)) {
      const promise = (async () => {
        let cursor;
        do {
          const page = await storage.scanSubmissions({ conversationId }, 250, cursor, context);
          for (const record of page.items) remember(record);
          cursor = page.next;
        } while (cursor !== void 0);
      })();
      loaded.set(conversationId, promise);
      promise.catch(() => loaded.delete(conversationId));
    }
    return loaded.get(conversationId);
  };
  return {
    senders,
    get version() { return version; },
    // Observe from before the first read, so a queued report placed during the initial scan is not lost.
    observe(publication) {
      let changed = false;
      for (const change of publication.changes) {
        if (change.type === "submission" && loaded.has(change.value.conversationId))
          changed = remember(change.value) || changed;
      }
      return changed;
    },
    async load(entries, conversationId) {
      // Fork views contain entries belonging to their ancestors. Resolve each source just once.
      const ids = new Set([conversationId, ...entries.map((entry) => entry.conversationId)]);
      await Promise.all([...ids].filter(Number.isSafeInteger).map(loadConversation));
      for (const [entryId, item] of pending) {
        if (!tasks.has(item.taskId)) {
          const promise = storage.task(item.taskId, context);
          tasks.set(item.taskId, promise);
          promise.catch(() => tasks.delete(item.taskId));
        }
        const reporter = await tasks.get(item.taskId);
        if (reporter?.kind === "self-forming.subagent-reporter" &&
            reporter.conversationId === item.record.conversationId &&
            typeof reporter.input?.name === "string" && reporter.input.name.trim() &&
            Number.isSafeInteger(reporter.input.conversationId)) {
          if (!senders.has(entryId)) {
            senders.set(entryId, { kind: "subagent", name: reporter.input.name, conversationId: reporter.input.conversationId });
            version++;
          }
        }
        if (pending.get(entryId) === item) pending.delete(entryId);
      }
    }
  };
}
