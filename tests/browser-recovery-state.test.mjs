// Browser edition recovery (fixed host code): revision state transitions, the last-10
// history, pruning, restore to an older revision through the recovery page logic, plugin
// enable/disable, probation heartbeats and startup rollback of a frozen revision.
// Runs from the repository sources (no build needed). Run in its own node process.
import test from "node:test";
import assert from "node:assert/strict";
import { fakeIndexedDb } from "./fake-indexeddb.mjs";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto; // Node 18
const state = await import("../apps/browser/browser-app-state.js");
const probation = await import("../apps/browser/browser-probation.js");
const recovery = await import("../apps/browser/browser-recovery.js");
const { openPluginStore } = await import("../plugins/core-plugin-management/web/browser-plugin-store.js");
const { packageHash } = await import("../plugins/core-plugin-management/web/browser-plugin-package.js");
const { openAppDb, readState, changeState, transitions, pruneRevisions, HISTORY_LIMIT, STAGED_GRACE_MS, PROBATION_MS } = state;

const VERSION = "1.0-browser-abc";
async function putRevision(db, id, { created = Date.now(), version = VERSION } = {}) {
  const tx = db.transaction("revisions", "readwrite");
  tx.objectStore("revisions").put({ id, files: { "index.html": new Uint8Array([1]), "app.js": new Uint8Array([2]) }, created, version }, id);
  await state.finished(tx);
}
const keys = async (db) => state.done(db.transaction("revisions").objectStore("revisions").getAllKeys());
const swMessages = () => { const messages = []; return { messages, nav: { serviceWorker: { controller: { postMessage: (m) => messages.push(m) }, getRegistration: async () => undefined } } }; };

test("transitions keep the single `previous` semantics and the history", () => {
  let s = state.normalizeState(undefined);
  s = transitions.activate(s, "r-1", { created: 1, version: VERSION, now: 10 });
  assert.deepEqual([s.active, s.previous, s.pending], ["r-1", null, "r-1"]);
  assert.deepEqual(s.updated, { revision: "r-1", from: null, at: 10 });
  assert.equal(s.probation.until, 10 + PROBATION_MS);
  s = transitions.ready(s, "r-1");
  assert.equal(s.pending, null);
  assert.equal(transitions.ready(s, "r-1"), null);
  s = transitions.activate(s, "r-2", { now: 20 });
  assert.deepEqual([s.active, s.previous], ["r-2", "r-1"]);
  assert.deepEqual(s.history.map((e) => e.id), ["r-2", "r-1"]);
  // app.restore("previous"): previous becomes active, previous cleared (as before).
  const back = transitions.restore(s, "previous", { now: 30 });
  assert.deepEqual([back.active, back.previous, back.pending, back.updated, back.probation], ["r-1", null, null, undefined, undefined]);
  assert.throws(() => transitions.restore(back, "previous"), /no previous/);
  const original = transitions.restore(s, "original");
  assert.deepEqual([original.active, original.previous], [null, "r-2"]);
  assert.throws(() => transitions.restore(s, "nope"), /Unknown restore target/);
  // Undo of an update returns to what was active before it.
  const undone = transitions.undo(s);
  assert.deepEqual([undone.active, undone.previous], ["r-1", "r-2"]);
  assert.throws(() => transitions.undo(undone), /no update/);
  const kept = transitions.keep(s);
  assert.equal(kept.updated, undefined);
  assert.equal(kept.probation, undefined);
  assert.equal(kept.active, "r-2");
  // Rollback marks the revision that failed and leaves a one-time alert.
  const rolled = transitions.rollback(s, "Revision r-2 stopped responding; restored the previous version.", { revision: "r-2", now: 40 });
  assert.deepEqual([rolled.active, rolled.previous, rolled.pending], ["r-1", null, null]);
  assert.equal(rolled.history.find((e) => e.id === "r-2").failed, true);
  assert.equal(state.alertNotice(rolled, { now: 50 }).text, rolled.notice);
  assert.equal(state.alertNotice(rolled, { now: 40 + state.ALERT_MS }), null);
  // The update bar is shown for a limited time, never in safe mode.
  assert.equal(state.updateNotice(s, { now: 21 }).revision, "r-2");
  assert.equal(state.updateNotice(s, { now: 21, safe: true }), null);
  assert.equal(state.updateNotice(s, { now: 20 + state.UPDATE_BAR_MS }), null);
  assert.equal(state.probationOf(s, { now: 21 }).revision, "r-2");
  assert.equal(state.probationOf(s, { now: 20 + PROBATION_MS }), null);
  // History: newest first, deduplicated, at most HISTORY_LIMIT.
  let h = state.normalizeState({});
  for (let i = 0; i < 15; i++) h = transitions.activate(h, `r-${i % 12}`, { now: i });
  assert.equal(h.history.length, HISTORY_LIMIT);
  assert.equal(new Set(h.history.map((e) => e.id)).size, HISTORY_LIMIT);
  assert.equal(h.history[0].id, "r-2");
});

