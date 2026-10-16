// IndexedDB cache for the Tor directory the in-page client downloaded and AUTHENTICATED
// (consensus + microdescriptors + authority certificates). Passed back as a seed on the next
// start so bootstrap takes seconds instead of a full download. The WASM client re-verifies
// every seed (5-of-9 pinned authority signatures, validity window, full descriptor coverage),
// so this cache is a speed-up, never a trust anchor: a damaged or stale entry is just ignored.
const DB = "self-forming-tor";
const STORE = "directory";
const KEY = "current";
const MAX_TEXT = 48 * 1024 * 1024;

function open(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function gzip(text) {
  if (typeof CompressionStream !== "function") return { encoding: "identity", data: text };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return { encoding: "gzip", data: await new Response(stream).blob() };
}

async function gunzip(entry) {
  if (entry?.encoding === "identity" && typeof entry.data === "string") return entry.data;
  if (entry?.encoding !== "gzip" || !(entry.data instanceof Blob) || typeof DecompressionStream !== "function") return undefined;
  return new Response(entry.data.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

const fields = ["consensus", "microdescriptors", "certificates"];

/** Returns a cached directory that is still inside its signed validity window, or undefined. */
export async function loadTorDirectory({ indexedDB = globalThis.indexedDB, nowMs = Date.now() } = {}) {
  if (!indexedDB) return undefined;
  try {
    const db = await open(indexedDB);
    try {
      const record = await run(db, "readonly", (store) => store.get(KEY));
      const validAfter = Date.parse(record?.validAfter), validUntil = Date.parse(record?.validUntil);
      if (!(validAfter <= nowMs && nowMs < validUntil)) return undefined;
      const out = { validAfter: record.validAfter, freshUntil: record.freshUntil, validUntil: record.validUntil };
      for (const name of fields) {
        const text = await gunzip(record[name]);
        if (typeof text !== "string" || !text.length || text.length > MAX_TEXT) return undefined;
        out[name] = text;
      }
      return out;
    } finally { db.close(); }
  } catch { return undefined; }
}

/** Stores an exported directory (strings + ISO timestamps). Returns true when saved. */
export async function saveTorDirectory(directory, { indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB || !directory) return false;
  for (const name of fields) if (typeof directory[name] !== "string" || !directory[name].length || directory[name].length > MAX_TEXT) return false;
  if (!Number.isFinite(Date.parse(directory.validAfter)) || !Number.isFinite(Date.parse(directory.validUntil))) return false;
  try {
    const record = { validAfter: directory.validAfter, freshUntil: directory.freshUntil, validUntil: directory.validUntil, savedAt: new Date().toISOString() };
    for (const name of fields) record[name] = await gzip(directory[name]);
    const db = await open(indexedDB);
    try { await run(db, "readwrite", (store) => store.put(record, KEY)); } finally { db.close(); }
    return true;
  } catch { return false; }
}
