// core-storage: the native SQLite facade (step X3, docs/plugin-ownership.md).
// Hand-ported from packages/native-host/src/sqlite.ts (openNativeDatabase, compiled into the fixed
// native-host.js, which keeps its own copy as the last-resort fallback). Behaviour is identical:
// the same bridge methods (sqlite.open/exec/run/all, paged sqlite.queryOpen/queryNext/queryClose,
// sqlite.close), parameters, value encoding ($bytes, $bigint), ordering queue, transaction
// handling (BEGIN IMMEDIATE / COMMIT / ROLLBACK, quarantine after a failed rollback), bridge-loss
// behaviour and error messages. The database itself stays in the host (Android: SqliteStore.kt /
// SqlScript.kt, pending X3n → core-storage's native half).
// Shared bridge helper: NativeBridgeError comes from the fixed native-host.js (the bridge throws it,
// and callers may test for it). The small wire helpers are not exported there and are copied below.
import { NativeBridgeError } from "../../../native-host.js";

// Wire helpers (packages/native-host/src/wire.ts, verbatim).
function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}
function base64ToBytes(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid base64 payload from native host");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeValue(value) {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new TypeError("SQLite bindings must be finite numbers, bigints, strings, bytes or null");
}

function decodeValue(value) {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (isRecord(value) && Object.keys(value).length === 1) {
    if (typeof value.$bytes === "string") return base64ToBytes(value.$bytes);
    if (typeof value.$bigint === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value.$bigint)) return BigInt(value.$bigint);
  }
  throw new TypeError("Invalid SQLite value from native host");
}

class OperationQueue {
  #tail = Promise.resolve();
  run(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
  async drain() { await this.#tail; }
}

/** Async, ordered native facade implementing Pi Durable's upstream SQLite interface. */
export async function openNativeDatabase(bridge, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError("Database name must be a simple identifier");
  const opened = await bridge.call("sqlite.open", { name });
  if (!opened || typeof opened.handle !== "string" || !opened.handle) throw new TypeError("Native host returned no database handle");
  const handle = opened.handle;
  const queue = new OperationQueue();
  let failure;
  let closing;
  let closed = false;
  let rejectLost;
  const connectionLost = new Promise((_resolve, reject) => { rejectLost = reject; });
  void connectionLost.catch(() => {});
  const unsubscribe = bridge.onClose((error) => { failure = error; rejectLost(error); });
  const assertLive = () => {
    if (failure) throw failure;
    if (closed || bridge.closed) throw new NativeBridgeError("database_closed", "Native database is closed");
  };
  const rawExec = async (sql) => {
    assertLive();
    await bridge.call("sqlite.exec", { handle, sql });
  };
  const rawRun = async (sql, params) => {
    assertLive();
    await bridge.call("sqlite.run", { handle, sql, params: params.map(encodeValue) });
  };
  const rawAll = async (sql, params) => {
    assertLive();
    const decodeRows = (rows) => {
      if (!Array.isArray(rows)) throw new TypeError("Invalid SQLite rows from native host");
      return rows.map((row) => {
        if (!isRecord(row)) throw new TypeError("Invalid SQLite row from native host");
        return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeValue(value)]));
      });
    };
    // Older hosts retain their original adapter. New hosts keep one SQL
    // statement/snapshot open while image-bearing histories cross in pages.
    if (!opened.queryPaging)
      return decodeRows(await bridge.call("sqlite.all", { handle, sql, params: params.map(encodeValue) }));
    const result = [];
    let cursor;
    try {
      do {
        assertLive();
        const page = await bridge.call(cursor ? "sqlite.queryNext" : "sqlite.queryOpen",
          cursor ? { handle, cursor } : { handle, sql, params: params.map(encodeValue) });
        if (!isRecord(page) || !(page.cursor === null || typeof page.cursor === "string" && page.cursor.length > 0))
          throw new TypeError("Invalid SQLite page from native host");
        cursor = page.cursor === null ? undefined : page.cursor;
        result.push(...decodeRows(page.rows));
      } while (cursor);
      return result;
    } finally {
      if (cursor && !bridge.closed) await bridge.call("sqlite.queryClose", { handle, cursor }).catch(() => {});
    }
  };
  const executor = (schedule) => ({
    exec: (sql) => schedule(() => rawExec(sql)),
    run: (sql, ...params) => schedule(() => rawRun(sql, params)),
    get: (sql, ...params) => schedule(async () => (await rawAll(sql, params))[0]),
    all: (sql, ...params) => schedule(() => rawAll(sql, params)),
  });
  const admit = (operation) => {
    if (closing || closed) return Promise.reject(new NativeBridgeError("database_closed", "Native database is closed"));
    if (failure) return Promise.reject(failure);
    return Promise.race([queue.run(() => Promise.race([operation(), connectionLost])), connectionLost]);
  };
  return {
    ...executor(admit),
    transaction(callback) {
      return admit(async () => {
        await rawExec("BEGIN IMMEDIATE");
        let active = true;
        const transactionQueue = new OperationQueue();
        const transaction = executor((operation) => {
          if (!active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
          return transactionQueue.run(operation);
        });
        try {
          const result = await Promise.race([callback(transaction), connectionLost]);
          active = false;
          await transactionQueue.drain();
          await rawExec("COMMIT");
          return result;
        } catch (error) {
          active = false;
          await transactionQueue.drain();
          try { await rawExec("ROLLBACK"); }
          catch (rollbackError) {
            // This connection has an unknown transaction state and must never run another operation.
            const rollbackFailure = new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
            // A bridge-loss reason already invalidated every handle; keep it stable for later callers.
            failure ??= rollbackFailure;
            throw rollbackFailure;
          }
          throw error;
        }
      });
    },
    close() {
      if (closing) return closing;
      closing = queue.run(async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (!bridge.closed) await bridge.call("sqlite.close", { handle });
      });
      return closing;
    },
  };
}
