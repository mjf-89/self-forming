// App-only Settings row for the Snowflake give-back proxy. The proxy itself (the hidden frame and
// its lifecycle) lives in the cors-rot library (libs/cors-rot/snowflake.js) and is created by
// createCorsRot(); this module only renders its status under Settings → Network. The row is shown
// only while Tor is the selected route (and so the proxy is running).
const STATES = {
  stopped: "not started",
  starting: "starting",
  running: "on",
  paused: "paused",
  unavailable: "unavailable",
};

const CSS = `
.snowflake-proxy p { margin: 0; }`;

export function mountSnowflakeSettings(proxy, { anchor, document = anchor?.ownerDocument ?? globalThis.document } = {}) {
  if (!proxy || !document) return;
  if (!anchor) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const row = document.createElement("div");
  row.className = "mode-controls snowflake-proxy";
  const text = document.createElement("p");
  text.className = "settings-note"; text.setAttribute("role", "status"); text.setAttribute("data-snowflake-status", "");
  row.append(text);
  anchor.after(row);
  const megabytes = (n) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  let closed = false, off;
  const show = (s) => {
    if (closed) return;
    row.hidden = !s.active; // only shown while Tor (and so the proxy) is in use
    const people = s.helped === 1 ? "1 person helped" : `${s.helped} people helped`;
    let line;
    if (s.state === "unavailable") line = `Helping others reach Tor: unavailable (${s.reason}).`;
    else line = `Helping others reach Tor (Snowflake proxy): ${STATES[s.state] ?? s.state}${s.clients ? ` · ${s.clients} connected now` : ""} · ${people} · ${megabytes(s.bytes)} relayed.`;
    text.textContent = line;
  };
  void Promise.resolve(proxy.subscribe(show)).then(stop => { if (closed) stop?.(); else off = stop; }).catch(() => {});
  return () => { closed = true; off?.(); row.remove(); style.remove(); };
}
