// plugins/core-conversations/web/session-tail.js
// Chat rendering and the conversation tail (C3a): verbatim move out of session.js.
import { AgentDoc, LiveDoc } from "../../../library/pi-durable.js";
import { createReportAttribution } from "./report-attribution.js";
import { attachedUserPresentation } from "../../../attachments.js";
var TAIL_ENTRIES = 100;
var TAIL_DEBOUNCE_MS = 120;
var HISTORY_YIELD_MS = 150;
var REFRESH_ENTRIES = 16;
var HISTORY_RERENDER_ENTRIES = 8;
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
  const value = name === "bash" || name === "javascript" ? args?.command : ["read", "write", "edit", "workspace_read", "workspace_write", "workspace_list"].includes(name) ? args?.path : void 0;
  if (typeof value !== "string") return {};
  const preview = Array.from(value.replace(/\s+/g, " ").trim());
  return preview.length ? { toolPreview: preview.length > 300 ? `${preview.slice(0, 299).join("")}\u2026` : preview.join("") } : {};
}
// A model error answered through model-error.js reaches the transcript wrapped by the
// API client ("OpenAI API error (401): {json}", "401 {json}"). Show its one message
// (already bounded and redacted there); anything else is shown as is.
function modelErrorText(text) {
  const wrapped = /^(?:[^{\n]{0,60}\(\d{3}\): |\d{3} )(\{[\s\S]*\})$/.exec(String(text));
  if (!wrapped) return text;
  try {
    const body = JSON.parse(wrapped[1]);
    const inner = typeof body?.message === "string" ? body.message : body?.error?.message;
    return typeof inner === "string" && /^[^\n]{1,40} request failed \(\d{3}\)\./.test(inner) ? inner : text;
  } catch {
    return text;
  }
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
    text: message.role === "assistant" && message.errorMessage ? `${text}${text ? "\n" : ""}${modelErrorText(message.errorMessage)}` : text,
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
  if (live.run !== void 0 && !visible && !running)
    messages.push({ id: "partial", role: "assistant", text: "Thinking\u2026", pending: true });
  const modelLabel = agent?.model?.provider && agent?.model?.modelId ? `${agent.model.provider}/${agent.model.modelId}` : "";
  return { messages, busy: live.run !== void 0, modelLabel };
}
// createTail({harness, storage, context, conversations}): the tail readers of one open session.
function createTail({ harness, storage, context, conversations }) {
  const readNewest = async (target, stopAtId) => {
    const picked = [];
    let marker;
    let cursor;
    let done = false;
    let newestRow;
    for (; ; ) {
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
  const readSince = async (target, newestId) => {
    const fresh = [];
    let cursor;
    let newestRow;
    for (; ; ) {
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
    let schedule = () => {
    };
    const attribution = createReportAttribution(storage, context);
    let senderVersion = 0;
    let docsNow = {};
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
    const applyWindow = (result) => {
      if (result.fresh) {
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
      if (oldest !== void 0) {
        for (const entry of windowEntries)
          if (!nextIds.has(entry.id) && entry.id < oldest && !olderIds.has(entry.id)) fresh.set(entry.id, entry);
      }
      addOlder([...fresh.values()].sort(byId));
      windowEntries = next;
      windowIds = nextIds;
    };
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
      for (const [entryId, messages] of renderEntries(previousOldest, calls, attribution.senders)) rendered.set(entryId, messages);
    };
    const loadSenders = async (entries) => {
      await attribution.load(entries, id);
      if (senderVersion !== attribution.version) {
        senderVersion = attribution.version;
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
            try {
              await listener?.(value);
            } catch {
            }
          }
        } catch (error) {
          loaderFailed = true;
          if (!stopped) onError?.(error);
        } finally {
          loaderRunning = false;
          if (!stopped) {
            if (mine !== epoch && !loaderFailed) startHistory();
            else if (mine === epoch) {
              value = buildValue();
              if (loaderFailed) try {
                await listener?.(value);
              } catch {
              }
            }
          }
        }
      })();
    };
    try {
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
          try {
            unsubscribe?.();
          } catch {
          }
          await Promise.allSettled(watchers.map(([, docWatch]) => docWatch.stop()));
        }
      };
    } catch (error) {
      stopped = true;
      try {
        unsubscribe?.();
      } catch {
      }
      await Promise.allSettled(watchers.map(([, docWatch]) => docWatch.stop()));
      throw error;
    }
  };
  return { readNewest, readSince, openTail };
}
export {
  createTail,
  displayMessage,
  renderEntries,
  renderMessages,
  textOf
};
