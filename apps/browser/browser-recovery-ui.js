// Browser edition: fixed recovery notices (never taken from an app revision or plugin).
// browser-main.js mounts one small bar before app.js loads. CSS immunity: the host is a
// custom element <sf-recovery> attached to <html> (not <body>) with INLINE !important
// styles for every property that could hide it (inline !important beats any stylesheet
// !important, including `* { display: none !important }`); its content lives in a CLOSED
// shadow root with its own reset styles. While a bar is shown, <html> itself gets inline
// !important display/opacity/filter/transform/clip-path guards (restored afterwards), since
// an ancestor with display:none or opacity:0 would hide any descendant. If app code removes
// the host, it is put back. The bar has its own listeners: app errors cannot disable it.
//   - "The app didn't start properly — Recovery" when startup fails or the app has not
//     reported ready (app.ready) within STARTUP_READY_MS; it goes away once ready arrives;
//   - "App updated to revision … — Undo · Recovery" for a limited time after an app
//     revision was activated (until dismissed or UPDATE_BAR_MS, see browser-app-state.js).
// No animation (reduced motion is respected by having none).

export const STARTUP_READY_MS = 20_000;
// A start that is merely slow (first load, slow device or connection) first says so; only an actual
// failure, or still no ready signal after this long, says the app did not start properly.
export const STARTUP_FAILED_MS = 60_000;
export const NOTICE_ID = "sf-recovery-notice";
export const HOST_TAG = "sf-recovery";

const shortRevision = (id) => (typeof id === "string" && id.length > 10 ? id.slice(0, 10) : String(id ?? ""));

/**
 * Pure: what the bar shows. failed: { detail? } | null; update: { revision } | null.
 * Returns null (no bar) or { kind, text, detail?, actions: [{ id, label }] }.
 */
export function noticeModel({ failed = null, update = null, alert = null, undoing = false, error = null } = {}) {
  const actions = [];
  if (update) actions.push({ id: "undo", label: undoing ? "Undoing…" : "Undo", disabled: undoing });
  if (update && !failed && !error) actions.push({ id: "keep", label: "Keep" });
  actions.push({ id: "recovery", label: "Recovery" });
  actions.push({ id: "dismiss", label: "Dismiss" });
  if (error) return { kind: "error", text: `Could not undo the update: ${error}`, actions: actions.filter((a) => a.id !== "undo") };
  if (failed) return { kind: "startup", text: failed.slow ? "The app is taking a long time to start" : "The app didn't start properly", ...(failed.detail ? { detail: failed.detail } : {}), actions };
  if (update) return { kind: "update", text: `App updated to revision ${shortRevision(update.revision)}`, actions };
  if (alert) return { kind: "alert", text: String(alert.text).replace(/\.$/, ""), actions };
  return null;
}

const important = (rules) => Object.entries(rules).map(([k, v]) => `${k}: ${v} !important`).join("; ");
export const HOST_RULES = {
  all: "initial", display: "block", visibility: "visible", position: "fixed", inset: "auto 0 0 0", top: "auto", left: "0", right: "0", bottom: "0",
  "z-index": "2147483647", opacity: "1", transform: "none", filter: "none", "clip-path": "none", clip: "auto", mask: "none",
  "pointer-events": "auto", width: "100%", height: "auto", "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none",
  margin: "0", padding: "0", border: "0", overflow: "visible", zoom: "1", contain: "none", "content-visibility": "visible",
  "mix-blend-mode": "normal", isolation: "isolate", "box-sizing": "border-box", float: "none", translate: "none", scale: "none", rotate: "none",
};
// Guards on <html> while a bar is shown (an ancestor's display/opacity/filter/... hides descendants).
export const ROOT_GUARDS = { display: "block", opacity: "1", filter: "none", transform: "none", "clip-path": "none", mask: "none", "content-visibility": "visible", zoom: "1", translate: "none", scale: "none", rotate: "none" };
const HOST_STYLE = important(HOST_RULES);
// The same guards inside the shadow root: important :host rules win over outer important
// rules in the cascade, so they back up the inline style (no `all` here: it would reset them).
const HOST_GUARD = important(Object.fromEntries(Object.entries(HOST_RULES).filter(([k]) => k !== "all")));

