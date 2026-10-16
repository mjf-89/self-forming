// Browser edition: editable app revisions.
// The agent edits the app's own files in the browser file system (sourcePath).
// app.stage snapshots them into IndexedDB; app.activate selects a revision and
// the service worker (sw.js) serves its files instead of the deployed ones.
// Fixed files (this host, the Pi library) are never taken from a revision.
// Recovery: a revision that does not report ready is rolled back on the next
// start or after a watchdog timeout; ?safe always loads the deployed app; the fixed
// recovery page (recovery.html, ?recovery) selects any kept revision or disables plugins.

import { APP_DB, FIXED, openAppDb, finished, readState, changeState, transitions, updateNotice, probationOf, alertNotice, revisionMeta, pruneRevisions, notifyServiceWorker } from "./browser-app-state.js";
import { readHeartbeat, lastRunFailed, startHeartbeat, whenResponsive } from "./browser-probation.js";
// State transitions, history (last 10 activated revisions) and pruning live in the fixed
// browser-app-state.js, shared with the recovery page (recovery.html).
export { APP_DB, FIXED, openAppDb, readState };
const MAX_FILES = 400;
const MAX_BYTES = 32 * 1024 * 1024;

// onReady(revision): called once the app reported ready AND the page proved responsive.
// storage/responsive/document are injectable for tests (localStorage, whenResponsive, document).
export async function createRevisions({ vfs, version, manifest, safe = false, onReady, storage = globalThis.localStorage,
  responsive = whenResponsive, document = globalThis.document }) {
  if (!("serviceWorker" in navigator)) return undefined;
  const scope = new URL("./", location.href);
  try {
    await navigator.serviceWorker.register(new URL("./sw.js", scope), { type: "module", scope: scope.pathname });
    await navigator.serviceWorker.ready;
  } catch (cause) {
    console.warn("Self Forming: app editing is unavailable without a service worker", cause);
    return undefined;
  }
  const db = await openAppDb();
  const sourcePath = `/workspace/.self-forming/app/${version}`;
  const notifyWorker = () => notifyServiceWorker(navigator);
  const recoveryUrl = new URL("./recovery.html", scope).href;
  const editable = (manifest?.editableFiles ?? []).filter((name) => !FIXED.test(name));

  // Seed the editable source folder with the deployed files once per version.
  if (!vfs.exists(sourcePath)) {
    const files = await Promise.all(editable.map(async (name) => {
      const response = await fetch(new URL(`${name}?sf-original=1`, scope), { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not copy ${name} into the editable source (${response.status})`);
      return [name, new Uint8Array(await response.arrayBuffer())];
    }));
    for (const [name, bytes] of files) vfs.write(`${sourcePath}/${name}`, bytes);
    vfs.write(`${sourcePath}/README.md`, new TextEncoder().encode(
      "# Editable app source (browser edition)\n\nThese are this app's own files. Edit them, then use app_update apply (or Settings → Edit this app → Apply edits).\nThe Pi library, native-host.js and the browser host (browser-*.js, sw.js) are fixed and are served from the deployment.\nOpen the page with ?safe to load the deployed app if a revision misbehaves, or ?recovery (recovery.html) to pick an earlier version or turn off plugins.\n"));
    await vfs.flush();
  }

  let state = await readState(db);
  // A revision that was activated but never reported ready gets one more try, then it is rolled back.
  if (!safe && state.pending) {
    if (state.attempts >= 1) {
      const result = await changeState(db, (s) => (s.pending ? transitions.rollback(s, `Revision ${s.pending} did not start; restored the previous app.`) : null));
      state = result.state;
      if (result.changed) {
        notifyWorker();
        location.reload();
        await new Promise(() => {});
      }
    } else ({ state } = await changeState(db, (s) => transitions.attempt(s)));
    const starting = state.pending;
    const watchdog = starting && setTimeout(async () => {
      const result = await changeState(db, (s) => (s.pending && s.pending === starting ? transitions.rollback(s, `Revision ${s.pending} did not finish starting; restored the previous app.`) : null));
      if (result.changed) {
        state = result.state;
        notifyWorker();
        location.reload();
      }
    }, 45_000);
    watchdog?.unref?.(); // Node (tests) only
  }
  // Probation (browser-probation.js): the previous load of the revision on probation froze
  // (stopped heartbeating while visible, no clean unload): roll it back now.
  const loadId = `l-${crypto.randomUUID()}`;
  if (!safe && lastRunFailed(readHeartbeat(storage), state, { loadId })) {
    const stuck = state.probation.revision;
    const result = await changeState(db, (s) => (lastRunFailed(readHeartbeat(storage), s, { loadId })
      ? transitions.rollback(s, `Revision ${stuck} stopped responding; restored the previous version.`, { revision: stuck }) : null));
    state = result.state;
    if (result.changed) {
      notifyWorker();
      location.reload();
      await new Promise(() => {});
    }
  }
  let heartbeat;
  const probation = probationOf(state, { safe });
  if (probation) heartbeat = startHeartbeat({ storage, revision: probation.revision, until: probation.until, loadId, document,
    worker: () => navigator.serviceWorker?.controller ?? null });
  // Keep the last activated revisions, drop older snapshots (never active/previous/pending).
  void pruneRevisions(db).catch((cause) => console.warn("Self Forming: could not prune old app revisions", cause));

  const info = () => ({
    supported: true, sourcePath, hostVersion: version,
    revision: safe ? "bundled" : state.active ?? "bundled",
    ...(state.previous ? { previousRevision: state.previous } : {}),
    recoveryUrl,
    ...(safe ? { notice: "Safe mode: the deployed app is loaded (?safe)." } : state.notice ? { notice: state.notice } : {}),
  });

  async function stage() {
    if (!vfs.exists(sourcePath)) throw Object.assign(new Error(`The editable source folder ${sourcePath} is missing`), { code: "not_found" });
    const files = {};
    let count = 0, bytes = 0;
    for (const path of vfs.walk(sourcePath)) {
      const node = vfs.get(path);
      if (node?.kind !== "file") continue;
      const name = path.slice(sourcePath.length + 1);
      if (FIXED.test(name) || name === "README.md" || name.split("/").some((part) => part.startsWith("."))) continue;
      if (++count > MAX_FILES) throw Object.assign(new Error("Too many files in the editable source"), { code: "TOO_LARGE" });
      bytes += node.size;
      if (bytes > MAX_BYTES) throw Object.assign(new Error("The editable source is larger than 32 MiB"), { code: "TOO_LARGE" });
      files[name] = (await vfs.read(path)).slice();
    }
    if (!files["index.html"] || !files["app.js"]) throw Object.assign(new Error("index.html and app.js are required"), { code: "invalid" });
    const revision = `r-${crypto.randomUUID()}`;
    const tx = db.transaction("revisions", "readwrite");
    tx.objectStore("revisions").put({ id: revision, files, created: Date.now(), version }, revision);
    await finished(tx);
    return { revision };
  }

  let readyCheck;
  async function select(change) {
    ({ state } = await changeState(db, change));
    notifyWorker();
    return info();
  }

  return {
    sourcePath,
    recoveryUrl,
    /** Fixed recovery hooks for browser-main.js (not bridge methods; work even when the app UI is broken). */
    recovery: {
      updateNotice: () => updateNotice(state, { safe }),
      alert: () => (safe ? null : alertNotice(state)),
      probation: () => probationOf(state, { safe }),
      async undo() { heartbeat?.stop(); await select((s) => transitions.undo(s)); },
      async keep() { heartbeat?.stop(); ({ state } = await changeState(db, (s) => transitions.keep(s))); },
      async dismissUpdate() { ({ state } = await changeState(db, (s) => transitions.dismissUpdate(s))); },
      async dismissAlert() { ({ state } = await changeState(db, (s) => transitions.dismissAlert(s))); },
    },
    methods: {
      "app.info": () => info(),
      "app.stage": () => stage(),
      async "app.activate"({ revision }) {
        const meta = await revisionMeta(db, revision);
        if (!meta) throw Object.assign(new Error("Unknown revision"), { code: "invalid" });
        const result = await select((s) => transitions.activate(s, revision, { ...meta, safe }));
        void pruneRevisions(db).catch(() => {});
        return result;
      },
      async "app.ready"({ revision }) {
        // Readiness means a responsive page, not merely a session that opened (fixed check).
        readyCheck ??= Promise.resolve().then(() => responsive({ document })).catch(() => {});
        await readyCheck;
        try { onReady?.(revision); } catch { /* notice only */ }
        if (!safe && state.pending && state.pending === revision) return select((s) => transitions.ready(s, revision));
        return info();
      },
      async "app.restore"({ target }) {
        return select((s) => transitions.restore(s, target));
      },
    },
  };
}
