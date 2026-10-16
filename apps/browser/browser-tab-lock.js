// Fixed browser host module: ONE app tab owns this browser's Self Forming storage at a time.
//
// Why: each app tab loads the files and conversations into memory and saves them back to IndexedDB
// in batches; two tabs would overwrite each other's saves (last writer wins), and both would run a
// Linux VM, Tor/Tailscale clients and agent sessions on the same conversation files.
//
// How (Web Locks, lock name below):
// - The lock is held while the page is alive and RELEASED when the page is hidden for navigation
//   into the back/forward cache (pagehide with persisted): Safari can keep a page you left alive
//   there, and a held lock would make the next load wrongly report "open in another tab". A page
//   restored from that cache (pageshow with persisted) takes the lock again, or, if another tab
//   took it meanwhile, reports that through onLost.
// - A pending (waiting) request is aborted on pagehide, so a cached page can never be granted it.
// - steal() takes the lock over from another tab (the user's explicit choice); that tab's lock
//   request then rejects with AbortError and it gets onLost, so the two never write together.
// No imports; used by browser-main.js (the app) and browser-recovery.js (the recovery page).
export const HOST_LOCK = "self-forming-browser-host";

/**
 * createTabLock({ locks, name, win, onLost }) → { acquire({ wait }), steal(), release(), held }
 * - acquire({ wait: false }) resolves true when the lock was free and is now held, else false.
 * - acquire({ wait: true }) resolves true once held (waits for other holders); false if aborted.
 * - steal() resolves true once held, taking it from any other holder.
 * - onLost(reason) is called once when a held lock is taken by another tab ("stolen") or a page
 *   restored from the back/forward cache cannot take it back ("taken").
 * - onRestored() is called when a page that did NOT hold the lock (e.g. it was waiting) is restored
 *   from the back/forward cache; its waiting request was aborted on pagehide, so it should start over.
 */
export function createTabLock({ locks, name = HOST_LOCK, win = globalThis, onLost = () => {}, onRestored = () => {} } = {}) {
  let releaseHeld = null;        // resolves the promise that keeps the lock
  let pending = null;            // AbortController of a waiting request
  let heldBeforeHide = false;    // the page held the lock when it entered the back/forward cache
  let lost = false;
  const isHeld = () => releaseHeld !== null;

  function request(options) {
    return new Promise((resolve) => {
      let granted = false;
      locks.request(name, options, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        granted = true;
        resolve(true);
        return new Promise((done) => { releaseHeld = () => { releaseHeld = null; done(); }; });
      }).catch((error) => {
        if (granted) {                                   // a held lock was stolen by another tab
          releaseHeld = null;
          if (!lost) { lost = true; try { onLost("stolen", error); } catch { /* reporting only */ } }
        }
        resolve(false);                                  // aborted while waiting, or not granted
      });
    });
  }

  async function acquire({ wait = false } = {}) {
    if (isHeld()) return true;
    lost = false;
    if (!wait) return request({ ifAvailable: true });
    pending?.abort();
    pending = new AbortController();
    const signal = pending.signal;
    const ok = await request({ signal });
    if (pending?.signal === signal) pending = null;
    return ok;
  }
  async function steal() {
    if (isHeld()) return true;
    lost = false;
    pending?.abort(); pending = null;
    return request({ steal: true });
  }
  function release() { pending?.abort(); pending = null; releaseHeld?.(); }

  win?.addEventListener?.("pagehide", (event) => {
    // Entering the back/forward cache: let other loads have the lock; a waiting request must not be granted later.
    if (!event?.persisted) return;
    heldBeforeHide = isHeld();
    pending?.abort(); pending = null;
    releaseHeld?.();
  });
  win?.addEventListener?.("pageshow", (event) => {
    if (!event?.persisted || isHeld()) return;
    if (!heldBeforeHide) { try { onRestored(); } catch { /* reporting only */ } return; }
    heldBeforeHide = false;
    void request({ ifAvailable: true }).then((ok) => {
      if (!ok && !lost) { lost = true; try { onLost("taken"); } catch { /* reporting only */ } }
    });
  });

  return Object.freeze({ acquire, steal, release, get held() { return isHeld(); } });
}