test("changeState is one read-modify-write; a throwing change writes nothing", async () => {
  const db = await openAppDb(fakeIndexedDb());
  await changeState(db, (s) => transitions.activate(s, "r-a", { now: 1 }));
  await assert.rejects(changeState(db, (s) => transitions.restore(s, "previous")), /no previous/);
  assert.equal((await readState(db)).active, "r-a");
  const unchanged = await changeState(db, () => null);
  assert.equal(unchanged.changed, false);
});

test("history pruning keeps the last 10 activated, active/previous/pending and fresh staged revisions", async () => {
  const db = await openAppDb(fakeIndexedDb());
  const t0 = 1_000_000;
  for (let i = 0; i < 13; i++) {
    await putRevision(db, `r-${String(i).padStart(2, "0")}`, { created: t0 + i });
    await changeState(db, (s) => transitions.ready(transitions.activate(s, `r-${String(i).padStart(2, "0")}`, { now: t0 + i }), `r-${String(i).padStart(2, "0")}`));
  }
  await putRevision(db, "r-staged-old", { created: t0 });
  const later = t0 + 2 * STAGED_GRACE_MS;
  await putRevision(db, "r-staged-new", { created: later - 1000 });
  const deleted = await pruneRevisions(db, { now: later });
  assert.deepEqual(deleted.sort(), ["r-00", "r-01", "r-02", "r-staged-old"]);
  const left = await keys(db);
  assert.equal(left.length, 11);
  assert.ok(left.includes("r-staged-new"));
  // Active, previous and pending are never pruned, even outside the history.
  await changeState(db, (s) => ({ ...s, active: "r-03", previous: "r-04", pending: "r-03", history: [] }));
  assert.deepEqual(await pruneRevisions(db, { now: later + 10 * STAGED_GRACE_MS }), ["r-05", "r-06", "r-07", "r-08", "r-09", "r-10", "r-11", "r-12", "r-staged-new"]);
  assert.deepEqual(await keys(db), ["r-03", "r-04"]);
});

test("records from before the history are migrated (newest 10, active first), then pruned", async () => {
  const db = await openAppDb(fakeIndexedDb());
  for (let i = 0; i < 12; i++) await putRevision(db, `r-${String(i).padStart(2, "0")}`, { created: 100 + i });
  const tx = db.transaction("state", "readwrite");
  tx.objectStore("state").put({ active: "r-00", previous: "r-05", pending: null, attempts: 0 }, "state");
  await state.finished(tx);
  const deleted = await pruneRevisions(db, { now: 100 + 2 * STAGED_GRACE_MS });
  const s = await readState(db);
  assert.deepEqual(s.history.slice(0, 3).map((e) => e.id), ["r-00", "r-05", "r-11"]);
  assert.equal(s.history.length, HISTORY_LIMIT);
  assert.deepEqual(deleted.sort(), ["r-01", "r-02"]);
});

