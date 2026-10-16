// Browser edition: logic and rendering of the fixed recovery page (recovery.html).
// Fixed code: deployed with the host, never taken from an app revision or a plugin, and
// it imports no app module. It reads the IndexedDB stores directly and writes only
// through the same state transitions the host uses (browser-app-state.js) and the same
// plugin selection records the plugin host uses (browser-plugin-store.js). It never
// deletes conversations, files, sign-ins, revisions or plugin snapshots.
import { openAppDb, readState, changeState, transitions, revisionExists, notifyServiceWorker } from "./browser-app-state.js";
import { readHeartbeat } from "./browser-probation.js";
import { createTabLock, HOST_LOCK as TAB_LOCK } from "./browser-tab-lock.js";
import { openPluginStore } from "../../plugins/core-plugin-management/web/browser-plugin-store.js";
import { ID, packageHash, validatePackage } from "../../plugins/core-plugin-management/web/browser-plugin-package.js";

export const HOST_LOCK = TAB_LOCK;
export const REASONS = {
  unresponsive: "The app stopped responding. If it was a new version, the previous version was restored.",
  startup: "The app didn't start properly.",
};

/** The deployed manifest (never a revision's): { version, builtinIds }. */
export async function deployedInfo(fetchImpl = globalThis.fetch, base = globalThis.location?.href) {
  try {
    const response = await fetchImpl(new URL("./app-manifest.json?sf-original=1", base).href, { cache: "no-store" });
    if (!response.ok) return { version: null, builtinIds: [] };
    const manifest = await response.json();
    return { version: manifest?.hostVersion ?? null, builtinIds: Array.isArray(manifest?.builtinIds) ? manifest.builtinIds : [] };
  } catch { return { version: null, builtinIds: [] }; }
}

/** Kept revisions, newest first, plus the original app. */
export async function listVersions(db, { deployedVersion = null } = {}) {
  const state = await readState(db);
  const ids = new Set();
  const rows = [];
  const entries = [...state.history];
  // Older records may reference revisions outside the history: list them too.
  for (const id of [state.active, state.previous, state.pending]) if (id && !entries.some((e) => e.id === id)) entries.push({ id, at: null });
  for (const entry of entries) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    const exists = await revisionExists(db, entry.id);
    const servable = exists && (!deployedVersion || !entry.version || entry.version === deployedVersion);
    rows.push({
      id: entry.id, at: entry.at ?? null, created: entry.created ?? null, version: entry.version ?? null,
      active: state.active === entry.id, previous: state.previous === entry.id, pending: state.pending === entry.id,
      probation: state.probation?.revision === entry.id, failed: Boolean(entry.failed), exists, servable,
      ...(!exists ? { why: "no longer stored" } : !servable ? { why: "made for an older deployment" } : {}),
    });
  }
  return { state, revisions: rows, original: { active: !state.active } };
}

/** "Use this version" (id) or "Use the original app" (null): same transition as the host. */
export async function useVersion(db, id, { deployedVersion = null, nav = globalThis.navigator } = {}) {
  if (id !== null) {
    if (!(await revisionExists(db, id))) throw new Error("That version is no longer stored.");
    const state = await readState(db);
    const entry = state.history.find((e) => e.id === id);
    if (deployedVersion && entry?.version && entry.version !== deployedVersion) throw new Error("That version was made for an older deployment and cannot be served.");
  }
  const { state } = await changeState(db, (s) => transitions.use(s, id));
  await notifyServiceWorker(nav);
  return state;
}

