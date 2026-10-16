// net-tailscale: the user's Tailscale exit node, a net.fetch@1 provider over vendored cors-rot.
// Browser defaults to this provider; Android retains its native default. Activation follows
// intended choice/default even while unavailable; it never bootstraps through selected fetch.
// Availability requires a running signed-in node with an applied exit node. An unavailable
// choice/default is not permission for implicit page/native fallback.
// Sign-in uses cors-rot's login link or optional auth key. Android plugin credentials use
// auth.* plugin records protected by the native credential lane. Browser bootstrap explicitly
// supplies the owner's best-effort storage adapter, preserving existing localStorage keys;
// without either backend, state is memory-only. Persistence failures are reported honestly.
// Deselection keeps the node running. Explicit sign-out clears state; page disposal freezes
// browser writes before upstream logout so reload state survives. Nothing secret is logged.
const NET_SERVICE = "net.fetch";
export const ROUTE_ID = "net-tailscale";
export const SLOT = "provider:net.fetch@1";
export const SECTION_KEY = "net-tailscale-options";
export const CREDENTIAL = "state";
export const AUTHKEY = "authkey";
const NAME = "Tailscale exit node";
const HINT = "through your own exit node; needs sign-in; downloads ~38 MB; experimental";

const text = (value) => String(value ?? "").slice(0, 200);

/** The credentials lane of this plugin over the bridge's auth.* methods (pluginCredentials hosts), else null. */
export function bridgeCredentials(bridge, hostInfo) {
  if (!bridge || typeof bridge.call !== "function" || hostInfo?.capabilities?.pluginCredentials !== true) return null;
  const provider = (name) => `plugin:${ROUTE_ID}:${name}`;
  return Object.freeze({
    load: (name) => bridge.call("auth.load", { provider: provider(name) }),
    save: (name, record) => bridge.call("auth.save", { provider: provider(name), record }),
    clear: (name) => bridge.call("auth.clear", { provider: provider(name) })
  });
}

/**
 * The synchronous storage object cors-rot's Tailscale manager wants (getItem/setItem/removeItem; its keys are the own
 * enumerable properties, as its logout() lists them), backed by ONE credential record. load() must finish before the
 * manager is created; writes are saved in order through the lane (clear when empty). Failures only set `lost`.
 */
export function createCredentialStorage(credentials) {
  const store = Object.create(null);
  const state = { persistent: Boolean(credentials), lost: false, loaded: false };
  let chain = Promise.resolve();
  const save = () => {
    if (!credentials || state.lost) return;
    chain = chain.then(() => {
      const items = { ...store };
      return Object.keys(items).length ? credentials.save(CREDENTIAL, { v: 1, items }) : credentials.clear(CREDENTIAL);
    }).catch(() => { state.lost = true; });
  };
  Object.defineProperties(store, {
    getItem: { value: (key) => (key in store ? store[key] : null) },
    setItem: { value: (key, value) => { store[String(key)] = String(value); save(); } },
    removeItem: { value: (key) => { delete store[String(key)]; save(); } }
  });
  return {
    storage: store,
    state,
    async load() {
      if (state.loaded) return;
      state.loaded = true;
      if (!credentials) return;
      try {
        const record = await credentials.load(CREDENTIAL);
        if (record && record.v === 1 && record.items && typeof record.items === "object") {
          for (const [key, value] of Object.entries(record.items)) if (typeof value === "string") store[key] = value;
        }
      } catch { state.lost = true; } // unreadable: stay in memory so a failed read never overwrites the record
    },
    /** Forget everything (sign out): memory and the saved record. */
    reset() {
      for (const key of Object.keys(store)) delete store[key];
      if (!credentials) return chain;
      chain = chain.then(() => credentials.clear(CREDENTIAL)).catch(() => { state.lost = true; });
      return chain;
    },
    flush: () => chain
  };
}

