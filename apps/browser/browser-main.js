// Browser edition entry point (fixed, never taken from an app revision).
// Opens the browser file system, installs the in-page host as globalThis.PiNative,
// then starts the regular app (app.js), which cannot tell it from the Android host
// except through host.info.platform === "browser".
// Fixed bootstrap uses the execution owner's bundled backend before composition;
// revisions, storage and execution all receive this same page filesystem.
import { Vfs } from "../../plugins/core-execution/web/browser/browser-vfs.js";
import { createBrowserHost } from "./browser-host.js";
import { createRevisions } from "./browser-revisions.js";
import { createRecoveryNotices, STARTUP_READY_MS } from "./browser-recovery-ui.js";
import { createTabLock } from "./browser-tab-lock.js";
import { mountBrowserOAuth } from "../../plugins/core-providers-chatgpt/web/browser-oauth.js";
import { mountBrowserNetwork } from "../../plugins/net-tailscale/web/browser-network-ui.js";
import { mountTorProgress } from "../../plugins/net-tor/web/browser-progress.js";
import { mountSnowflakeSettings } from "../../plugins/net-tor/web/browser-snowflake.js";
import { mountPreconnect } from "../../plugins/core-agent/web/browser-preconnect.js";
import { createBrowserActivity } from "../../plugins/core-chat/web/browser-activity.js";

import { createBrowserPlugins } from "../../plugins/core-plugin-management/web/browser-plugin-host.js";

const params = new URLSearchParams(location.search);
const safe = params.has("safe");
// Recovery (fixed): ?recovery opens the recovery page (the service worker redirects too);
// a fixed bar outside the app's DOM content reports a failed start and offers Undo after
// an app update. Neither depends on app.js, plugins or the app's CSS.
const recoveryUrl = new URL("./recovery.html", import.meta.url).href;
const recoveryRequested = params.has("recovery");
if (recoveryRequested) location.replace(recoveryUrl);
const notices = createRecoveryNotices({ document, recoveryUrl }); // Undo reloads (default) only after a user click

const splash = () => globalThis.__sfSplash; // browser-splash.js (boot cover); absent in a page that predates it
function showStartupError(message) {
  const status = document.getElementById("status");
  const error = document.getElementById("error");
  if (status) status.textContent = "Could not start Self Forming";
  if (error) { error.textContent = message; error.hidden = false; }
  else document.body.textContent = message;
}

// One app tab at a time (browser-tab-lock.js says why). Fixed notices, inline-styled and appended to
// the document root, so an edited app's CSS cannot hide them.
function tabNotice(text, { action, onAction } = {}) {
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText = "position:fixed !important;inset:auto 0 0 0 !important;z-index:2147483647 !important;display:block !important;visibility:visible !important;opacity:1 !important;padding:16px !important;background:#111 !important;color:#eee !important;font:15px/1.4 monospace !important;border-top:1px solid #555 !important";
  const p = document.createElement("p");
  p.style.cssText = "margin:0 0 10px 0 !important";
  p.textContent = text;
  box.append(p);
  if (action) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = action;
    button.style.cssText = "font:15px monospace !important;padding:8px 14px !important;min-height:40px !important;margin-right:12px !important";
    button.addEventListener("click", () => { button.disabled = true; onAction?.(); }, { once: true });
    box.append(button);
  }
  const link = document.createElement("a");
  link.href = recoveryUrl; link.textContent = "Recovery";
  link.style.cssText = "color:#8fd !important;font:15px monospace !important";
  box.append(link);
  document.documentElement.append(box);
  return box;
}
// This tab no longer owns the storage (another tab took over, or a restored page could not take it
// back): stop at once by reloading; the reloaded page offers to take it over again.
function tabLost() {
  tabNotice("Self Forming was opened in another tab of this browser. This tab stopped so the two cannot overwrite each other's files.");
  setTimeout(() => location.replace(location.pathname), 1500);
}
// The lock is held by another tab (or a page the browser still keeps): offer to use this tab.
function offerTakeOver(tabLock) {
  splash()?.pause(); // waiting for the user: keep the cover, the notice sits above it
  return new Promise((resolve) => {
    const box = tabNotice("Self Forming seems to be open in another tab of this browser. Only one tab can use your files at a time.", {
      action: "Use it in this tab",
      async onAction() {
        await tabLock.steal();
        // Give the other tab a moment to save its last changes and stop before this tab reads the files.
        await new Promise((r) => setTimeout(r, 800));
        box.remove();
        splash()?.resume();
        resolve();
      }
    });
  });
}

// Installable web app: make sure the page links the manifest even when it comes from an
// edited app revision whose index.html predates it (the service worker also patches it).
function ensurePwaLinks() {
  if (document.querySelector('link[rel="manifest"]')) return;
  for (const [rel, href] of [["manifest", "./manifest.webmanifest"], ["icon", "./icons/icon-192.png"], ["apple-touch-icon", "./icons/apple-touch-icon.png"]]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = new URL(href, import.meta.url).href;
    document.head.append(link);
  }
}