export async function listPlugins(store, { builtinIds = [] } = {}) {
  const rows = [];
  for (const selection of await store.selections()) {
    if (!selection || typeof selection.id !== "string" || !ID.test(selection.id)) continue; // probe records
    let name = selection.id, ok = false, reason;
    try {
      const snapshot = await store.snapshot(selection.id, selection.hash);
      if (snapshot) { name = snapshot.manifest?.name || name; ok = true; } else reason = "its files are missing";
    } catch (error) { reason = error?.message ?? String(error); }
    rows.push({ id: selection.id, name, hash: selection.hash, enabled: selection.enabled === true, builtin: builtinIds.includes(selection.id), ok, ...(reason ? { reason } : {}) });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** Enable/Disable one installed plugin: same selection record as browser-plugin-host.js. */
export async function setPluginEnabled(store, id, enabled, { builtinIds = [] } = {}) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid plugin");
  const current = await store.selection(id);
  if (!current) throw new Error("That plugin is not installed.");
  if (enabled) {
    // Like the host: only a verified snapshot can be enabled. Disable always works.
    const snapshot = await store.snapshot(id, current.hash);
    if (!snapshot) throw new Error("Its files are missing; it cannot be turned on.");
    const manifest = validatePackage(snapshot.files, builtinIds);
    if (manifest.id !== id || (await packageHash(snapshot.files)) !== current.hash) throw new Error("Its files are damaged; it cannot be turned on.");
  }
  if (current.enabled === enabled) return current;
  const next = { ...current, enabled };
  await store.publish(null, next);
  return next;
}

export async function disableAllPlugins(store) {
  const changed = [];
  for (const selection of await store.selections()) {
    if (!selection || typeof selection.id !== "string" || !ID.test(selection.id) || selection.enabled !== true) continue;
    await store.publish(null, { ...selection, enabled: false });
    changed.push(selection.id);
  }
  return changed;
}

/** Unregisters the page loader (service worker). Removes no data; the app registers it again. */
export async function resetServiceWorker(nav = globalThis.navigator) {
  const registrations = (await nav?.serviceWorker?.getRegistrations?.()) ?? [];
  let count = 0;
  for (const registration of registrations) if (await registration.unregister()) count++;
  return count;
}

const formatTime = (ms) => (ms ? new Date(ms).toLocaleString() : "time unknown");
const short = (id) => (id.length > 14 ? `${id.slice(0, 14)}…` : id);

/** Renders and wires the page. Everything is injectable; see recovery.html for the call. */
export async function mountRecoveryPage({ document, idb = globalThis.indexedDB, fetchImpl = globalThis.fetch, nav = globalThis.navigator,
  location = globalThis.location, storage = globalThis.localStorage } = {}) {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const say = (text) => { status.textContent = text; };
  const reason = new URLSearchParams(location?.search ?? "").get("reason");
  if (reason && REASONS[reason]) { $("reason").textContent = REASONS[reason]; $("reason").hidden = false; }

  // One tab owns the stores (the app holds the same lock): wait for other app tabs to close.
  let canWrite = !nav?.locks;
  const writable = () => canWrite;
  if (nav?.locks) {
    // Same one-tab lock as the app (browser-tab-lock.js): released when this page enters the
    // back/forward cache, so a recovery page you left never blocks the app; restored, it starts over.
    const tabLock = createTabLock({ locks: nav.locks, name: HOST_LOCK, win: globalThis.window ?? globalThis,
      onLost() { canWrite = false; $("locked").hidden = false; void render(); },
      onRestored() { globalThis.location?.reload?.(); } });
    if (await tabLock.acquire()) canWrite = true;
    else {
      $("locked").hidden = false;
      const take = $("take-over");
      if (take) {
        take.hidden = false;
        take.addEventListener("click", async () => { take.disabled = true; if (await tabLock.steal()) { canWrite = true; $("locked").hidden = true; take.hidden = true; void render(); } }, { once: true });
      }
      void tabLock.acquire({ wait: true }).then((ok) => { if (ok) { canWrite = true; $("locked").hidden = true; if (take) take.hidden = true; void render(); } });
    }
  }

  const deployed = await deployedInfo(fetchImpl, location?.href);
  let db;
  try { db = await openAppDb(idb); } catch (error) { say(`Could not open the app's saved versions: ${error?.message ?? error}`); }
  let store;
  try { store = await openPluginStore(idb, { probe: false }); } catch (error) { $("plugins-empty").textContent = `Could not open installed plugins: ${error?.message ?? error}`; }

  const button = (label, onClick, { disabled = false, aria } = {}) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.disabled = disabled || !writable();
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", async () => {
      if (!writable()) return;
      for (const other of document.querySelectorAll("button")) other.disabled = true;
      try { await onClick(); } catch (error) { say(`Not changed: ${error?.message ?? error}`); }
      await render();
    });
    return b;
  };
  const row = (children) => { const li = document.createElement("li"); li.append(...children); return li; };
  const span = (text, cls) => { const s = document.createElement("span"); s.textContent = text; if (cls) s.className = cls; return s; };

  async function renderVersions() {
    const list = $("versions");
    if (!db) { list.replaceChildren(); return; }
    const { state, revisions, original } = await listVersions(db, { deployedVersion: deployed.version });
    $("current").textContent = state.active ? `Current app: revision ${short(state.active)}${state.pending ? " (still starting)" : state.probation ? " (new, on probation)" : ""}` : "Current app: the original app";
    $("notice").textContent = state.notice ?? "";
    $("notice").hidden = !state.notice;
    const items = revisions.map((r) => row([
      span(`${formatTime(r.at)} · ${short(r.id)}`, "name"),
      span([r.active && "in use", r.failed && "did not start or stopped responding", r.why].filter(Boolean).join(" · "), "meta"),
      button(r.active ? "In use" : "Use this version", async () => {
        await useVersion(db, r.id, { deployedVersion: deployed.version, nav });
        say(`Done: revision ${short(r.id)} will be used. Open the app to continue.`);
      }, { disabled: r.active || !r.servable, aria: `Use the version from ${formatTime(r.at)}` }),
    ]));
    items.push(row([
      span("Original app (as deployed)", "name"),
      span(original.active ? "in use" : "", "meta"),
      button(original.active ? "In use" : "Use the original app", async () => {
        await useVersion(db, null, { nav });
        say("Done: the original app will be used. Open the app to continue.");
      }, { disabled: original.active }),
    ]));
    list.replaceChildren(...items);
  }

  async function renderPlugins() {
    const list = $("plugins");
    if (!store) { list.replaceChildren(); return; }
    const plugins = await listPlugins(store, deployed);
    $("plugins-empty").textContent = plugins.length ? "" : "No installed plugins.";
    $("plugins-empty").hidden = Boolean(plugins.length);
    list.replaceChildren(...plugins.map((p) => row([
      span(p.name === p.id ? p.id : `${p.name} (${p.id})`, "name"),
      span([p.enabled ? "on" : "off", p.reason].filter(Boolean).join(" · "), "meta"),
      p.enabled
        ? button("Disable", async () => { await setPluginEnabled(store, p.id, false, deployed); say(`Done: ${p.id} is off. Open the app to continue.`); }, { aria: `Disable ${p.name}` })
        : button("Enable", async () => { await setPluginEnabled(store, p.id, true, deployed); say(`Done: ${p.id} is on. Open the app to continue.`); }, { disabled: !p.ok, aria: `Enable ${p.name}` }),
    ])));
    const all = $("disable-all");
    all.disabled = !writable() || !plugins.some((p) => p.enabled);
    all.onclick = async () => {
      if (!writable()) return;
      all.disabled = true;
      try { const changed = await disableAllPlugins(store); say(changed.length ? `Done: ${changed.length} plugin(s) turned off. Open the app to continue.` : "No plugin was on."); }
      catch (error) { say(`Not changed: ${error?.message ?? error}`); }
      await render();
    };
  }

  async function render() {
    try { await renderVersions(); } catch (error) { say(`Could not read saved versions: ${error?.message ?? error}`); }
    try { await renderPlugins(); } catch (error) { $("plugins-empty").textContent = `Could not read installed plugins: ${error?.message ?? error}`; $("plugins-empty").hidden = false; }
    const reset = $("reset-loader");
    reset.disabled = false;
    reset.onclick = async () => {
      reset.disabled = true;
      try { const n = await resetServiceWorker(nav); say(n ? "Done: the page loader was reset. Open the app to continue." : "There was no page loader to reset."); }
      catch (error) { say(`Not reset: ${error?.message ?? error}`); }
      reset.disabled = false;
    };
  }

  // Diagnostics only: the last probation heartbeat (never changes anything).
  const beat = readHeartbeat(storage);
  if (beat) $("heartbeat").textContent = `Last check-in of revision ${short(beat.revision)}: ${formatTime(beat.at)}${beat.clean ? " (closed normally)" : ""}.`;
  await render();
  if (!status.textContent) say(canWrite ? "Ready." : "");
  return { render };
}
