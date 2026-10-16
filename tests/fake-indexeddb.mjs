// Small in-memory IndexedDB double for node tests (not a test file itself).
// Supports what the browser edition's fixed recovery code uses: open/upgrade, object stores
// with get/put/add/delete/count/getAll/getAllKeys/getKey, readwrite transactions that are
// serialized, auto-commit once no request is pending after a macrotask (so awaiting a
// request inside a transaction works as in browsers), abort with rollback.
export function fakeIndexedDb() {
  const databases = new Map(); // name -> Map(store -> Map)
  let queue = Promise.resolve();
  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

  function transaction(db, names, mode = "readonly") {
    const stores = (Array.isArray(names) ? names : [names]).map((n) => { if (!db.has(n)) throw new Error(`NotFoundError: ${n}`); return n; });
    let pending = 0, finished = false, started = false, aborted = false, backup;
    const waiting = [];
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const previous = queue;
    queue = turn; // every transaction runs after the previous one finished
    const tx = { error: null, mode,
      objectStore(name) {
        if (!stores.includes(name)) throw new Error(`NotFoundError: ${name} not in transaction`);
        const map = () => db.get(name);
        const request = (fn) => {
          if (finished) throw new Error("TransactionInactiveError");
          const r = { result: undefined, error: null };
          pending++;
          const run = () => setTimeout(() => {
            if (aborted) { pending--; return; }
            try { r.result = fn(); pending--; r.onsuccess?.({ target: r }); }
            catch (e) { pending--; r.error = e; r.onerror?.({ target: r }); tx.abort(e); }
            scheduleCommit();
          }, 0);
          started ? run() : waiting.push(run);
          return r;
        };
        const write = (fn) => { if (mode !== "readwrite") throw new Error("ReadOnlyError"); return request(fn); };
        return {
          get: (key) => request(() => structuredClone(map().get(key))),
          getKey: (key) => request(() => (map().has(key) ? key : undefined)),
          count: (key) => request(() => (key === undefined ? map().size : map().has(key) ? 1 : 0)),
          getAll: () => request(() => [...map().values()].map((v) => structuredClone(v))),
          getAllKeys: () => request(() => [...map().keys()].sort()),
          put: (value, key) => write(() => { map().set(key, structuredClone(value)); return key; }),
          add: (value, key) => write(() => { if (map().has(key)) throw new Error("ConstraintError"); map().set(key, structuredClone(value)); return key; }),
          delete: (key) => write(() => { map().delete(key); }),
        };
      },
      abort(error) {
        if (finished) throw new Error("InvalidStateError");
        finished = aborted = true;
        tx.error = error ?? null;
        if (backup) for (const [name, copy] of backup) db.set(name, copy);
        setTimeout(() => { tx.onabort?.(); release(); }, 0);
      },
    };
    function scheduleCommit() {
      void macrotask().then(() => {
        if (finished || pending) return;
        finished = true;
        tx.oncomplete?.();
        release();
      });
    }
    void previous.then(() => {
      started = true;
      if (aborted) return;
      if (mode === "readwrite") backup = new Map(stores.map((n) => [n, new Map([...db.get(n)].map(([k, v]) => [k, structuredClone(v)]))]));
      for (const run of waiting.splice(0)) run();
      scheduleCommit();
    });
    return tx;
  }

  return {
    databases,
    open(name, version = 1) {
      const r = {};
      setTimeout(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const db = databases.get(name);
        r.result = {
          name, version,
          objectStoreNames: { contains: (n) => db.has(n) },
          createObjectStore: (store) => { db.set(store, new Map()); },
          transaction: (names, mode) => transaction(db, names, mode),
          close() {},
          onversionchange: null,
        };
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      }, 0);
      return r;
    },
  };
}