test("recovery page logic: list kept versions, use an older one, use the original (same transitions, SW told)", async () => {
  const db = await openAppDb(fakeIndexedDb());
  for (const [i, id] of ["r-old", "r-mid", "r-new"].entries()) {
    await putRevision(db, id, { created: 100 + i });
    await changeState(db, (s) => transitions.activate(s, id, { created: 100 + i, version: VERSION, now: 100 + i }));
  }
  await putRevision(db, "r-stale", { version: "0.9-browser" });
  await changeState(db, (s) => ({ ...s, history: [...s.history, { id: "r-stale", at: 1, version: "0.9-browser" }, { id: "r-gone", at: 0, version: VERSION }] }));
  let list = await recovery.listVersions(db, { deployedVersion: VERSION });
  assert.deepEqual(list.revisions.map((r) => r.id), ["r-new", "r-mid", "r-old", "r-stale", "r-gone"]);
  assert.equal(list.revisions[0].active, true);
  assert.equal(list.revisions[1].previous, true);
  assert.equal(list.revisions[3].servable, false);
  assert.match(list.revisions[3].why, /older deployment/);
  assert.equal(list.revisions[4].exists, false);
  assert.equal(list.original.active, false);

  const { messages, nav } = swMessages();
  let s = await recovery.useVersion(db, "r-old", { deployedVersion: VERSION, nav });
  assert.deepEqual([s.active, s.previous, s.pending], ["r-old", "r-new", null]);
  assert.deepEqual(messages, [{ type: "revision-changed" }]);
  assert.equal(s.history[0].id, "r-old"); // re-selected: newest again, never pruned first
  // The host's app.restore("previous") still works after a recovery-page choice.
  s = (await changeState(db, (x) => transitions.restore(x, "previous"))).state;
  assert.equal(s.active, "r-new");
  await assert.rejects(recovery.useVersion(db, "r-stale", { deployedVersion: VERSION, nav }), /older deployment/);
  await assert.rejects(recovery.useVersion(db, "r-gone", { deployedVersion: VERSION, nav }), /no longer stored/);
  s = await recovery.useVersion(db, null, { nav });
  assert.deepEqual([s.active, s.previous], [null, "r-new"]);
  list = await recovery.listVersions(db, { deployedVersion: VERSION });
  assert.equal(list.original.active, true);
  // Nothing was deleted.
  assert.deepEqual((await keys(db)).sort(), ["r-mid", "r-new", "r-old", "r-stale"]);
});

test("recovery page logic: plugins can be disabled, re-enabled (verified) and all disabled; nothing is deleted", async () => {
  const idb = fakeIndexedDb();
  const store = await openPluginStore(idb, { probe: false });
  const enc = (t) => new TextEncoder().encode(t);
  const files = { "plugin.json": enc(JSON.stringify({ id: "hello-world", api: 1, reload: "page", name: "Hello", version: "1.0.0", web: { entry: "web/index.js" } })), "web/index.js": enc("export function setup() {}") };
  const hash = await packageHash(files);
  await store.publish({ manifest: { id: "hello-world", name: "Hello" }, hash, files }, { id: "hello-world", hash, previous: null, enabled: true });
  await store.publish(null, { id: "broken-one", hash: "0".repeat(64), previous: null, enabled: true });
  let rows = await recovery.listPlugins(store, { builtinIds: ["core-chat"] });
  assert.deepEqual(rows.map((p) => [p.id, p.name, p.enabled, p.ok]), [["broken-one", "broken-one", true, false], ["hello-world", "Hello", true, true]]);
  await recovery.setPluginEnabled(store, "hello-world", false);
  assert.equal((await store.selection("hello-world")).enabled, false);
  assert.equal((await store.selection("hello-world")).hash, hash);
  await recovery.setPluginEnabled(store, "hello-world", true, { builtinIds: ["core-chat"] });
  assert.equal((await store.selection("hello-world")).enabled, true);
  await assert.rejects(recovery.setPluginEnabled(store, "nobody-here", false), /not installed/);
  assert.deepEqual((await recovery.disableAllPlugins(store)).sort(), ["broken-one", "hello-world"]);
  await assert.rejects(recovery.setPluginEnabled(store, "broken-one", true), /missing/);
  rows = await recovery.listPlugins(store);
  assert.ok(rows.every((p) => !p.enabled));
  assert.ok(await store.snapshot("hello-world", hash), "snapshot kept");
  assert.equal((await store.selections()).length, 2, "selections kept");
});

test("probation heartbeats: clean unload, visible freeze, hidden tab, expiry", () => {
  const storage = new Map();
  const ls = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  const doc = { visibilityState: "visible", listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {} };
  const win = { listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {} };
  const posted = [];
  let now = 1000, ticks;
  const s = { active: "r-x", probation: { revision: "r-x", until: 1000 + PROBATION_MS } };
  const hb = probation.startHeartbeat({ storage: ls, revision: "r-x", until: s.probation.until, loadId: "l-1", document: doc, target: win,
    worker: () => ({ postMessage: (m) => posted.push(m) }), now: () => now, setTimer: (f) => { ticks = f; return 1; }, clearTimer: () => {} });
  let record = probation.readHeartbeat(ls);
  assert.deepEqual([record.revision, record.visible, record.clean], ["r-x", true, false]);
  assert.equal(posted[0].type, "probation-heartbeat");
  // Stuck while visible (no clean unload): the next load counts a failed run.
  assert.equal(probation.lastRunFailed(record, s, { loadId: "l-2" }), true);
  assert.equal(probation.lastRunFailed(record, s, { loadId: "l-1" }), false, "not this load");
  assert.equal(probation.lastRunFailed(record, { ...s, probation: undefined }), false, "kept: no probation");
  assert.equal(probation.lastRunFailed(record, { ...s, active: "r-y" }), false, "already rolled back");
  // Hidden tab: not counted.
  doc.visibilityState = "hidden"; doc.listeners.visibilitychange();
  assert.equal(probation.lastRunFailed(probation.readHeartbeat(ls), s, { loadId: "l-2" }), false);
  doc.visibilityState = "visible"; now += 3000; ticks();
  // Clean unload: not counted.
  win.listeners.pagehide();
  record = probation.readHeartbeat(ls);
  assert.equal(record.clean, true);
  assert.equal(probation.lastRunFailed(record, s, { loadId: "l-2" }), false);
  assert.equal(posted.at(-1).type, "probation-end");
  // Probation ends by itself.
  now = s.probation.until + 1; ticks();
  assert.equal(hb.stopped(), true);
});

