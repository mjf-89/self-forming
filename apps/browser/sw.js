import { isPluginRequest, servePlugin } from "./builtin/core-plugin-management/web/browser-plugin-serving.js";
import { openAppDb, changeState, transitions } from "./browser-app-state.js";
import { STUCK_MS } from "./browser-probation.js";
// Browser edition service worker: serves the active editable app revision
// (stored in IndexedDB by browser-revisions.js) in place of the deployed files.
// Fixed files are always fetched from the deployment. ?safe on a page load, or
// ?sf-original=1 on a request, bypasses revisions. recovery.html is fixed too, and
// ?recovery on the app URL redirects to it.
const APP_DB = "self-forming-app";
// Bundled provider callback adapters, execution bootstrap/workers and pinned assets must match
// the deployed host even during safe recovery (never an editable APK payload).
const FIXED = /^(?:builtin\/core-plugin-management\/web\/browser-plugin-(?:host|store|package|serving)\.js$|assets\/web\/plugins\/|builtin\/core-providers-chatgpt\/web\/browser-oauth\.js$|builtin\/core-providers-claude\/web\/browser-auth\.js$|builtin\/core-execution\/web\/browser\/|builtin\/exec-(?:js|linux)\/web\/browser\/|vendor\/|library\/|cors-rot\/|browser-[^/]*\.js$|sw\.js$|native-host\.js$|app-manifest\.json$|recovery\.html$|fonts\/|manifest\.webmanifest$|icons\/)/;
// Installable web app: revisions may carry an index.html from before the manifest existed.
const PWA_LINKS = '<link rel="manifest" href="./manifest.webmanifest" /><link rel="icon" href="./icons/favicon.svg" type="image/svg+xml" /><link rel="icon" href="./icons/icon-192.png" /><link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />';
const SPLASH = '<script src="./browser-splash.js"></script>';
function withPwaLinks(bytes) {
  const original = new TextDecoder().decode(bytes);
  let html = original;
  // Boot cover (browser-splash.js): first in <head>, also for revisions saved before it existed.
  if (!/browser-splash\.js/.test(html)) html = html.replace(/<head[^>]*>/i, (head) => head + SPLASH);
  if (!/<link[^>]+rel=["']?manifest/i.test(html)) html = html.replace(/<head[^>]*>/i, (head) => head + PWA_LINKS);
  return html === original ? bytes : new TextEncoder().encode(html);
}
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", wasm: "application/wasm", woff2: "font/woff2", ttf: "font/ttf" };
const safeClients = new Set();
let cached; // { active, files }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data?.type === "revision-changed") cached = undefined;
  if (event.data?.type === "plugin-serving") event.ports[0]?.postMessage({ pluginServing: 1 });
  if (event.data?.type === "probation-heartbeat" && event.source?.id) watchProbation(event);
  if (event.data?.type === "probation-end" && event.source?.id) beats.delete(event.source.id);
});

