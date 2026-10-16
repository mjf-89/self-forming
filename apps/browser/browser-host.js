// Browser edition host: answers the same JSON bridge protocol as the Android
// host (docs/bridge.md), entirely inside the page.
//  - env.*   files  -> Vfs (in memory, persisted to IndexedDB)
//  - env.exec       -> the shell named by the call: exec-js (JavaScript in a fresh module Worker)
//                      or exec-linux (Bash in the page's one Alpine/v86 VM); see execution@1
//  - http.*         -> selected net.fetch provider (stream framing/cancellation only)
//  - auth.*         -> localStorage records; ChatGPT uses Pi's manual callback fallback
//  - app.*          -> editable app revisions served by the service worker (browser-revisions.js)
// The unchanged app (app.js, session.js, native-host.js) talks to it through globalThis.PiNative.
// Explicit bundled bootstrap entry: composition and recovery share this backend/VFS.
import { Vfs } from "../../plugins/core-execution/web/browser/browser-vfs.js";
import { createBrowserExecution } from "../../plugins/core-execution/web/browser/browser-execution.js";
import { createJavaScriptShell } from "../../plugins/exec-js/web/browser/js-shell.js";
import { createLinuxShell } from "../../plugins/exec-linux/web/browser/linux-shell.js";
import { createController as createGitController } from "../../plugins/core-git/web/index.js";
import { createNetworkDiagnostics } from "../../plugins/net-tailscale/web/browser-network-ui.js";
import { createBrowserNetwork } from "./browser-network.js";
import { createBrowserOAuth, loadChatGPTRecord, sanitizeChatGPTRecord } from "../../plugins/core-providers-chatgpt/web/browser-oauth.js";
import { loadClaudeBrowserRecord, openClaudeBrowserSignIn } from "../../plugins/core-providers-claude/web/browser-auth.js";

const CHUNK = 64 * 1024;
const WORKSPACE = "/workspace";

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const failure = (code, message, path) => Object.assign(new Error(message), { code, path });

