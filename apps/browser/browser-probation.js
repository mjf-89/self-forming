// Browser edition: probation of a newly activated app revision (fixed code).
//
// A revision can start, report ready, and still freeze the page later (an endless loop in
// a click handler). Nothing on a stuck page runs, so detection happens from outside:
//  1. Heartbeats. While a revision is on probation (browser-app-state.js: after
//     app.activate, until "Keep" or 10 minutes) the fixed bootstrap writes a heartbeat
//     { loadId, revision, at, visible, clean } to localStorage every HEARTBEAT_MS (and on
//     visibility changes); pagehide marks it clean. On the NEXT load, a last run of the
//     same revision that was visible and did not unload cleanly is a failed run, and the
//     revision is rolled back (lastRunFailed).
//  2. The service worker (sw.js) receives the same heartbeats. When a VISIBLE controlled
//     window of a probation revision has been silent for STUCK_MS, it rolls back and
//     navigates that window to recovery.html?reason=unresponsive. A renderer that is
//     completely hung may only navigate after the browser intervenes ("page unresponsive");
//     then path 1 catches it on the next load.
//  3. Meaningful readiness: whenResponsive() is awaited before app.ready ends the startup
//     retry window (composer mounted, two animation frames and an idle callback ran).

export const HEARTBEAT_KEY = "self-forming-probation-heartbeat";
export const HEARTBEAT_MS = 3_000;
export const STUCK_MS = 20_000;
export const COMPOSER = "#prompt:not([disabled])";
export const COMPOSER_WAIT_MS = 15_000;

export function readHeartbeat(storage) {
  try {
    const record = JSON.parse(storage?.getItem(HEARTBEAT_KEY) ?? "null");
    return record && typeof record.revision === "string" ? record : null;
  } catch { return null; }
}

/** Pure: did the previous page load of the revision on probation get stuck? */
export function lastRunFailed(record, state, { loadId } = {}) {
  const probation = state?.probation;
  return Boolean(record && probation && record.revision === probation.revision && state.active === record.revision &&
    record.loadId !== loadId && record.visible === true && record.clean !== true &&
    !(record.at > probation.until) && record.at > (probation.since ?? 0));
}

/**
 * Starts heartbeats for this page. Returns { beat(), stop() }. Everything is injectable for tests.
 * worker(): the service worker to tell (navigator.serviceWorker.controller), may be null.
 */
export function startHeartbeat({ storage, revision, until, loadId, document, worker = () => null, now = Date.now,
  setTimer = globalThis.setInterval, clearTimer = globalThis.clearInterval, target = globalThis } = {}) {
  let stopped = false;
  const visible = () => document?.visibilityState === "visible";
  const write = (clean) => {
    const record = { loadId, revision, at: now(), visible: visible(), clean };
    try { storage?.setItem(HEARTBEAT_KEY, JSON.stringify(record)); } catch { /* storage full: SW path still works */ }
    try { worker()?.postMessage(clean ? { type: "probation-end", revision, loadId } : { type: "probation-heartbeat", revision, loadId, visible: record.visible }); } catch { /* no worker */ }
    return record;
  };
  const beat = () => {
    if (stopped) return null;
    if (until && now() >= until) { stop(); return null; }
    return write(false);
  };
  const timer = setTimer(beat, HEARTBEAT_MS);
  timer?.unref?.(); // Node (tests): never keeps the process alive
  const onVisibility = () => beat();
  const onHide = () => { if (!stopped) write(true); };
  const onShow = (event) => { if (event?.persisted) beat(); };
  document?.addEventListener?.("visibilitychange", onVisibility);
  target?.addEventListener?.("pagehide", onHide);
  target?.addEventListener?.("pageshow", onShow);
  function stop() {
    if (stopped) return;
    write(true);
    stopped = true;
    clearTimer(timer);
    document?.removeEventListener?.("visibilitychange", onVisibility);
    target?.removeEventListener?.("pagehide", onHide);
    target?.removeEventListener?.("pageshow", onShow);
  }
  beat();
  return { beat, stop, stopped: () => stopped };
}

/**
 * Resolves once the page is demonstrably responsive: the chat composer is mounted (or
 * COMPOSER_WAIT_MS passed, for an app that no longer has it), then two animation frames
 * and an idle callback ran. Hidden pages get no animation frames: short timers stand in.
 */
export async function whenResponsive({ document = globalThis.document, win = globalThis, selector = COMPOSER, waitMs = COMPOSER_WAIT_MS } = {}) {
  if (typeof document?.querySelector !== "function") return { composer: false }; // no page (tests, workers)
  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
  const started = Date.now();
  let composer = false;
  while (!(composer = Boolean(document?.querySelector?.(selector))) && Date.now() - started < waitMs) await sleep(100);
  const frame = () => new Promise((resolve) => {
    const fallback = win.setTimeout(resolve, document?.visibilityState === "hidden" ? 50 : 1000);
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(() => { win.clearTimeout(fallback); resolve(); });
  });
  await frame();
  await frame();
  await new Promise((resolve) => (typeof win.requestIdleCallback === "function" ? win.requestIdleCallback(() => resolve(), { timeout: 2000 }) : win.setTimeout(resolve, 0)));
  return { composer };
}
