// Startup progress above the message box: visible only while Tor starts (or after a failed start).
const PHASES = {
  loading: "starting",
  directory: "downloading the network directory over Tor (first start can take a minute or two)",
  bridge: "downloading the network directory over Tor (first start can take a minute or two)",
  circuit: "connecting",
};
// Styles live here, not in app.css: edited app revisions carry their own copy of app.css, and this
// browser-only module must look right under any of them. Uses the app's colour tokens.
const TOR_PROGRESS_CSS = `
.tor-progress p { margin: 0 0 4px; color: var(--muted); font: 13px/1.4 var(--mono, monospace); }
.tor-progress-bar { position: relative; height: 1px; overflow: hidden; background: var(--border); }
.tor-progress-bar span { position: absolute; inset: 0 auto 0 0; width: 30%; background: var(--accent); }
.tor-progress:not(.is-determinate) .tor-progress-bar span { animation: tor-progress-slide 1.6s linear infinite; }
.tor-progress.is-determinate .tor-progress-bar span { transition: width 0.3s; }
.tor-progress.is-floating { position: fixed; left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom, 0px) + 96px); z-index: 50; padding: 8px 12px; background: var(--paper, #f6f6f3); border: 1px solid var(--border, #bdbdb6); border-radius: 4px; }
@keyframes tor-progress-slide { from { left: -30%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .tor-progress-bar span { animation: none !important; transition: none !important; } }`;

export function mountTorProgress(network, { anchor, floating, document = anchor?.ownerDocument ?? floating?.ownerDocument ?? globalThis.document } = {}) {
  if (!network || (!anchor && !floating)) return;
  // Above the message box when the page has the usual notices area; edited app versions may
  // not, so fall back to a fixed line at the bottom of the screen.
  const style = document.createElement("style");
  style.textContent = TOR_PROGRESS_CSS;
  document.head.append(style);
  const box = document.createElement("div");
  box.className = "tor-progress";
  box.hidden = true;
  const text = document.createElement("p");
  text.setAttribute("role", "status"); text.setAttribute("aria-live", "polite"); text.setAttribute("data-text", "");
  const track = document.createElement("div");
  track.className = "tor-progress-bar"; track.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span"); bar.setAttribute("data-bar", "");
  track.append(bar); box.append(text, track);
  if (anchor) anchor.prepend(box);
  else { box.classList.add("is-floating"); floating.append(box); }
  let last = null;
  let errorUntil = 0;
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const render = () => {
    const s = last;
    if (s?.progress) {
      const p = s.progress;
      const count = p.phase === "bridge" && p.total ? ` · ${p.done}/${p.total}` : "";
      text.textContent = `Tor · ${PHASES[p.phase] ?? "starting"}${count} · ${clock(Date.now() - p.since)}`;
      box.classList.toggle("is-determinate", p.phase === "bridge" && p.total > 0);
      bar.style.width = p.phase === "bridge" && p.total ? `${Math.round((p.done / p.total) * 100)}%` : "";
      box.hidden = false;
    } else if (s?.torState === "error" && Date.now() < errorUntil) {
      text.textContent = `Tor could not start (${s.lastStartError ?? "unknown error"}). It will retry on the next request.`;
      box.classList.remove("is-determinate");
      bar.style.width = "";
      box.hidden = false;
    } else if (s?.torState === "ready" && Date.now() < readyUntil) {
      text.textContent = `Tor connected in ${clock(s.lastStartMs)}.`;
      box.classList.add("is-determinate");
      bar.style.width = "100%";
      box.hidden = false;
    } else box.hidden = true;
  };
  let readyUntil = 0;
  const show = (s) => {
    if (closed) return;
    if (s?.torState === "error" && last?.torState !== "error") errorUntil = Date.now() + 15000;
    if (s?.torState === "ready" && last?.torState === "initializing" && s.lastStartMs != null) readyUntil = Date.now() + 8000;
    last = s;
    render();
  };
  const timer = setInterval(() => { if (!box.hidden || Date.now() < readyUntil) render(); }, 1000);
  let closed = false, off;
  void network.getStatus().then(show).catch(() => {});
  void Promise.resolve(network.subscribe?.(s => { if (!closed) show(s); })).then(stop => { if (closed) stop?.(); else off = stop; }).catch(() => {});
  return () => { closed = true; clearInterval(timer); off?.(); box.remove(); style.remove(); };
}
