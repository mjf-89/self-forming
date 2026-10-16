// Durable immutable code snapshots, separate from workspace/app/auth/conversation stores.
export const PLUGIN_DB = "self-forming-browser-plugins-v1";
const result = request => new Promise((resolve,reject) => {
  let blocked = false;
  request.onsuccess = () => { if (blocked) request.result?.close?.(); else resolve(request.result); };
  request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  request.onblocked = () => { blocked = true; reject(new Error("Plugin database upgrade is blocked by another page")); };
});
const complete = tx => new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Plugin transaction aborted")); });
export async function openPluginStore(idb = globalThis.indexedDB, { probe = true } = {}) {
  const request = idb.open(PLUGIN_DB, 1);
  request.onupgradeneeded = () => { for (const name of ["snapshots","selections"]) request.result.createObjectStore(name); };
  const opened = result(request);
  const db = await opened;
  db.onversionchange = () => db.close();
  // Exercise a committing write transaction before advertising durable management.
  // The reserved non-ID probe never survives publication or touches user records.
  try {
    if (probe) {
      const tx = db.transaction("selections", "readwrite"), done = complete(tx);
      tx.objectStore("selections").put({ probe: true }, "__probe");
      tx.objectStore("selections").delete("__probe");
      await done;
    }
  } catch (error) { db.close(); throw error; }
  const read = (store,key) => result(db.transaction(store).objectStore(store).get(key));
  return {
    durable: true,
    snapshot: (id,hash) => read("snapshots", `${id}/${hash}`),
    selection: id => read("selections",id),
    selections: () => result(db.transaction("selections").objectStore("selections").getAll()),
    // Snapshot and selection commit together; failure/quota cannot expose a dangling pointer.
    async publish(snapshot, selection) {
      const tx = db.transaction(["snapshots","selections"],"readwrite"), done = complete(tx);
      if (snapshot) {
        const key = `${snapshot.manifest.id}/${snapshot.hash}`, store = tx.objectStore("snapshots");
        const get = store.getKey(key);
        get.onsuccess = () => { if (get.result === undefined) store.add(snapshot,key); };
      }
      tx.objectStore("selections").put(selection,selection.id);
      await done;
    },
    close: () => db.close()
  };
}