test("createRevisions: a frozen probation run is rolled back on the next load; ready waits for responsiveness", async () => {
  globalThis.indexedDB = fakeIndexedDb();
  const storage = new Map();
  const ls = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  let reloads = 0;
  globalThis.location = { href: "http://127.0.0.1:8770/", reload: () => { reloads++; } };
  const { messages, nav } = swMessages();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...nav, serviceWorker: { ...nav.serviceWorker, register: async () => {}, ready: Promise.resolve() } } });
  const files = { "index.html": '<script type="module" src="./browser-main.js"></script>', "app.js": "export {}" };
  globalThis.fetch = async (url) => { const name = new URL(url).pathname.slice(1); return { ok: name in files, status: 404, arrayBuffer: async () => new TextEncoder().encode(files[name]).buffer }; };
  const { Vfs, MemoryBackend } = await import("../plugins/core-execution/web/browser/browser-vfs.js");
  const { createRevisions } = await import("../apps/browser/browser-revisions.js");
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  let responsive = 0, readyCalls = 0;
  const options = { vfs, version: VERSION, manifest: { editableFiles: Object.keys(files) }, storage: ls, document: doc,
    responsive: async () => { responsive++; }, onReady: () => readyCalls++ };
  let revisions = await createRevisions(options);
  const { revision } = await revisions.methods["app.stage"]();
  await revisions.methods["app.activate"]({ revision });
  // Load 1: on probation, heartbeats; ready only after the responsiveness check ran.
  revisions = await createRevisions(options);
  assert.equal(probation.readHeartbeat(ls).revision, revision);
  assert.equal(revisions.recovery.updateNotice().revision, revision);
  await revisions.methods["app.ready"]({ revision });
  assert.equal(responsive, 1);
  assert.equal(readyCalls, 1);
  assert.equal((await revisions.methods["app.info"]()).revision, revision);
  // The page froze while visible (no pagehide). Load 2 rolls back to the original app.
  void createRevisions(options);
  for (let i = 0; i < 100 && !reloads; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reloads, 1);
  revisions = await createRevisions(options);
  const info = await revisions.methods["app.info"]();
  assert.equal(info.revision, "bundled");
  assert.match(info.notice, /stopped responding; restored the previous version/);
  assert.match(revisions.recovery.alert().text, /stopped responding/);
  assert.match(info.recoveryUrl, /recovery\.html$/);
  assert.ok(messages.some((m) => m.type === "revision-changed"));
  await revisions.recovery.dismissAlert();
  assert.equal(revisions.recovery.alert(), null);

  // A kept revision is not on probation any more: a later freeze is not rolled back.
  await revisions.methods["app.activate"]({ revision });
  revisions = await createRevisions(options);
  await revisions.methods["app.ready"]({ revision });
  await revisions.recovery.keep();
  assert.equal(revisions.recovery.probation(), null);
  ls.setItem(probation.HEARTBEAT_KEY, JSON.stringify({ loadId: "x", revision, at: Date.now(), visible: true, clean: false }));
  revisions = await createRevisions(options);
  assert.equal((await revisions.methods["app.info"]()).revision, revision);
  // Undo from the fixed bar: back to the original app.
  await revisions.methods["app.restore"]({ target: "original" });
  await revisions.methods["app.activate"]({ revision });
  revisions = await createRevisions(options);
  await revisions.recovery.undo();
  assert.equal((await revisions.methods["app.info"]()).revision, "bundled");
});
