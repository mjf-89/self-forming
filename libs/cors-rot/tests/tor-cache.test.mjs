// IndexedDB cache of the authenticated Tor directory (../tor-cache.js).
import test from "node:test";
import assert from "node:assert/strict";
import { loadTorDirectory, saveTorDirectory } from "../tor-cache.js";

// Minimal async IndexedDB stand-in (stores values by reference, like IDB stores Blobs).
function fakeIndexedDb() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (fn) => { const r = {}; later(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  return {
    open(name) {
      const r = {};
      later(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = { stores: new Map() }; databases.set(name, db); }
        r.result = {
          createObjectStore: (store) => db.stores.set(store, new Map()),
          transaction() {
            const tx = { objectStore: (store) => { const map = db.stores.get(store); return { get: (k) => request(() => map.get(k)), put: (v, k) => request(() => { map.set(k, v); }) }; } };
            later(() => later(() => tx.oncomplete?.()));
            return tx;
          },
          close() {},
        };
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}

const directory = (validAfter, validUntil) => ({
  consensus: "network-status-version 3 microdesc\n" + "r relay ".repeat(5000),
  microdescriptors: "onion-key\n".repeat(20000),
  certificates: "dir-key-certificate-version 3\n",
  validAfter, freshUntil: validAfter, validUntil,
});

test("round trip: saved directory comes back identical while valid (gzip in storage)", async () => {
  const indexedDB = fakeIndexedDb();
  const d = directory("2026-10-13T10:00:00Z", "2026-10-13T13:00:00Z");
  assert.equal(await saveTorDirectory(d, { indexedDB }), true);
  const loaded = await loadTorDirectory({ indexedDB, nowMs: Date.parse("2026-10-13T12:00:00Z") });
  for (const k of ["consensus", "microdescriptors", "certificates", "validAfter", "validUntil"]) assert.equal(loaded[k], d[k]);
});

test("expired, not-yet-valid, missing or damaged entries are ignored, never thrown", async () => {
  const indexedDB = fakeIndexedDb();
  assert.equal(await loadTorDirectory({ indexedDB }), undefined, "empty cache");
  await saveTorDirectory(directory("2026-10-13T10:00:00Z", "2026-10-13T13:00:00Z"), { indexedDB });
  assert.equal(await loadTorDirectory({ indexedDB, nowMs: Date.parse("2026-10-13T13:00:00Z") }), undefined, "expired at validUntil");
  assert.equal(await loadTorDirectory({ indexedDB, nowMs: Date.parse("2026-10-13T09:59:59Z") }), undefined, "not yet valid");
  assert.equal(await saveTorDirectory({ ...directory("x", "y") }, { indexedDB }), false, "bad timestamps refused");
  assert.equal(await saveTorDirectory({ ...directory("2026-10-13T10:00:00Z", "2026-10-13T13:00:00Z"), consensus: "" }, { indexedDB }), false);
  assert.equal(await loadTorDirectory({ indexedDB: undefined }), undefined, "no IndexedDB");
  const broken = { open() { throw new Error("blocked"); } };
  assert.equal(await loadTorDirectory({ indexedDB: broken }), undefined);
  assert.equal(await saveTorDirectory(directory("2026-10-13T10:00:00Z", "2026-10-13T13:00:00Z"), { indexedDB: broken }), false);
});
