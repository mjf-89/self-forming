// Browser edition: the editable-app revision state, shared by the fixed host
// (browser-revisions.js) and the fixed recovery page (recovery.html via
// browser-recovery.js). Fixed code: never taken from an app revision.
//
// IndexedDB "self-forming-app" (version 1):
//   revisions/<id> = { id, files, created, version }
//   state/"state"  = { active, previous, pending, attempts, notice?, history, updated? }
// active   revision served by sw.js (null = the deployed "original" app)
// previous the single revision "Previous version" / app.restore("previous") goes back to
// pending  activated but not yet reported ready (retried once, then rolled back)
// history  the last HISTORY_LIMIT activated revisions, newest first:
//          { id, at, created, version, failed? } (selectable on the recovery page)
// updated  { revision, from, at } after app.activate: drives the fixed "App updated" bar
// probation { revision, since, until } after app.activate, until "Keep" or PROBATION_MS: the
//          page heartbeats (browser-probation.js); a stuck run rolls the revision back
// alert    { text, at } after an automatic rollback: shown once by the fixed bar
//
// All writes are read-modify-write in ONE transaction (changeState), so the host and
// the recovery page cannot overwrite each other's change. Nothing here deletes user
// data: only revision snapshots that are no longer referenced are pruned.

export const APP_DB = "self-forming-app";
// Files served from the deployment, never from a revision (keep in step with sw.js).
// Bundled provider callback adapters, execution bootstrap/workers and pinned assets must match
// the deployed host even during safe recovery (never an editable APK payload).
export const FIXED = /^(?:builtin\/core-plugin-management\/web\/browser-plugin-(?:host|store|package|serving)\.js$|assets\/web\/plugins\/|builtin\/core-providers-chatgpt\/web\/browser-oauth\.js$|builtin\/core-providers-claude\/web\/browser-auth\.js$|builtin\/core-execution\/web\/browser\/|builtin\/exec-(?:js|linux)\/web\/browser\/|vendor\/|library\/|cors-rot\/|browser-[^/]*\.js$|sw\.js$|native-host\.js$|app-manifest\.json$|recovery\.html$|fonts\/)/;
export const HISTORY_LIMIT = 10;
export const UPDATE_BAR_MS = 10 * 60 * 1000;
export const PROBATION_MS = 10 * 60 * 1000;
export const ALERT_MS = 10 * 60 * 1000;
// A staged revision that is not (yet) referenced is kept this long, so a stage → activate
// in progress is never pruned.
export const STAGED_GRACE_MS = 60 * 60 * 1000;

const invalid = (message) => Object.assign(new Error(message), { code: "invalid" });

export function openAppDb(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = idb.open(APP_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("revisions");
      request.result.createObjectStore("state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
export const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("Aborted")); });

/** Fills in the fields older records lack (no history before 0.6.5). */
export function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    active: s.active ?? null, previous: s.previous ?? null, pending: s.pending ?? null, attempts: Number(s.attempts) || 0,
    ...(s.notice ? { notice: s.notice } : {}),
    history: Array.isArray(s.history) ? s.history.filter((e) => e && typeof e.id === "string") : [],
    ...(s.updated?.revision ? { updated: s.updated } : {}),
    ...(s.probation?.revision ? { probation: s.probation } : {}),
    ...(s.alert?.text ? { alert: s.alert } : {}),
  };
}

function remember(history, entry) {
  return [entry, ...history.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT);
}
/** Moves an existing history entry to the front (a re-selected revision is the newest one). */
function touch(history, id, now) {
  if (!id) return history;
  const old = history.find((e) => e.id === id);
  const { failed, ...rest } = old ?? { id };
  return remember(history, { ...rest, at: now });
}
const base = (state) => ({ history: state.history });

// Pure state transitions. Each returns the next state (never mutates its input).
export const transitions = {
  activate(state, revision, { created = null, version = null, now = Date.now(), safe = false } = {}) {
    const from = safe ? null : state.active ?? null;
    return { active: revision, previous: from, pending: revision, attempts: 0,
      history: remember(state.history, { id: revision, at: now, created, version }),
      updated: { revision, from, at: now }, probation: { revision, since: now, until: now + PROBATION_MS } };
  },
  ready(state, revision) {
    if (!state.pending || state.pending !== revision) return null;
    const { notice, ...rest } = state;
    return { ...rest, pending: null, attempts: 0 };
  },
  attempt(state) { return { ...state, attempts: state.attempts + 1 }; },
  /**
   * A revision that did not start (pending) or stopped responding (on probation): back to
   * the previous one (single-step, as before), with a notice and a one-time fixed alert.
   */
  rollback(state, notice, { revision = state.pending ?? state.active, now = Date.now() } = {}) {
    return { active: state.previous, previous: null, pending: null, attempts: 0, notice, alert: { text: notice, at: now },
      history: state.history.map((e) => (e.id === revision ? { ...e, failed: true } : e)) };
  },
  /** The user confirmed the new revision: ends probation and the update bar. */
  keep(state) {
    if (!state.updated && !state.probation) return null;
    const { updated, probation, ...rest } = state;
    return rest;
  },
  dismissAlert(state) {
    if (!state.alert) return null;
    const { alert, ...rest } = state;
    return rest;
  },
  restore(state, target, { now = Date.now() } = {}) {
    if (target === "original") return transitions.use(state, null, { now });
    if (target === "previous") {
      if (!state.previous) throw invalid("There is no previous revision");
      return { ...base(state), active: state.previous, previous: null, pending: null, attempts: 0, history: touch(state.history, state.previous, now) };
    }
    throw invalid("Unknown restore target");
  },
  /** Select any kept revision (or null = the original app); the old one becomes `previous`. */
  use(state, revision, { now = Date.now() } = {}) {
    if (revision === (state.active ?? null) && !state.pending) return { ...base(state), active: state.active, previous: state.previous, pending: null, attempts: 0 };
    return { active: revision, previous: state.active ?? null, pending: null, attempts: 0, history: touch(state.history, revision, now) };
  },
  /** Undo of the last update: back to what was active before it. */
  undo(state, { now = Date.now() } = {}) {
    if (!state.updated || state.updated.revision !== state.active) throw invalid("There is no update to undo");
    return transitions.use(state, state.updated.from ?? null, { now });
  },
  dismissUpdate(state) {
    if (!state.updated) return null;
    const { updated, ...rest } = state;
    return rest;
  },
};