// Neutral high-contrast colours, not the app's look: the bar is fixed host UI shared by every
// edition and must stay readable however the app has been restyled or repurposed.
const CSS = `
:host { ${HOST_GUARD} }
* { all: revert; }
.bar { box-sizing: border-box; pointer-events: auto; margin: 8px; margin-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 12px;
  background: #111111; color: #f2f2f2; border: 1px solid #f2f2f2; border-radius: 4px;
  font: 15px/1.4 "Courier New", "Liberation Mono", "Droid Sans Mono", monospace; text-align: left; }
.text { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
.detail { display: block; color: #b8b8b8; font-size: 13px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
a, button { box-sizing: border-box; display: inline-flex; align-items: center; min-height: 40px; padding: 0 12px;
  font: inherit; color: #ffffff; background: transparent; border: 1px solid #6b6b6b; border-radius: 4px;
  text-decoration: underline; cursor: pointer; }
button[disabled] { opacity: .6; cursor: default; }
a:focus-visible, button:focus-visible { outline: 2px solid #ffffff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/**
 * DOM side. document: the page document; recoveryUrl: absolute URL of recovery.html;
 * reload(): reloads the page (after Undo). Timers are injectable for tests.
 */
export function createRecoveryNotices({ document, recoveryUrl, reload = () => globalThis.location?.reload(), setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  MutationObserver: Observer = globalThis.MutationObserver } = {}) {
  const state = { failed: null, update: null, alert: null, undoing: false, error: null, hidden: false, ready: false };
  let host, root, readyTimer, updateTimer, observer, savedRoot;
  const html = () => document.documentElement ?? document.body;

  function guardRoot(on) {
    const element = html();
    if (!element?.style || element === document.body) return;
    if (on && !savedRoot) {
      savedRoot = Object.keys(ROOT_GUARDS).map((name) => [name, element.style.getPropertyValue?.(name) ?? "", element.style.getPropertyPriority?.(name) ?? ""]);
      for (const [name, value] of Object.entries(ROOT_GUARDS)) element.style.setProperty(name, value, "important");
    } else if (!on && savedRoot) {
      for (const [name, value, priority] of savedRoot) value ? element.style.setProperty(name, value, priority) : element.style.removeProperty(name);
      savedRoot = undefined;
    }
  }
  function mount() {
    if (!host) {
      host = document.createElement(HOST_TAG);
      host.id = NOTICE_ID;
      host.setAttribute("data-self-forming", "recovery");
      // Closed: page scripts cannot reach or restyle the content.
      root = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "closed" }) : host;
    }
    host.setAttribute("style", HOST_STYLE); // re-asserted on every render
    // Outside <body>: app code or CSS that hides or rewrites the body keeps this element.
    if (host.parentNode !== html()) html().append(host);
    guardRoot(true);
    if (!observer && typeof Observer === "function") {
      observer = new Observer(() => {
        if (!host) return;
        if (host.parentNode !== html()) html().append(host);
        if (host.getAttribute("style") !== HOST_STYLE) host.setAttribute("style", HOST_STYLE);
      });
      observer.observe(html(), { childList: true });
      observer.observe(host, { attributes: true, attributeFilter: ["style", "hidden", "class"] });
    }
  }
  function unmount() {
    observer?.disconnect(); observer = undefined;
    host?.remove(); host = root = undefined;
    guardRoot(false);
  }

  function render() {
    const model = state.hidden ? null : noticeModel(state);
    if (!model) { unmount(); return; }
    mount();
    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", model.kind === "update" ? "status" : "alert");
    bar.setAttribute("data-kind", model.kind);
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = `${model.text} —`;
    if (model.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = model.detail;
      text.append(detail);
    }
    const actions = document.createElement("span");
    actions.className = "actions";
    for (const action of model.actions) {
      let control;
      if (action.id === "recovery") {
        control = document.createElement("a");
        control.href = recoveryUrl;
        control.textContent = action.label;
      } else {
        control = document.createElement("button");
        control.type = "button";
        control.textContent = action.id === "dismiss" ? "×" : action.label;
        if (action.id === "dismiss") { control.setAttribute("aria-label", "Dismiss this notice"); control.setAttribute("title", "Dismiss"); }
        if (action.id === "undo") control.setAttribute("aria-label", "Undo the app update and reload");
        if (action.id === "keep") control.setAttribute("aria-label", "Keep this version");
        if (action.disabled) control.disabled = true;
        control.addEventListener("click", () => { void handlers[action.id]?.(); });
      }
      control.setAttribute("data-action", action.id);
      actions.append(control);
    }
    bar.append(text, actions);
    if (typeof root.replaceChildren === "function") root.replaceChildren(style, bar);
    else { root.textContent = ""; root.append(style, bar); }
  }

  const handlers = {
    async undo() {
      const update = state.update;
      if (!update || state.undoing) return;
      state.undoing = true; state.error = null; render();
      try {
        await update.undo();
        reload();
      } catch (cause) {
        state.undoing = false;
        state.error = cause instanceof Error ? cause.message : String(cause);
        render();
      }
    },
    async keep() {
      const update = state.update;
      state.update = null;
      clearTimer(updateTimer);
      render();
      try { await update?.keep?.(); } catch { /* probation expires anyway */ }
    },
    async dismiss() {
      const { update, alert } = state;
      state.hidden = true;
      clearTimer(updateTimer);
      render();
      try { await update?.dismiss?.(); } catch { /* the bar expires anyway */ }
      try { await alert?.dismiss?.(); } catch { /* expires anyway */ }
    },
  };

  return {
    /** Startup failed (exception or app.js did not load). */
    failed(detail) { clearTimer(readyTimer); state.failed = { detail: detail ? String(detail).slice(0, 300) : undefined }; state.hidden = false; render(); },
    /** Shows the startup banner unless ready() is called within `ms`. */
    expectReady(ms = STARTUP_READY_MS) {
      if (state.ready) return;
      clearTimer(readyTimer);
      readyTimer = setTimer(() => {
        if (state.ready || state.failed) return;
        state.failed = { slow: true }; state.hidden = false; render();
        readyTimer = setTimer(() => { if (!state.ready && state.failed?.slow) { state.failed = {}; state.hidden = false; render(); } }, Math.max(0, STARTUP_FAILED_MS - ms));
      }, ms);
    },
    /** The app reported ready: clears a pending or shown "didn't start" banner. */
    ready() {
      state.ready = true;
      clearTimer(readyTimer);
      if (state.failed) { state.failed = null; state.error = null; render(); }
    },
    /** { text, dismiss() }: one-time notice after an automatic rollback. */
    showAlert(alert) {
      if (!alert?.text) return;
      state.alert = alert; state.hidden = false; render();
    },
    /** { revision, remainingMs, undo(), keep(), dismiss() } */
    showUpdate(update) {
      if (!update?.revision) return;
      state.update = update; state.hidden = false; render();
      clearTimer(updateTimer);
      updateTimer = setTimer(() => { state.update = null; render(); }, Math.max(0, update.remainingMs ?? 0));
    },
    /** For tests/diagnostics. */
    current: () => (state.hidden ? null : noticeModel(state)),
    element: () => host,
    /** The closed shadow root (tests only; page scripts cannot reach it). */
    shadow: () => root,
    handlers,
  };
}
