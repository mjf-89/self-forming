import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { NativeBridgeError, type NativeBridge } from "./bridge.ts";
import { base64ToBytes, bytesToBase64, isRecord, type WireValue } from "./wire.ts";

function encodeValue(value: SqliteValue): WireValue {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new TypeError("SQLite bindings must be finite numbers, bigints, strings, bytes or null");
}

function decodeValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (isRecord(value) && Object.keys(value).length === 1) {
    if (typeof value.$bytes === "string") return base64ToBytes(value.$bytes);
    if (typeof value.$bigint === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value.$bigint)) return BigInt(value.$bigint);
  }
  throw new TypeError("Invalid SQLite value from native host");
}

class OperationQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
  async drain(): Promise<void> { await this.#tail; }
}

/** Async, ordered native facade implementing Pi Durable's upstream SQLite interface. */
export async function openNativeDatabase(bridge: NativeBridge, name: string): Promise<SqliteDatabase> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError("Database name must be a simple identifier");
  const opened = await bridge.call<{ handle: string; queryPaging?: boolean }>("sqlite.open", { name });
  if (!opened || typeof opened.handle !== "string" || !opened.handle) throw new TypeError("Native host returned no database handle");
  const handle = opened.handle;
  const queue = new OperationQueue();
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let rejectLost!: (error: Error) => void;
  const connectionLost = new Promise<never>((_resolve, reject) => { rejectLost = reject; });
  void connectionLost.catch(() => {});
  const unsubscribe = bridge.onClose((error) => { failure = error; rejectLost(error); });
  const assertLive = (): void => {
    if (failure) throw failure;
    if (closed || bridge.closed) throw new NativeBridgeError("database_closed", "Native database is closed");
  };
  const rawExec = async (sql: string): Promise<void> => {
    assertLive();
    await bridge.call("sqlite.exec", { handle, sql });
  };
  const rawRun = async (sql: string, params: SqliteValue[]): Promise<void> => {
    assertLive();
    await bridge.call("sqlite.run", { handle, sql, params: params.map(encodeValue) });
  };
  const rawAll = async <T extends object>(sql: string, params: SqliteValue[]): Promise<T[]> => {
    assertLive();
    const decodeRows = (rows: unknown): T[] => {
      if (!Array.isArray(rows)) throw new TypeError("Invalid SQLite rows from native host");
      return rows.map((row) => {
      if (!isRecord(row)) throw new TypeError("Invalid SQLite row from native host");
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeValue(value)])) as T;
      });
    };
    // Older hosts retain their original adapter. New hosts keep one SQL
    // statement/snapshot open while image-bearing histories cross in pages.
    if (!opened.queryPaging)
      return decodeRows(await bridge.call("sqlite.all", { handle, sql, params: params.map(encodeValue) }));
    const result: T[] = [];
    let cursor: string | undefined;
    try {
      do {
        assertLive();
        const page = await bridge.call<unknown>(cursor ? "sqlite.queryNext" : "sqlite.queryOpen",
          cursor ? { handle, cursor } : { handle, sql, params: params.map(encodeValue) });
        if (!isRecord(page) || !(page.cursor === null || typeof page.cursor === "string" && page.cursor.length > 0))
          throw new TypeError("Invalid SQLite page from native host");
        cursor = page.cursor === null ? undefined : page.cursor as string;
        result.push(...decodeRows(page.rows));
      } while (cursor);
      return result;
    } finally {
      if (cursor && !bridge.closed) await bridge.call("sqlite.queryClose", { handle, cursor }).catch(() => {});
    }
  };
  const executor = (schedule: <T>(operation: () => Promise<T>) => Promise<T>): SqliteExecutor => ({
    exec: (sql) => schedule(() => rawExec(sql)),
    run: (sql, ...params) => schedule(() => rawRun(sql, params)),
    get: <T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> => schedule<T | undefined>(async () => (await rawAll<T>(sql, params))[0]),
    all: <T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> => schedule<T[]>(() => rawAll<T>(sql, params)),
  });
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing || closed) return Promise.reject(new NativeBridgeError("database_closed", "Native database is closed"));
    if (failure) return Promise.reject(failure);
    return Promise.race([queue.run(() => Promise.race([operation(), connectionLost])), connectionLost]);
  };
  return {
    ...executor(admit),
    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
      return admit(async () => {
        await rawExec("BEGIN IMMEDIATE");
        let active = true;
        const transactionQueue = new OperationQueue();
        const transaction = executor(<R>(operation: () => Promise<R>): Promise<R> => {
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
    close(): Promise<void> {
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
