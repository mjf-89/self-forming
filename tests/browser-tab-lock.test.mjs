// apps/browser/browser-tab-lock.js: one app tab owns the browser storage; the lock never stays with a page
// the browser keeps in its back/forward cache (the cause of false "open in another tab" in Safari), and a
// user can take it over, after which the other tab gets onLost. Fake Web Locks + fake window events.
import test from "node:test";
import assert from "node:assert/strict";
import { createTabLock, HOST_LOCK } from "../apps/browser/browser-tab-lock.js";

// Minimal LockManager for one lock name: exclusive, ifAvailable, signal (abort while waiting), steal.
function fakeLocks() {
  let holder = null; const queue = [];
  const grant = (entry) => {
    holder = entry;
    let held;
    try { held = Promise.resolve(entry.callback({ name: entry.name })); } catch (e) { held = Promise.reject(e); }
    held.then((v) => { if (holder === entry) { holder = null; next(); } entry.resolve(v); },
              (e) => { if (holder === entry) { holder = null; next(); } entry.reject(e); });
  };
  const next = () => { const e = queue.shift(); if (e) grant(e); };
  return {
    get held() { return holder !== null; },
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const entry = { name, callback, resolve, reject };
        if (options.steal) {
          const old = holder; holder = null;
          if (old) old.reject(Object.assign(new Error("stolen"), { name: "AbortError" }));
          queue.length = 0; grant(entry); return;
        }
        if (!holder) { grant(entry); return; }
        if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
        options.signal?.addEventListener("abort", () => { const i = queue.indexOf(entry); if (i >= 0) { queue.splice(i, 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); } });
        queue.push(entry);
      });
    }
  };
}
function fakeWindow() {
  const listeners = {};
  return { addEventListener: (t, f) => (listeners[t] ??= []).push(f), fire: (t, persisted) => (listeners[t] ?? []).forEach((f) => f({ persisted })) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("one tab holds the lock; a second load finds it taken", async () => {
  const locks = fakeLocks();
  const a = createTabLock({ locks, win: fakeWindow() });
  assert.equal(await a.acquire(), true); assert.equal(a.held, true);
  const b = createTabLock({ locks, win: fakeWindow() });
  assert.equal(await b.acquire(), false); assert.equal(b.held, false);
  assert.equal(HOST_LOCK, "self-forming-browser-host", "permanent lock name");
});

test("a page kept in the back/forward cache releases the lock, so the next load is not blocked (Safari false positive)", async () => {
  const locks = fakeLocks(), winA = fakeWindow();
  const a = createTabLock({ locks, win: winA });
  await a.acquire();
  winA.fire("pagehide", true);            // navigated away; the browser keeps the page alive
  await tick();
  assert.equal(locks.held, false, "released");
  const b = createTabLock({ locks, win: fakeWindow() });
  assert.equal(await b.acquire(), true, "the new load gets the lock");
  // The cached page is restored while the new load owns the lock: it is told, it does not take it.
  let lost = null;
  const winC = fakeWindow();
  const c = createTabLock({ locks, win: winC, onLost: (why) => { lost = why; } });
  assert.equal(await c.acquire(), false);
  winA.fire("pageshow", true);
  await tick(); await tick();
  assert.equal(a.held, false);
  // A normal unload (persisted=false) is left to the browser, which releases locks of closed pages.
  winC.fire("pagehide", false);
  assert.equal(b.held, true);
});

test("a restored page takes its lock back when it is still free", async () => {
  const locks = fakeLocks(), win = fakeWindow();
  let lost = false;
  const a = createTabLock({ locks, win, onLost: () => { lost = true; } });
  await a.acquire();
  win.fire("pagehide", true); await tick();
  win.fire("pageshow", true); await tick(); await tick();
  assert.equal(a.held, true); assert.equal(lost, false);
});

test("take over: steal() gives this tab the lock and the other tab gets onLost('stolen') once", async () => {
  const locks = fakeLocks();
  const reasons = [];
  const a = createTabLock({ locks, win: fakeWindow(), onLost: (why) => reasons.push(why) });
  await a.acquire();
  const b = createTabLock({ locks, win: fakeWindow() });
  assert.equal(await b.acquire(), false);
  assert.equal(await b.steal(), true);
  await tick(); await tick();
  assert.equal(b.held, true); assert.equal(a.held, false);
  assert.deepEqual(reasons, ["stolen"]);
});

test("waiting (recovery page): granted when the app tab closes; aborted in the back/forward cache, then onRestored", async () => {
  const locks = fakeLocks();
  const app = createTabLock({ locks, win: fakeWindow() });
  await app.acquire();
  const winR = fakeWindow();
  let restored = 0;
  const recovery = createTabLock({ locks, win: winR, onRestored: () => restored++ });
  const waiting = recovery.acquire({ wait: true });
  winR.fire("pagehide", true);             // left while waiting: the request must not be granted later
  assert.equal(await waiting, false);
  app.release(); await tick();
  assert.equal(recovery.held, false, "an aborted wait is never granted");
  assert.equal(locks.held, false);
  winR.fire("pageshow", true);
  assert.equal(restored, 1, "a restored waiting page starts over");
  const again = createTabLock({ locks, win: fakeWindow() });
  const w2 = again.acquire({ wait: true });
  assert.equal(await w2, true, "a fresh wait is granted when free");
});