// Outside watchdog for a revision on probation (see browser-probation.js). Pages post a
// heartbeat every few seconds; when a VISIBLE window of the probation revision has been
// silent for STUCK_MS, the revision is rolled back and the window is sent to the recovery
// page. Hidden/background windows and pages that never sent a heartbeat are left alone.
// A completely hung renderer may only navigate once the browser intervenes; the next load
// then rolls back through the heartbeat record (browser-revisions.js).
const beats = new Map(); // client id -> { revision, at }
function watchProbation(event) {
  const id = event.source.id, revision = String(event.data.revision ?? "");
  const beat = { revision, at: Date.now() };
  beats.set(id, beat);
  event.waitUntil(new Promise((resolve) => setTimeout(resolve, STUCK_MS + 1000)).then(async () => {
    if (beats.get(id) !== beat) return; // a newer heartbeat (or the end of probation) arrived
    const client = await self.clients.get(id);
    if (!client) { beats.delete(id); return; }
    if (client.visibilityState !== "visible") return; // background tabs are throttled, not stuck
    beats.delete(id);
    const db = await openAppDb(indexedDB);
    try {
      await changeState(db, (s) => (s.active === revision && s.probation?.revision === revision
        ? transitions.rollback(s, `Revision ${revision} stopped responding; restored the previous version.`, { revision }) : null));
    } finally { db.close(); }
    cached = undefined;
    try { await client.navigate(new URL("recovery.html?reason=unresponsive", self.registration.scope).href); } catch { /* not navigable */ }
  }).catch(() => {}));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(APP_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("revisions");
      request.result.createObjectStore("state");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const get = (db, store, key) => new Promise((resolve, reject) => {
  const request = db.transaction(store).objectStore(store).get(key);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

let deployedVersionPromise;
function deployedVersion() {
  deployedVersionPromise ??= fetch(new URL("./app-manifest.json?sf-original=1", self.registration.scope), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null)).then((m) => m?.hostVersion ?? null)
    .catch(() => { deployedVersionPromise = undefined; return null; });
  return deployedVersionPromise;
}

async function activeFiles() {
  const db = await openDb();
  try {
    const state = await get(db, "state", "state");
    const active = state?.active ?? null;
    if (cached && cached.active === active) return cached.files;
    const revision = active ? await get(db, "revisions", active) : undefined;
    // Only serve a revision made for the deployed version: after an update, an older revision's
    // app files may not match the new host modules (the editable folder is re-seeded per version).
    const deployed = await deployedVersion();
    const files = revision && (!deployed || revision.version === deployed) ? revision.files : null;
    // A revision whose page would not start the browser host is never served.
    if (files?.["index.html"] && !new TextDecoder().decode(files["index.html"]).includes("browser-main.js")) delete files["index.html"];
    cached = { active, files };
    return files;
  } finally { db.close(); }
}

// Large fixed assets (Linux image and snapshot, WebAssembly clients) are kept in Cache Storage and
// revalidated with the server's ETag / Last-Modified, so they are downloaded only when they change.
// Content-addressed flat files of the Linux image never change: served from the cache directly.
const ASSET_CACHE = "self-forming-assets-v1";
const CACHED_ASSET = /^(?:vendor\/v86\/|cors-rot\/vendor\/)/;
async function cachedAsset(request, name) {
  const cache = await caches.open(ASSET_CACHE);
  const key = new Request(new URL(request.url).href.split("?")[0]);
  const cached = await cache.match(key);
  if (cached && /^vendor\/v86\/image\/flat\//.test(name)) return cached;
  const headers = new Headers();
  const etag = cached?.headers.get("etag"), modified = cached?.headers.get("last-modified");
  if (etag) headers.set("if-none-match", etag);
  else if (modified) headers.set("if-modified-since", modified);
  let response;
  try { response = await fetch(key, { headers, cache: "no-store" }); }
  catch (error) { if (cached) return cached; throw error; } // offline: use what we have
  if (response.status === 304 && cached) return cached;
  if (response.ok && response.status === 200) {
    try { await cache.put(key, response.clone()); } catch { /* quota: serve without caching */ }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (isPluginRequest(url, self.registration.scope)) { event.respondWith(servePlugin(request, self.registration.scope)); return; }
  if (request.method !== "GET") return;
  {
    const name = decodeURIComponent(url.pathname.slice(scope.pathname.length));
    if (CACHED_ASSET.test(name) && !request.headers.has("range")) { event.respondWith(cachedAsset(request, name)); return; }
  }
  if (request.mode === "navigate") {
    // ?recovery on the app URL opens the fixed recovery page (browser-main.js does the same without this worker).
    if (url.searchParams.has("recovery") && /^(?:index\.html)?$/.test(url.pathname.slice(scope.pathname.length))) { event.respondWith(Response.redirect(new URL("recovery.html", scope).href, 302)); return; }
    if (url.searchParams.has("safe")) { if (event.resultingClientId) safeClients.add(event.resultingClientId); return; }
    if (event.resultingClientId) safeClients.delete(event.resultingClientId);
  } else if (safeClients.has(event.clientId)) return;
  if (url.searchParams.has("sf-original")) return;
  let name = decodeURIComponent(url.pathname.slice(scope.pathname.length));
  if (name === "" || name.endsWith("/")) name += "index.html";
  if (FIXED.test(name)) return;
  event.respondWith((async () => {
    try {
      const files = await activeFiles();
      let bytes = files?.[name];
      if (bytes && name === "index.html") bytes = withPwaLinks(bytes);
      if (bytes) {
        const ext = name.split(".").pop().toLowerCase();
        return new Response(bytes, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
      }
    } catch { /* fall back to the deployed file */ }
    return fetch(request);
  })());
});