async function main() {
  if (recoveryRequested) { splash()?.reveal("recovery"); return; }
  ensurePwaLinks();
  if (!window.isSecureContext) throw new Error("Open this page over HTTPS (or http://localhost): browser storage and workers need a secure context.");
  if (!("indexedDB" in globalThis)) throw new Error("This browser has no IndexedDB, so files and conversations cannot be saved.");
  // One tab owns the files at a time; a second tab would overwrite the first one's changes. The lock
  // is released when Safari/Chrome keep this page in the back/forward cache (browser-tab-lock.js).
  if (navigator.locks) {
    const tabLock = createTabLock({ locks: navigator.locks, onLost: tabLost });
    if (!await tabLock.acquire()) await offerTakeOver(tabLock);
  }
  try { await navigator.storage?.persist?.(); } catch { /* the browser may evict storage under pressure */ }

  const manifest = await fetch("./app-manifest.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined);
  const version = String(manifest?.hostVersion ?? "browser");
  const vfs = await Vfs.open();
  const revisions = await createRevisions({ vfs, version, manifest, safe, onReady: () => notices.ready() }).catch((cause) => {
    console.warn("Self Forming: app editing unavailable", cause);
    return undefined;
  });
  if (revisions?.recovery) {
    // Without revisions (no service worker) app.ready is never reported: only failures show.
    notices.expectReady(Math.max(0, STARTUP_READY_MS - (performance.now?.() ?? 0)));
    const recovery = revisions.recovery;
    const alert = recovery.alert();
    if (alert) notices.showAlert({ ...alert, dismiss: () => recovery.dismissAlert() });
    const update = recovery.updateNotice();
    if (update) notices.showUpdate({ ...update, undo: () => recovery.undo(), keep: () => recovery.keep(), dismiss: () => recovery.dismissUpdate() });
  }
  // Wait for first-load claim without reloading. A failed worker leaves management
  // unadvertised rather than offering imports which would silently hit the network.
  let plugins;
  try {
    if (!navigator.serviceWorker) throw new Error("Service workers unavailable");
    await navigator.serviceWorker.register(new URL("./sw.js", location.href), { type: "module", scope: new URL("./", location.href).pathname });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const changed = () => { if (navigator.serviceWorker.controller) { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", changed); resolve(); } };
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("controllerchange", changed); reject(new Error("Service worker did not claim this page")); }, 10000);
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      changed();
    });
    // A handshake proves the controlling worker implements immutable serving (an
    // older deployed controller is not sufficient).
    const controller = await new Promise((resolve, reject) => {
      let port;
      const cleanup = () => { clearTimeout(timer); port?.close(); navigator.serviceWorker.removeEventListener("controllerchange", ask); };
      const ask = () => {
        port?.close();
        const worker = navigator.serviceWorker.controller;
        if (!worker) return;
        const channel = new MessageChannel(); port = channel.port1;
        port.onmessage = event => { if (event.data?.pluginServing === 1 && navigator.serviceWorker.controller === worker) { cleanup(); resolve(worker); } };
        worker.postMessage({ type: "plugin-serving" }, [channel.port2]);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Installed plugin serving unavailable")); }, 10000);
      navigator.serviceWorker.addEventListener("controllerchange", ask);
      ask();
    });
    plugins = await createBrowserPlugins({ vfs, builtinIds: manifest?.builtinIds, safe,
      serving: () => navigator.serviceWorker.controller === controller,
      assetBase: new URL("assets/web/plugins/", location.href).pathname });
  } catch (cause) { console.warn("Self Forming: installed plugins unavailable", cause); }
  const host = await createBrowserHost({ version, vfs, revisions, plugins });
  host.install();
  mountBrowserOAuth(host.oauth);
  // Page supplies explicit existing DOM slots/events; feature implementations stay
  // with their owners. No second chat/composer or route client is created here.
  const slots = { anchor: document.querySelector(".mode-controls"), document };
  const networkUi = [mountBrowserNetwork(host.network, slots), mountTorProgress(host.network, {
    anchor: document.querySelector(".composer-notices"), floating: document.body, document
  })];
  const activity = createBrowserActivity({ document });
  networkUi.push(() => activity.dispose(), mountPreconnect({ network: host.network,
    getProvider: activity.getProvider, subscribeActivity: activity.subscribe,
    subscribeVisibility(listener) {
      const changed = () => listener(document.visibilityState === "visible");
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
    hintBrowser(origin) {
      const link = document.createElement("link");
      Object.assign(link, { rel: "preconnect", href: origin, crossOrigin: "anonymous" });
      document.head.append(link);
      return () => link.remove();
    }
  }));
  // Give back to the Snowflake network: the library runs the proxy while Tor is the selected route;
  // this only renders its status in Settings → Network.
  const snowflakeProxy = host.network.snowflakeProxy;
  try { if (snowflakeProxy) networkUi.push(mountSnowflakeSettings(snowflakeProxy, slots)); } catch (cause) { console.warn("Snowflake proxy status unavailable", cause); }
  // Routing: generic Settings → Providers; canonical self-forming.net.route (Tailscale default).
  // setMode/getStatus return promises; fetch/fetchTor return streaming Responses.
  globalThis.__piBrowser = { vfs, version, safe, pluginAssetBase: plugins?.assetBase, network: host.network, snowflakeProxy, git: host.git, execution: host.execution, activity };
  addEventListener("pagehide", () => { for (const stop of networkUi) stop?.(); host.dispose(); plugins?.close(); void vfs.flush().catch(() => {}); });
  await import("./app.js");
  // Start the selected route right away (Tailscale client, or Tor with the directory download on a
  // cold start) so it is ready by the time a request needs it. Tor progress shows above the message box.
  void host.network.warmUp().catch(() => {});
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  notices.failed(message);
  showStartupError(message);
  splash()?.reveal("error"); // never leave the page covered: the error and the recovery bar are shown
});
