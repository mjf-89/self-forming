// Start-up script for the vendored Snowflake proxy core inside snowflake-proxy.html (replaces the
// upstream badge UI). Talks to the parent page only through postMessage (same origin):
//   parent -> frame: { type: "snowflake-proxy-control", action: "start" | "pause" }
//   frame -> parent: { type: "snowflake-proxy-status", state, clients, helped, bytes, natType, reason }
// The proxy relays encrypted Tor traffic between a censored user's WebRTC connection and the
// Snowflake bridge's WebSocket. It never connects to websites.
/* global Config, Broker, Snowflake, UI, Util, WS */
/* exported debug, snowflake, log, dbg */
var debug = false;
var snowflake = null;
var log = (message) => { if (debug) console.log("Snowflake proxy: " + message); };
var dbg = () => {};

(function () {
  const RETRY_UNREACHABLE_MS = 10 * 60 * 1000;
  let state = "stopped";       // stopped | starting | running | paused | unavailable
  let reason = "";
  let helped = 0;              // clients served since the frame started
  let bytes = 0;               // data relayed (sent + received on the WebRTC side)
  const lastBytes = new WeakMap();
  let retryTimer;

  class TabUI extends UI {
    constructor() { super(); this.natType = "unknown"; }
    setStatus() {}
    postActive() { post(); }
    increaseClients() { helped += 1; return super.increaseClients(); }
  }

  const config = new Config("badge");
  const ui = new TabUI();
  const broker = new Broker(config);
  snowflake = new Snowflake(config, ui, broker);

  function post() {
    try {
      parent.postMessage({ type: "snowflake-proxy-status", state, reason, clients: ui.clients, helped, bytes, natType: ui.natType }, location.origin);
    } catch { /* parent gone */ }
  }

  // Data relayed: sample the WebRTC transport counters of the open connections.
  setInterval(async () => {
    for (const pair of snowflake.proxyPairs) {
      try {
        const report = await pair.pc?.getStats();
        if (!report) continue;
        for (const stat of report.values()) {
          if (stat.type !== "transport") continue;
          const total = (stat.bytesReceived || 0) + (stat.bytesSent || 0);
          bytes += Math.max(0, total - (lastBytes.get(pair) || 0));
          lastBytes.set(pair, total);
          break;
        }
      } catch { /* connection closed meanwhile */ }
    }
    if (state === "running") post();
  }, 10000);

  function start() {
    clearTimeout(retryTimer);
    if (state === "running" || state === "starting") return;
    if (!Util.hasWebRTC()) { state = "unavailable"; reason = "WebRTC is not available in this browser"; post(); return; }
    state = "starting"; reason = ""; post();
    Util.checkNATType(config.datachannelTimeout).then((type) => { ui.natType = type; post(); }).catch(() => {});
    WS.probeWebSocket(config.defaultRelayAddr).then(() => {
      if (state !== "starting") return; // paused meanwhile
      state = "running"; post();
      snowflake.beginServingClients();
    }, () => {
      if (state !== "starting") return;
      state = "unavailable"; reason = "the Snowflake bridge is unreachable"; post();
      retryTimer = setTimeout(() => { state = "stopped"; start(); }, RETRY_UNREACHABLE_MS);
    });
  }

  function pause() {
    clearTimeout(retryTimer);
    if (state === "running") snowflake.disable();
    state = "paused"; reason = ""; post();
  }

  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const message = event.data;
    if (message?.type !== "snowflake-proxy-control") return;
    if (message.action === "start") start();
    else if (message.action === "pause") pause();
  });
  addEventListener("pagehide", () => { try { snowflake.disable(); } catch { /* closing */ } });
  post();
})();