/** The optional auth key: one separate credential record; memory only without the lane. Never read back in full. */
export function createAuthKeyStore(credentials) {
  const state = { key: "", persistent: Boolean(credentials), lost: false };
  return {
    state,
    async load() {
      if (!credentials) return;
      try {
        const record = await credentials.load(AUTHKEY);
        if (record && record.v === 1 && typeof record.key === "string") state.key = record.key;
      } catch { state.lost = true; }
    },
    async save(key) {
      state.key = String(key ?? "").trim();
      if (!credentials) return;
      try { if (state.key) await credentials.save(AUTHKEY, { v: 1, key: state.key }); else await credentials.clear(AUTHKEY); state.lost = false; } catch { state.lost = true; }
    },
    /** "tskey-…abcd": never the whole key. */
    masked() { const k = state.key; return !k ? "" : k.length >= 20 ? `${k.slice(0, 3)}…${k.slice(-4)}` : "••••"; }
  };
}

const STATES = {
  loading: "Starting Tailscale (loading the client)…", NoState: "Starting Tailscale…", Starting: "Starting Tailscale…",
  Stopped: "Tailscale is stopped.", off: "Tailscale is signed out. Select it again or sign in to continue."
};
/** Plain sentences for the status line from the manager status (or none = never started). */
export function describeTailscale({ started, loadError, status, startError }) {
  if (loadError) return `Tailscale could not start: ${loadError}`;
  if (!started || !status) return "Tailscale is not running. It starts when you select it as the network provider.";
  if (startError && status.state !== "Running" && status.state !== "error") return `Tailscale could not start: ${text(startError)}. Requests use the default network.`;
  switch (status.state) {
    case "error": return `Tailscale could not start: ${text(status.error || startError) || "unknown error"}. Requests use the default network.`;
    case "NeedsLogin": return status.loginURL ? "Sign in to Tailscale with the link below. Requests use the default network until then." : "Waiting for a Tailscale sign-in link…";
    case "NeedsMachineAuth": return "Waiting for an admin to approve this device in the Tailscale admin console.";
    case "Running":
      if (status.appliedExitNode) return "Connected through your exit node.";
      return status.error ? text(status.error)
        : (status.exitNodes ?? []).some((n) => n.online) ? "Choose an exit node below. Requests use the default network until then."
          : "No exit node is online in your tailnet (or your access rules do not let this device use one).";
    default: return STATES[status.state] ?? "Starting Tailscale…";
  }
}

