// apps/common/app-update-followup.js
// After app_update apply the turn ends and the page reloads at once. This module lets the applying
// conversation continue afterwards: the record survives the reload, the next session posts ONE
// follow-up input to that conversation.
//
// Persisted record (never rename): localStorage key "self-forming.app-update.pending" =
//   JSON { revision, conversationId, taskId, callId, activated? }
// - written when apply stages (core-self-update `staged`), activated=true once app.activate succeeded
//   (app-revisions.js); a record that was never activated (the reload did not happen) is left alone.
// - read after the reload, once the session is open and the active revision (app.info) is known.
// - the input carries requestId "app-update:<revision>" (pi-durable returns the existing submission for a
//   repeated requestId), so a restart between delivery and clearing never sends it twice. Cleared after delivery.
const KEY = "self-forming.app-update.pending";
const defaultStore = () => {
  try { return globalThis.localStorage ?? undefined; } catch { return undefined; }
};
function read(store) {
  try {
    const record = JSON.parse(store?.getItem(KEY) ?? "null");
    return record && typeof record.revision === "string" && record.revision && record.conversationId !== undefined ? record : undefined;
  } catch { return undefined; }
}
function write(store, record) {
  try { if (record) store?.setItem(KEY, JSON.stringify(record)); else store?.removeItem(KEY); } catch {}
}
function recordStaged(revision, call, store = defaultStore()) {
  if (typeof revision !== "string" || !revision || !call) return;
  write(store, { revision, conversationId: call.conversationId, taskId: call.taskId, callId: call.callId });
}
function markActivated(revision, store = defaultStore()) {
  const record = read(store);
  if (record && record.revision === revision) write(store, { ...record, activated: true });
}
const requestIdFor = (revision) => `app-update:${revision}`;
const messageFor = (record, activeRevision) => record.revision === activeRevision
  ? `[app updated to ${record.revision}; startup OK. You can continue working.]`
  : `[app update ${record.revision} failed to start; the previous revision ${activeRevision} was restored.]`;
const delivering = new Set();
/** Posts the follow-up for an activated record (follow-up mode: queued if the conversation is busy). Returns true if delivered. */
async function deliverFollowUp(session, activeRevision, store = defaultStore()) {
  const record = read(store);
  if (!record || !record.activated || typeof activeRevision !== "string" || !activeRevision || delivering.has(record.revision)) return false;
  delivering.add(record.revision);
  try {
    await session.sendTo(record.conversationId, messageFor(record, activeRevision), {}, { whenBusy: "follow-up", requestId: requestIdFor(record.revision) });
    if (read(store)?.revision === record.revision) write(store, undefined);
    return true;
  } finally {
    delivering.delete(record.revision);
  }
}
export { KEY, deliverFollowUp, markActivated, messageFor, recordStaged, requestIdFor };