export async function createBrowserHost({ version = "browser", vfs, revisions, network, plugins, linuxAssets } = {}) {
  vfs ??= await Vfs.open();
  const routeNetwork = network ?? createBrowserNetwork({ storage: globalThis.localStorage });
  const routedFetch = (input, init, tor = false) => tor ? routeNetwork.fetchTor(input, init) : routeNetwork.fetch(input, init);
  const transport = { onmessage: null, postMessage(message) { void receive(message); } };
  const requests = new Map();    // http requestId -> state

  const deliver = (value) => {
    const data = JSON.stringify(value);
    setTimeout(() => transport.onmessage?.({ data }), 0);
  };
  const emit = (event) => deliver(event);

  async function receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const { id, method, params = {} } = message;
    try {
      const handler = methods[method];
      if (!handler) throw failure("METHOD_NOT_FOUND", `The browser edition does not support ${method}.`);
      const result = await handler(params);
      deliver({ id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      const code = error?.code ? String(error.code) : "unknown";
      deliver({ id, ok: false, error: { code, message: error?.message || String(error), ...(typeof error?.path === "string" ? { path: error.path } : {}) } });
    }
  }

  // One binary VFS and one owning Git service, shared by composition/recovery.
  let git;
  // One shell of each execution@1 provider per page (exec-js, exec-linux: at most one VM).
  const shells = { javascript: createJavaScriptShell(), bash: createLinuxShell({ vfs, network: routeNetwork, ...linuxAssets ? { assets: linuxAssets } : {} }) };
  const execution = createBrowserExecution({ vfs, network: routeNetwork, emit, git: () => git.resolve(), shells });
  git = createGitController({ fs: execution.filesystem, fetch: routeNetwork.fetch, origin: globalThis.location?.href });

  // ------------------------------------------------------------------ HTTP through fetch
  const diagnostics = createNetworkDiagnostics();
  const reportNetworkFailure = diagnostics.report;
  const http = {
    "http.open"({ requestId, url, method, headers, hasBody }) {
      if (requests.has(requestId)) throw failure("INVALID_REQUEST", "Duplicate request id");
      if (requests.size >= 8) {
        reportNetworkFailure({ url, method }, failure("HTTP_BUSY", `Too many open requests (${requests.size})`));
        throw failure("HTTP_BUSY", "Too many concurrent requests");
      }
      requests.set(requestId, { url, method, headers, hasBody, body: [], controller: new AbortController(), reader: undefined, rest: undefined });
    },
    "http.write"({ requestId, data }) {
      const request = requests.get(requestId);
      if (!request) throw failure("INVALID_REQUEST", "Unknown request");
      request.body.push(fromBase64(data));
    },
    async "http.send"({ requestId }) {
      const request = requests.get(requestId);
      if (!request) throw failure("INVALID_REQUEST", "Unknown request");
      const headers = new Headers();
      for (const [name, value] of request.headers ?? []) {
        if (name.toLowerCase() === "user-agent") continue;
        try { headers.append(name, value); } catch { /* forbidden header names are dropped by browsers anyway */ }
      }
      if (new URL(request.url).hostname === "api.anthropic.com") headers.set("anthropic-dangerous-direct-browser-access", "true");
      let body;
      if (request.hasBody) body = new Blob(request.body);
      request.body = [];
      let response;
      try {
        response = await routedFetch(request.url, { method: request.method, headers, body, signal: request.controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      } catch (error) {
        requests.delete(requestId);
        if (request.controller.signal.aborted) throw failure("ABORTED", "Request cancelled");
        // Model SDKs replace this with a generic "Connection error.", so keep the real cause visible.
        reportNetworkFailure(request, error);
        throw failure("HTTP_ERROR", `Network request failed for ${new URL(request.url).host}. The selected network provider must be ready. ${error?.message ?? ""}`.trim());
      }
      if (request.controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure("ABORTED", "Request cancelled");
      }
      request.reader = response.body?.getReader();
      return { status: response.status, statusText: response.statusText, headers: [...response.headers], url: request.url };
    },
    async "http.read"({ requestId }) {
      const request = requests.get(requestId);
      if (!request) throw failure("INVALID_REQUEST", "Unknown request");
      if (!request.reader) { requests.delete(requestId); return { data: "", done: true }; }
      try { for (;;) {
        if (request.rest?.length) {
          const chunk = request.rest.subarray(0, CHUNK);
          request.rest = request.rest.subarray(chunk.length);
          return { data: toBase64(chunk), done: false };
        }
        const { value, done } = await request.reader.read();
        if (done) { requests.delete(requestId); request.reader.releaseLock(); return { data: "", done: true }; }
        if (value?.length) request.rest = value;
      } } catch (error) {
        requests.delete(requestId);
        if (!request.controller.signal.aborted) reportNetworkFailure(request, error);
        request.controller.abort();
        void request.reader.cancel().catch(() => {});
        throw error;
      }
    },
    "http.cancel"({ requestId }) {
      const request = requests.get(requestId);
      requests.delete(requestId);
      request?.controller.abort();
      void request?.reader?.cancel().catch(() => {});
    },
  };

  // ------------------------------------------------------------------ credentials
  // Host-owned persistence/identity: both controllers share the bridge and recovery must
  // work before composition. This is not a generic plugin credential capability or vault.
  const authKey = (provider = "chatgpt") => {
    if (provider !== "chatgpt" && provider !== "claude") throw failure("AUTH_ERROR", "Unsupported browser auth provider.");
    return `self-forming.browser.auth.${provider}`;
  };
  const openExternal = url => window.open(url, "_blank", "noopener,noreferrer");
  let hostId = localStorage.getItem("self-forming.browser.host-id");
  if (!hostId) { hostId = `urn:uuid:${crypto.randomUUID()}`; localStorage.setItem("self-forming.browser.host-id", hostId); }
  const oauth = createBrowserOAuth();
  const auth = {
    "auth.info": () => ({ hostId, storage: "browser" }),
    "auth.load": ({ provider }) => {
      const key = authKey(provider);
      return provider === "claude" ? loadClaudeBrowserRecord(localStorage, key) : loadChatGPTRecord(localStorage, key);
    },
    "auth.save": ({ provider, record }) => {
      const key = authKey(provider);
      const saved = provider === "claude" ? record : sanitizeChatGPTRecord(record);
      try { localStorage.setItem(key, JSON.stringify(saved)); }
      catch { throw failure("AUTH_ERROR", "ChatGPT sign-in could not be saved in this browser."); }
    },
    "auth.clear": ({ provider }) => { localStorage.removeItem(authKey(provider)); },
    "auth.openExternal": ({ provider, url }) => {
      // Only Claude owns this bridge operation; ChatGPT uses its manual callback adapter.
      authKey(provider);
      if (provider !== "claude") throw failure("AUTH_ERROR", "Unsupported browser auth provider.");
      return openClaudeBrowserSignIn(url, openExternal);
    },
    ...oauth.methods,
  };

  // ------------------------------------------------------------------ methods
  const methods = {
    "host.info": () => ({
      platform: "browser", version, foreground: true, workspace: WORKSPACE,
      pluginAssetBase: plugins?.assetBase,
      capabilities: { plugins: plugins?.available() === true, pluginRead: plugins?.available() === true, nativePlugins: false, executionEnv: true, linuxShell: true, editableApp: Boolean(revisions), secrets: false, backgroundExecution: false, apkInstall: false, storage: "browser" },
    }),
    ...(plugins?.methods ?? {}),
    ...execution.methods,
    "host.keepAlive": () => {},
    "host.back": () => {},
    ...http,
    ...auth,
    ...(revisions?.methods ?? {}),
  };

  return {
    transport,
    vfs,
    oauth, execution, git,
    network: Object.assign(Object.create(null), routeNetwork, {
      recentFailures: diagnostics.recentFailures,
      onFailure: diagnostics.onFailure,
    }),
    dispose() {
      oauth.dispose();
      void Promise.resolve(routeNetwork.dispose?.()).catch(() => {});
      diagnostics.dispose();
      execution.dispose();
      for (const requestId of [...requests.keys()]) http["http.cancel"]({ requestId });
    },
    install() {
      if ("PiNative" in globalThis) throw new Error("A native host is already present");
      globalThis.PiNative = transport;
    },
  };
}
