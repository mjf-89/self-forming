// cors-rot Snowflake proxy manager ("give back"): while the selected transport is 'tor', a Snowflake
// proxy runs in a hidden frame (snowflake-proxy.html) and relays encrypted Tor traffic for people in
// censored countries. It starts when 'tor' is selected and stops when 'tailscale' is selected. There
// is no off switch. It never connects to websites. The host app renders the status; this module only
// manages the frame. stop() removes the frame (closing its WebRTC/WebSocket connections and timers; the
// proxy stays down until Tor is switched away from and back, or a new Tor start begins); dispose() also detaches the manager from the
// network and the window for good. See createCorsRot() in ./index.js, which wires it to the network's status.
//
// NOTE (Snowflake infrastructure): the Snowflake project asks that applications not share its
// public infrastructure between different kinds of applications. Deployments should run their own
// bridge/proxies. See the library README for links.
const OLD_OFF_KEY = "self-forming.browser.snowflake-proxy"; // from an earlier version that had a switch

export function createSnowflakeProxy({ network, document = globalThis.document } = {}) {
  const listeners = new Set();
  let status = { state: "stopped", clients: 0, helped: 0, bytes: 0 };
  let active = false;
  let disposed = false;
  let held = false; // after stop(): stay down until Tor is switched away from, or a new Tor start begins
  const wantsRun = (s) => {
    const tor = s?.mode === "tor" || s?.transport === "tor";
    if (!tor || s?.torState === "initializing") held = false;
    return tor && !held;
  };
  try { globalThis.localStorage?.removeItem(OLD_OFF_KEY); } catch { /* storage unavailable */ }

  const view = () => ({ ...status, active });
  const notify = () => { for (const listener of listeners) { try { listener(view()); } catch { /* UI only */ } } };

  // Without a document (e.g. unit tests / non-DOM hosts) the manager is inert but still tracks state.
  if (!document?.createElement) {
    const follow = (s) => { if (disposed) return; const shouldRun = wantsRun(s); if (shouldRun !== active) { active = shouldRun; notify(); } };
    void network?.getStatus?.().then?.(follow)?.catch?.(() => {});
    let unfollow;
    try { unfollow = network?.subscribe?.(follow); } catch { /* ignore */ }
    const halt = () => { if (active) { active = false; status = { ...status, state: "stopped", clients: 0 }; notify(); } };
    return {
      getStatus: view,
      subscribe(listener) { listeners.add(listener); listener(view()); return () => listeners.delete(listener); },
      stop() { held = true; halt(); },
      dispose() { halt(); try { unfollow?.(); } catch { /* ignore */ } disposed = true; listeners.clear(); },
    };
  }

  let frame;
  let frameReady = false;
  const origin = globalThis.location?.origin;

  // Runs only while Tor is the selected transport: give back to the network the app is using.
  function start() {
    if (frame) return;
    frameReady = false;
    frame = document.createElement("iframe");
    frame.src = new URL("./snowflake-proxy.html", import.meta.url).href;
    frame.title = "Snowflake proxy";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "display:none;width:0;height:0;border:0";
    document.body.append(frame);
  }
  // Removing the frame closes its WebRTC and WebSocket connections.
  function stop() {
    if (!frame) return;
    try { frame.contentWindow?.postMessage({ type: "snowflake-proxy-control", action: "pause" }, origin); } catch { /* gone */ }
    frame.remove();
    frame = undefined;
    frameReady = false;
    status = { ...status, state: "stopped", clients: 0 };
    notify();
  }

  const onMessage = (event) => {
    if (!frame || event.origin !== origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== "snowflake-proxy-status") return;
    const first = !frameReady;
    frameReady = true;
    // Counters continue across Tor sessions within this page.
    status = { ...event.data };
    if (first) frame.contentWindow?.postMessage({ type: "snowflake-proxy-control", action: "start" }, origin);
    notify();
  };
  addEventListener("message", onMessage);

  const follow = (s) => {
    if (disposed) return;
    const shouldRun = wantsRun(s);
    if (shouldRun === active) return;
    active = shouldRun;
    if (active) start(); else stop();
    notify();
  };
  void network?.getStatus?.().then?.(follow)?.catch?.(() => {});
  let unfollow;
  try { unfollow = network?.subscribe?.(follow); } catch { /* ignore */ }

  return {
    getStatus: view,
    subscribe(listener) { listeners.add(listener); listener(view()); return () => listeners.delete(listener); },
    /** Removes the proxy frame now. It stays down until Tor is switched away from and back, or a new Tor start begins (new frame). */
    stop() { held = true; active = false; stop(); notify(); },
    /** stop() for good: also detaches from the network and the window and drops the listeners. */
    dispose() {
      disposed = true; active = false; stop();
      try { unfollow?.(); } catch { /* ignore */ }
      try { removeEventListener("message", onMessage); } catch { /* ignore */ }
      notify(); listeners.clear();
    },
  };
}