function createImplementation({ selection, subscribe, refresh, bridge, hostInfo, credentials: injected, browserStorage, loadCorsRot = () => import("../../../cors-rot/index.js") } = {}) {
  return {
    name: NAME,
    hint: HINT,
    setup(ctx) {
      let instance = null, starting = null, loadError = "", status = null, vault = null, authKeys = null, startError = "";
      let wasSelected = false;
      const stops = [];
      const views = new Set();
      const closed = () => ctx.signal.aborted;
      // Start the intended provider even when it is not ready yet. Resolving the ready provider
      // here would deadlock a lazy default: availability becomes true only AFTER it starts.
      const selected = () => {
        try { return (selection?.choice?.(NET_SERVICE, 1) ?? selection?.resolve?.(NET_SERVICE, 1)?.default) === ROUTE_ID; }
        catch { return false; }
      };
      const poke = () => { try { refresh?.(); } catch { /* the status line only */ } };
      const render = () => { for (const view of views) { try { view.update(); } catch { /* UI only */ } } };

      const available = () => Boolean(instance) && status?.state === "Running" && Boolean(status?.appliedExitNode) && !closed();
      const describe = () => Object.freeze({
        id: ROUTE_ID, label: NAME, reaches: "any", private: false, persistent: false,
        ready: async () => available(), status: available() ? "ready" : "unavailable"
      });
      const service = Object.freeze(Object.assign((input, init) => {
        if (!available()) return Promise.reject(new Error("Tailscale is not connected"));
        return instance.fetch(input, init);
      }, { available, describe, transport: Object.freeze({
        version: 1, signOut: () => signOutNode(),
        connect: (host, port, options) => available() ? instance.connect(host, port, options) : Promise.reject(new Error("Network route is not ready")),
        warmUp: async () => { begin(); await starting; return instance?.warmUp(); },
        preconnect: (url) => available() ? instance.preconnect(url) : Promise.resolve({ warmed: false, reason: "unavailable" }),
        getStatus: () => ({ ...(instance?.getStatus?.() ?? {}), loadError, ready: available(), tailscale: status }),
        get tailscale() { return instance?.tailscale; },
        get snowflakeProxy() { return instance?.snowflakeProxy; },
        // Browser page exit: never dispose the instance. cors-rot's dispose() stops the Tailscale node and
        // its close() is a SERVER-SIDE logout (ipn.logout), which forced a new sign-in after every reload
        // and every app_update activation. The page's WASM client ends with the page; only the explicit
        // Sign out button logs out. Android (scope-owned, no browserStorage) keeps the full dispose.
        dispose: async () => { if (browserStorage) { browserStorage.preserve(); return; } await instance?.dispose?.(); }
      }) }));
      ctx.provide(NET_SERVICE, 1, service);

      const lane = () => ctx.credentials ?? injected ?? bridgeCredentials(bridge, hostInfo);
      function begin() {
        loadError = "";
        if (instance) { // selected again (the node kept running), or retry after an error
          if (status?.state !== "Running") instance.warmUp();
          render();
          return;
        }
        if (starting) return starting;
        let skipped = false;
        starting = (async () => {
          vault = browserStorage ? { storage: browserStorage.storage, state: browserStorage.state, load: async () => {}, reset: browserStorage.reset } : createCredentialStorage(lane());
          authKeys = createAuthKeyStore(lane());
          await Promise.all([vault.load(), authKeys.load()]);
          const module = await loadCorsRot();
          if (closed() || !selected()) { skipped = !closed(); return; }
          const platform = String(hostInfo?.platform ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
          const net = createCorsRotFor(module, vault.storage, `self-forming-${platform}`, authKeys.state.key);
          instance = net;
          stops.push(net.tailscale.subscribe((s) => { status = s; render(); poke(); }));
          stops.push(net.subscribe((s) => { startError = s?.tailscaleStartError ? text(s.tailscaleStartError) : ""; render(); poke(); }));
          net.warmUp(); // a failing start shows up in getStatus().tailscaleStartError
        })().catch((error) => { loadError = text(error?.message ?? error); instance = null; render(); poke(); })
          .finally(() => {
            starting = null;
            render();
            // Only reconcile a load skipped for deselection. A genuine loading/setup
            // error waits for an explicit retry/selection change, never a retry loop.
            if (skipped && !closed() && (selected())) return begin();
          });
        render();
        return starting;
      }
      function end() { render(); poke(); } // the node keeps running: stop() would log it out (only the Sign out button does)
      async function signOutNode() {
        const net = instance;
        if (!net) return;
        try { await net.tailscale.stop(); } catch { /* status shows it */ }
        startError = ""; status = net.tailscale.getStatus?.() ?? null;
        if (vault) await vault.reset();
        render(); poke();
        if (selected() && !closed()) { try { net.warmUp(); } catch { /* status shows it */ } }
      }
      async function saveAuthKey(value) {
        if (!authKeys) { authKeys = createAuthKeyStore(lane()); await authKeys.load(); }
        await authKeys.save(value);
        try { instance?.tailscale.setAuthKey(authKeys.state.key || undefined); } catch { /* next start only */ }
        render();
      }
      function sync() {
        if (closed()) return;
        const now = selected();
        if (now && !wasSelected) { wasSelected = true; begin(); }
        else if (!now && wasSelected) { wasSelected = false; end(); }
      }
      if (typeof subscribe === "function") { try { stops.push(subscribe(sync)); } catch { /* no live selection */ } }
      ctx.cleanup(() => {
        for (const stop of stops.splice(0)) { try { if (typeof stop === "function") stop(); } catch { /* ignore */ } }
        wasSelected = false;
        views.clear();
      });
      sync();

      ctx.contribute("settings.sections", SECTION_KEY, {
        title: NAME,
        slot: SLOT,
        mount(el) {
          const doc = el.ownerDocument ?? globalThis.document;
          const make = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
          const line = make("p", { className: "settings-note", id: "net-tailscale-status" });
          line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite");
          const login = make("a", { id: "net-tailscale-login", className: "quiet-button", textContent: "Open Tailscale sign-in", target: "_blank", rel: "noopener noreferrer" });
          const exitLabel = make("label", { className: "select-label" });
          const exitSelect = make("select", { id: "net-tailscale-exit" });
          exitLabel.append("Exit node", exitSelect);
          const signOut = make("button", { type: "button", className: "quiet-button", id: "net-tailscale-signout", textContent: "Sign out of Tailscale" });
          const note = make("p", { className: "settings-note", id: "net-tailscale-storage" });
          const keyLabel = make("label", { className: "select-label" });
          const keyInput = make("input", { id: "net-tailscale-authkey", type: "password", autocomplete: "off", placeholder: "Auth key (optional)" });
          keyInput.setAttribute("autocapitalize", "off"); keyInput.setAttribute("spellcheck", "false");
          keyLabel.append("Auth key", keyInput);
          const keySave = make("button", { type: "button", className: "quiet-button", id: "net-tailscale-authkey-save", textContent: "Save auth key" });
          const keyRemove = make("button", { type: "button", className: "quiet-button", id: "net-tailscale-authkey-remove", textContent: "Remove auth key" });
          const keyLine = make("p", { className: "settings-note", id: "net-tailscale-authkey-status" });
          keyLine.setAttribute("role", "status");
          keySave.addEventListener("click", async () => { const value = keyInput.value.trim(); if (!value) return; keyInput.value = ""; await saveAuthKey(value).catch(() => {}); });
          keyRemove.addEventListener("click", async () => { keyInput.value = ""; await saveAuthKey("").catch(() => {}); });
          exitSelect.addEventListener("change", () => { try { Promise.resolve(instance?.tailscale.setExitNode(exitSelect.value)).catch(() => {}); } catch { /* status shows it */ } });
          signOut.addEventListener("click", () => { signOutNode().catch(() => {}); });
          el.append(line, login, exitLabel, keyLabel, keySave, keyRemove, keyLine, signOut, note);
          const option = (value, label) => make("option", { value, textContent: label });
          const view = {
            update() {
              const s = status, running = Boolean(instance);
              line.textContent = describeTailscale({ started: running || Boolean(starting), loadError, status: s, startError });
              if (hostInfo?.platform === "browser") line.textContent = line.textContent.replaceAll("Requests use the default network until then.", "Requests fail until a selected network provider is ready.").replaceAll("Requests use the default network.", "Requests fail until a selected network provider is ready.");
              const url = running ? s?.loginURL : undefined;
              login.hidden = !(url && (s?.state === "NeedsLogin"));
              if (url) login.href = url; else login.removeAttribute?.("href");
              const nodes = running && s?.state === "Running" ? (s.exitNodes ?? []) : [];
              exitLabel.hidden = !nodes.length;
              exitSelect.replaceChildren(option("", "Choose…"), ...nodes.map((n) => option(n.id, `${text(n.name) || text(n.id)}${n.online ? "" : " (offline)"}`)));
              exitSelect.value = s?.selectedExitNode ?? "";
              signOut.hidden = !(running && s && (s.state === "Running" || s.state === "NeedsMachineAuth"));
              const have = Boolean(authKeys?.state.key);
              keyLine.textContent = have ? `Auth key saved (${authKeys.masked()}). Used at the next sign-in.${authKeys.state.persistent ? "" : " Kept only until the app closes."}` : "";
              keyLine.hidden = !keyLine.textContent;
              keyRemove.hidden = !have;
              const v = vault?.state;
              note.textContent = !running ? "" : browserStorage ? (v.lost ? "The Tailscale sign-in could not be saved or read in this browser; it is kept only until this page closes."
                : !v.persistent ? "No browser storage is available: the Tailscale sign-in is kept only until this page closes." : "") : !v?.persistent ? "No secure credential storage on this device: the Tailscale sign-in is kept only until the app closes."
                : v.lost ? "The Tailscale sign-in could not be saved or read securely; it is kept only until the app closes." : "";
              note.hidden = !note.textContent;
            }
          };
          views.add(view);
          view.update();
          return () => { views.delete(view); for (const node of [line, login, exitLabel, keyLabel, keySave, keyRemove, keyLine, signOut, note]) node.remove(); };
        }
      });
    }
  };
}

// cors-rot's timeoutMs: each setup stage, and within an HTTP exchange the longest time WITHOUT data
// (since cors-rot 08fcb29 it restarts on every chunk; before, it capped the whole exchange, so model
// replies streaming for over two minutes were cut off with "Tor HTTP request timed out", also on
// Tailscale). 10 minutes of silence leaves room for slow first bytes (very large prompts, long
// thinking without keep-alive events); the user's Stop still cancels at once. Tor's bootstrap keeps
// the library's 5 minutes.
export const EXCHANGE_TIMEOUT_MS = 10 * 60 * 1000;
export const BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
function createCorsRotFor(module, storage, hostname, authKey) {
  const tailscale = { storage, hostname };
  if (authKey) tailscale.authKey = authKey;
  return module.createCorsRot({ transport: "tailscale", tailscale, document: globalThis.document, timeoutMs: EXCHANGE_TIMEOUT_MS, tor: { bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS } });
}

/** Page-owned browser controller. Runtime scopes attach views/services, never own the node.
 * All methods are closures and safe when passed unbound. The page disposes this exactly once.
 */
export function createController(options = {}) {
  const abort = new AbortController(), cleanups = [], listeners = new Set(), selectionListeners = new Set();
  let active = false, service, section, disposing;
  const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  const selection = { choice: () => active ? ROUTE_ID : "unselected" };
  createImplementation({ ...options, selection,
    subscribe: listener => { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
    refresh: notify
  }).setup({ signal: abort.signal, cleanup: fn => cleanups.push(fn),
    provide: (_id, _version, value) => { service = value; },
    contribute: (_kind, _key, value) => { section = value; }
  });
  const controller = Object.freeze({
    id: ROUTE_ID, name: NAME, hint: HINT, service, section,
    setSelected(value) {
      if (abort.signal.aborted || active === Boolean(value)) return;
      active = Boolean(value);
      for (const listener of [...selectionListeners]) listener();
      notify();
    },
    subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
    attach(ctx, refresh) {
      ctx.provide(NET_SERVICE, 1, service);
      ctx.contribute("settings.sections", SECTION_KEY, section);
      const off = controller.subscribe(() => refresh?.());
      ctx.cleanup(off);
    },
    dispose() {
      if (disposing) return disposing;
      // Mark closed first so in-flight module loading cannot create a client after teardown.
      abort.abort();
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      listeners.clear(); selectionListeners.clear();
      disposing = Promise.resolve(service.transport.dispose());
      return disposing;
    }
  });
  return controller;
}

export function create({ controller, refresh, ...options } = {}) {
  if (!controller) return createImplementation({ ...options, refresh }); // Android's scope-owned behavior unchanged.
  return { name: NAME, hint: HINT, setup: ctx => controller.attach(ctx, refresh) };
}

/** Explicit browser persistence adapter; keeps cors-rot's EXISTING key names and best-effort
 * localStorage semantics. Never sends plugin:* records to the browser auth dispatcher.
 * Final page disposal freezes writes and leaves the client running (close is a server-side logout
 * upstream), preserving reload sign-in state. Only explicit sign-out logs out / removes route state.
 */
export function createBrowserStorage(storage) {
  let preserved = false;
  const state = { persistent: Boolean(storage?.getItem && storage?.setItem && storage?.removeItem), lost: false };
  const failed = () => { state.lost = true; state.persistent = false; };
  const owns = key => key.startsWith("self-forming.tailscale.state.") || key === "self-forming.tailscale.exit-node";
  const keys = () => { try { return Object.keys(storage ?? {}).filter(owns); } catch { failed(); return []; } };
  const methods = {
    getItem(key) { try { return storage?.getItem(key) ?? null; } catch { failed(); return null; } },
    setItem(key, value) { if (!preserved) { try { storage?.setItem(key, value); } catch { failed(); } } },
    removeItem(key) { if (!preserved) { try { storage?.removeItem(key); } catch { failed(); } } }
  };
  const adapter = new Proxy(methods, {
    ownKeys: () => [...new Set([...Reflect.ownKeys(methods), ...keys()])],
    getOwnPropertyDescriptor(target, key) {
      return Reflect.getOwnPropertyDescriptor(target, key) ?? (owns(String(key)) ? { enumerable: true, configurable: true } : undefined);
    }
  });
  return Object.freeze({ storage: adapter, state, preserve: () => { preserved = true; }, reset: async () => {
    for (const key of keys()) methods.removeItem(key);
  } });
}

export { mountBrowserNetwork, createNetworkDiagnostics } from './browser-network-ui.js';