/** The "App updated" bar for this page, or null. */
export function updateNotice(state, { now = Date.now(), safe = false } = {}) {
  const u = state?.updated;
  if (safe || !u || u.revision !== state.active) return null;
  const remaining = u.at + UPDATE_BAR_MS - now;
  if (!(remaining > 0)) return null;
  return { revision: u.revision, from: u.from ?? null, remainingMs: Math.min(remaining, UPDATE_BAR_MS) };
}
/** The revision on probation for this page (active, not kept, not expired), or null. */
export function probationOf(state, { now = Date.now(), safe = false } = {}) {
  const p = state?.probation;
  if (safe || !p || p.revision !== state.active || !(p.until > now)) return null;
  return { revision: p.revision, until: p.until };
}
/** The one-time alert after an automatic rollback, or null. */
export function alertNotice(state, { now = Date.now() } = {}) {
  const a = state?.alert;
  return a && now - a.at < ALERT_MS ? { text: a.text, at: a.at } : null;
}

export async function readState(db) {
  return normalizeState(await done(db.transaction("state").objectStore("state").get("state")));
}

/**
 * One readwrite transaction: read the latest state, apply `change` (pure; return null for
 * "no change", or throw), write it. Resolves { state, changed }.
 */
export async function changeState(db, change) {
  const tx = db.transaction("state", "readwrite");
  const settled = finished(tx);
  const store = tx.objectStore("state");
  let result, failure;
  try {
    const current = normalizeState(await done(store.get("state")));
    const next = change(current);
    if (next) store.put(next, "state");
    result = next ? { state: next, changed: true } : { state: current, changed: false };
  } catch (error) {
    failure = error;
    try { tx.abort(); } catch { /* already finished */ }
  }
  await settled.catch((error) => { if (!failure) throw error; });
  if (failure) throw failure;
  return result;
}

export async function revisionExists(db, id) {
  return typeof id === "string" && Boolean(await done(db.transaction("revisions").objectStore("revisions").count(id)));
}
/** { created, version } of a stored revision, or null (reads the record once). */
export async function revisionMeta(db, id) {
  if (typeof id !== "string") return null;
  const record = await done(db.transaction("revisions").objectStore("revisions").get(id));
  return record ? { created: Number(record.created) || null, version: record.version ?? null } : null;
}

/**
 * Migration and pruning in one transaction (state + revisions):
 * - a state without history gets one from the existing revisions (newest first);
 * - revisions referenced by active/previous/pending/history are always kept;
 * - other revisions are deleted once older than STAGED_GRACE_MS (a just-staged one waits).
 * Returns the deleted ids.
 */
export async function pruneRevisions(db, { now = Date.now() } = {}) {
  const tx = db.transaction(["state", "revisions"], "readwrite");
  const settled = finished(tx);
  const states = tx.objectStore("state"), revisions = tx.objectStore("revisions");
  const deleted = [];
  let failure;
  try {
    const raw = await done(states.get("state"));
    const state = normalizeState(raw);
    const keys = await done(revisions.getAllKeys());
    const meta = new Map();
    const load = async (key) => {
      if (!meta.has(key)) { const r = await done(revisions.get(key)); meta.set(key, { created: Number(r?.created) || 0, version: r?.version ?? null }); }
      return meta.get(key);
    };
    if (raw && !Array.isArray(raw.history)) {
      const rows = [];
      for (const key of keys) rows.push({ id: key, ...(await load(key)) });
      const rank = (id) => (id === state.active ? 2 : id === state.previous ? 1 : 0);
      rows.sort((a, b) => rank(b.id) - rank(a.id) || b.created - a.created);
      state.history = rows.slice(0, HISTORY_LIMIT).map((r) => ({ id: r.id, at: r.created, created: r.created, version: r.version }));
      states.put(state, "state");
    }
    const keep = new Set([state.active, state.previous, state.pending, ...state.history.map((e) => e.id)].filter(Boolean));
    for (const key of keys) {
      if (keep.has(key)) continue;
      const { created } = await load(key);
      if (!created || now - created < STAGED_GRACE_MS) continue; // unknown age: keep
      revisions.delete(key);
      deleted.push(key);
    }
  } catch (error) {
    failure = error;
    try { tx.abort(); } catch { /* already finished */ }
  }
  await settled.catch((error) => { if (!failure) throw error; });
  if (failure) throw failure;
  return deleted;
}

/** Tells the service worker(s) to drop their cached revision files. */
export async function notifyServiceWorker(nav = globalThis.navigator) {
  const message = { type: "revision-changed" };
  const sw = nav?.serviceWorker;
  if (!sw) return;
  try { sw.controller?.postMessage(message); } catch { /* no controller */ }
  try {
    const registration = await sw.getRegistration?.();
    for (const worker of [registration?.active, registration?.waiting, registration?.installing]) if (worker && worker !== sw.controller) worker.postMessage(message);
  } catch { /* no registration */ }
}
