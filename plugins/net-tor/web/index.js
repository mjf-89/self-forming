// net-tor: Tor over Snowflake, an optional net.fetch@1 provider over vendored cors-rot.
// Browser defaults to Tailscale; Android retains its native default. General runtime resolution
// uses only an available chosen/default provider, or fails clearly when neither is usable.
// Lazy activation follows intended choice/default, not the currently ready resolution. Page
// controllers survive composition detach; scope-owned Android instances retain their lifecycle.
// Deselection stops Tor and its Snowflake proxy; reselection restarts them. Explicit fetchTor
// requests remain independent of selection, without starting the unused Tailscale client/proxy.
// While selected, the hidden Snowflake proxy relays other people's encrypted Tor traffic
// (never websites). No credentials or traffic contents are logged.
const NET_SERVICE = "net.fetch";
export const ROUTE_ID = "net-tor";
export const SLOT = "provider:net.fetch@1";
export const SECTION_KEY = "net-tor-options";
const NAME = "Tor (Snowflake)";
const HINT = "slow to start, experimental; not anonymity; runs a Snowflake proxy";

const text = (value) => String(value ?? "").slice(0, 200);
const PHASES = { loading: "loading the Tor client", directory: "downloading the Tor directory", bridge: "downloading the Tor directory", circuit: "building a circuit" };

/** Plain sentences for the status line from a cors-rot network snapshot (or none = never started). */
export function describeTor({ started, loadError, snapshot }) {
  if (loadError) return `Tor could not start: ${loadError}`;
  if (!started || !snapshot) return "Tor is not running. It starts when you select it as the network provider.";
  switch (snapshot.torState) {
    case "ready": return "Connected to Tor.";
    case "error": return `Tor could not connect: ${text(snapshot.lastStartError) || "unknown error"}. Requests use the default network.`;
    case "blocked": return "Tor is blocked in this build. Requests use the default network.";
    case "initializing": {
      const progress = snapshot.progress, phase = PHASES[progress?.phase] ?? "starting";
      const count = progress?.total ? ` (${progress.done ?? 0}/${progress.total})` : "";
      return `Starting Tor: ${phase}${count}. The first start can take several minutes; requests use the default network meanwhile.`;
    }
    default: return "Starting Tor…";
  }
}

