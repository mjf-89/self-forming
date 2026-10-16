// Browser route diagnostics. Tailscale is the browser default route owner; this
// view observes the supplied selected-network facade, never creates/selects a client.
export function mountBrowserNetwork(network, { anchor, document = anchor?.ownerDocument ?? globalThis.document } = {}) {
  if (!anchor || !network) return;
  let closed = false;
  const row = document.createElement("div");
  row.className = "mode-controls";
  const status = document.createElement("p");
  status.className = "settings-note"; status.setAttribute("role", "status");
  row.append(status); anchor.after(row);
  // B5 compatibility diagnostics only: selection and provider options are owned by
  // generic Settings → Providers and the route plugins, never a second selector here.
  const show = s => { if (!closed && s) status.textContent = s.status ?? ""; };
  // Where the time goes for Tor requests: reused connection or new one, connect and first byte.
  const timingNote = document.createElement("p");
  timingNote.className = "settings-note";
  timingNote.setAttribute("role", "status");
  row.append(timingNote);
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const showTiming = (s) => {
    if (closed) return;
    const t = s?.recentTorRequests?.[0];
    timingNote.textContent = t ? `Last Tor request: ${t.origin.replace(/^https?:\/\//, "")} · ${t.reused ? "reused connection" : `new connection ${seconds(t.connectMs)}`} · first byte after ${seconds(t.firstByteMs)}` : "";
  };
  // Last failed request with its real cause (chat errors often only say "Connection error.").
  const failureNote = document.createElement("p");
  failureNote.className = "settings-note";
  failureNote.setAttribute("role", "status");
  row.append(failureNote);
  const showFailure = (entry) => {
    if (closed) return;
    if (!entry) { failureNote.textContent = ""; return; }
    const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    failureNote.textContent = `Last failure ${time}: ${entry.where} — ${entry.message}`;
  };
  showFailure(network.recentFailures?.()[0]);
  const offFailure = network.onFailure?.(showFailure);
  let off;
  void network.getStatus().then((s) => { show(s); showTiming(s); }).catch(() => {});
  void Promise.resolve(network.subscribe?.((s) => { if (!closed) { show(s); showTiming(s); } })).then(stop => { if (closed) stop?.(); else off = stop; }).catch(() => {});
  return () => { closed = true; off?.(); offFailure?.(); row.remove(); };
}


// Bounded, sanitized transport diagnostics; no headers, bodies or credentials.
export function createNetworkDiagnostics() {
  const failures = [], listeners = new Set();
  return Object.freeze({
    report(request, error) {
      let where = 'request';
      try { const url = new URL(request.url); where = `${request.method ?? 'GET'} ${url.host}${url.pathname}`; } catch {}
      const entry = { at: Date.now(), where, message: String(error?.code ? `${error.code}: ${error.message}` : error?.message ?? error).slice(0, 300) };
      failures.unshift(entry); failures.length = Math.min(failures.length, 5);
      for (const listener of [...listeners]) { try { listener({ ...entry }); } catch {} }
    },
    recentFailures: () => failures.map(entry => ({ ...entry })),
    onFailure(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { listeners.clear(); failures.length = 0; }
  });
}