function createImplementation({ selection, subscribe, refresh, hostInfo, loadCorsRot = () => import("../../../cors-rot/index.js") } = {}) {
  return {
    name: NAME,
    hint: HINT,
    setup(ctx) {
      let instance = null, starting = null, loadError = "", snapshot = null, proxy = null;
      let wasSelected = false;
      const explicitDemands = new Set();
      const stops = [];
      const views = new Set();
      const closed = () => ctx.signal.aborted;
      // Activation follows choice/default, NOT the currently ready/fallback provider.
      const selected = () => {
        try { return (selection?.choice?.(NET_SERVICE, 1) ?? selection?.resolve?.(NET_SERVICE, 1)?.default) === ROUTE_ID; }
        catch { return false; }
      };
      const poke = () => { try { refresh?.(); } catch { /* the status line only */ } };
      const render = () => { for (const view of views) { try { view.update(); } catch { /* UI only */ } } };

      const available = () => Boolean(instance) && snapshot?.torState === "ready" && snapshot?.transport === "tor" && !closed();
      const describe = () => Object.freeze({
        id: ROUTE_ID, label: NAME, reaches: "any", private: false, persistent: false,
        ready: async () => available(), status: available() ? "ready" : "unavailable"
      });
      const service = Object.freeze(Object.assign((input, init) => {
        if (!available()) return Promise.reject(new Error("Tor is not connected"));
        return instance.fetch(input, init);
      }, { available, describe, transport: Object.freeze({
        version: 1,
        connect: (host, port, options) => available() ? instance.connect(host, port, options) : Promise.reject(new Error("Network route is not ready")),
        warmUp: async () => { begin(); await starting; return instance?.warmUp(); },
        preconnect: (url) => available() ? instance.preconnect(url) : Promise.resolve({ warmed: false, reason: "unavailable" }),
        getStatus: () => ({ ...(instance?.getStatus?.() ?? {}), loadError, ready: available(), proxy, ...loadError ? { torState: "error", lastStartError: loadError } : {} }),
        get tailscale() { return instance?.tailscale; },
        get snowflakeProxy() { return instance?.snowflakeProxy; },
        fetchTor,
        dispose: async () => { await instance?.dispose?.(); }
      }) }));
      ctx.provide(NET_SERVICE, 1, service);

      async function fetchTor(input, init) {
        const signals = [ctx.signal, init?.signal ?? input?.signal].filter(Boolean);
        for (const signal of signals) if (signal.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
        const demand = {};
        explicitDemands.add(demand);
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = event => {
            explicitDemands.delete(demand);
            reject(event.target.reason ?? new DOMException('Cancelled', 'AbortError'));
          };
          for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
        });
        try {
          return await Promise.race([cancelled, (async () => {
            begin(true);
            await starting;
            if (closed() || !explicitDemands.has(demand)) throw new DOMException('Cancelled', 'AbortError');
            if (!instance) throw new Error(loadError || 'Tor is unavailable');
            return instance.fetchTor(input, init);
          })()]);
        } finally {
          explicitDemands.delete(demand);
          for (const signal of signals) signal.removeEventListener('abort', abort);
        }
      }
      function begin(explicit = false) {
        loadError = "";
        if (instance && explicit && !selected()) return;
        if (instance) { // selected again: restart the give-back proxy and retry a failed start
          try { instance.setTransport("tor"); if (snapshot?.torState !== "ready") instance.warmUp(); } catch { /* status shows it */ }
          render();
          return;
        }
        if (starting) return starting;
        let skipped = false;
        starting = (async () => {
          const module = await loadCorsRot();
          if (closed() || (!selected() && !explicitDemands.size)) { skipped = !closed(); return; }
          const net = module.createCorsRot({ transport: selected() ? "tor" : "tailscale", tailscale: { storage: null }, document: globalThis.document, timeoutMs: EXCHANGE_TIMEOUT_MS, tor: { bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS } });
          instance = net;
          stops.push(net.subscribe((s) => { snapshot = s; render(); poke(); }));
          try { proxy = net.snowflakeProxy?.getStatus?.() ?? null; stops.push(net.snowflakeProxy?.subscribe?.((s) => { proxy = s; render(); poke(); })); } catch { /* optional */ }
          if (selected()) net.warmUp();
        })().catch((error) => { loadError = text(error?.message ?? error); instance = null; render(); poke(); })
          .finally(() => {
            starting = null;
            render();
            // Only reconcile a load skipped for deselection. A genuine loading/setup
            // error waits for an explicit retry/selection change, never a retry loop.
            if (skipped && !closed() && (selected() || explicitDemands.size)) return begin();
          });
        render();
        return starting;
      }
      function end() {
        // Leave the tor transport, then release the Tor client and the Snowflake proxy frame.
        try { instance?.setTransport("tailscale"); } catch { /* ignore */ }
        try { Promise.resolve(instance?.tor?.stop?.()).catch(() => {}); } catch { /* ignore */ }
        try { instance?.snowflakeProxy?.stop?.(); } catch { /* ignore */ }
        snapshot = null;
        render();
        poke();
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
        if (wasSelected) { wasSelected = false; end(); }
        views.clear();
      });
      sync();

      ctx.contribute("settings.sections", SECTION_KEY, {
        title: NAME,
        slot: SLOT,
        mount(el) {
          const doc = el.ownerDocument ?? globalThis.document;
          const make = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
          const status = make("p", { className: "settings-note", id: "net-tor-status" });
          status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
          const proxyLine = make("p", { className: "settings-note", id: "net-tor-proxy" });
          proxyLine.setAttribute("role", "status");
          const retry = make("button", { type: "button", className: "quiet-button", id: "net-tor-retry", textContent: "Retry Tor" });
          retry.addEventListener("click", () => { if (selected()) { wasSelected = true; begin(); } });
          el.append(status, proxyLine, retry);
          const view = {
            update() {
              status.textContent = describeTor({ started: Boolean(instance) || Boolean(starting), loadError, snapshot });
              if (hostInfo?.platform === "browser") status.textContent = status.textContent.replaceAll("Requests use the default network.", "Requests fail until a selected network provider is ready.").replaceAll("requests use the default network meanwhile.", "requests fail until a selected network provider is ready.");
              const running = Boolean(instance) && wasSelected;
              // Honest note, always present while Tor is the chosen route (and when it is not, what it would do).
              proxyLine.textContent = running
                ? `While Tor is selected this app also runs a Snowflake proxy that relays other people's encrypted Tor traffic (never websites)${proxy?.state && proxy.state !== "stopped" ? ` · proxy: ${proxy.state}${proxy.helped ? `, helped ${proxy.helped}` : ""}` : ""}. It stops when you pick another network.`
                : "Selecting Tor also starts a Snowflake proxy that relays other people's encrypted Tor traffic (never websites); it stops again when you pick another network.";
              retry.hidden = !(selected() && (loadError || snapshot?.torState === "error"));
            }
          };
          views.add(view);
          view.update();
          return () => { views.delete(view); status.remove(); proxyLine.remove(); retry.remove(); };
        }
      });
    }
  };
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

// cors-rot's timeoutMs: each setup stage, and within an HTTP exchange the longest time WITHOUT data
// (since cors-rot 08fcb29 it restarts on every chunk; before, it capped the whole exchange, so model
// replies streaming for over two minutes were cut off with "Tor HTTP request timed out", also on
// Tailscale). 10 minutes of silence leaves room for slow first bytes (very large prompts, long
// thinking without keep-alive events); the user's Stop still cancels at once. Tor's bootstrap keeps
// the library's 5 minutes.
const EXCHANGE_TIMEOUT_MS = 10 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
export function create({ controller, refresh, ...options } = {}) {
  if (!controller) return createImplementation({ ...options, refresh }); // Android's scope-owned behavior unchanged.
  return { name: NAME, hint: HINT, setup: ctx => controller.attach(ctx, refresh) };
}

// Browser slots are supplied by page composition; these renderers create no client.
export { mountTorProgress } from './browser-progress.js';
export { mountSnowflakeSettings } from './browser-snowflake.js';
