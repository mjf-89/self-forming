import { DatabaseSync } from "node:sqlite";
import type { NativeBridgeTransport } from "../packages/native-host/src/bridge.ts";
import { base64ToBytes, bytesToBase64, isRecord } from "../packages/native-host/src/wire.ts";

export type HostRequest = { id: string; method: string; params: Record<string, unknown> };
export class MockHost implements NativeBridgeTransport {
  onmessage: NativeBridgeTransport["onmessage"] = null;
  readonly requests: HostRequest[] = [];
  handler: (request: HostRequest) => unknown | Promise<unknown>;
  constructor(handler: MockHost["handler"] = () => null) { this.handler = handler; }
  postMessage(message: string): void {
    const request = JSON.parse(message) as HostRequest;
    this.requests.push(request);
    void Promise.resolve().then(() => this.handler(request)).then(
      (result) => this.send({ id: request.id, ok: true, result }),
      (error: unknown) => this.send({ id: request.id, ok: false, error: {
        code: isRecord(error) && typeof error.code === "string" ? error.code : "host_error",
        message: error instanceof Error ? error.message : String(error),
      } }),
    );
  }
  send(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

export function sqliteHost(): { host: MockHost; database: DatabaseSync; log: string[] } {
  const database = new DatabaseSync(":memory:");
  const log: string[] = [];
  const host = new MockHost(({ method, params }) => {
    if (method === "sqlite.open") return { handle: "db1" };
    if (method === "sqlite.close") { log.push("CLOSE"); database.close(); return null; }
    const sql = String(params.sql);
    log.push(sql);
    if (method === "sqlite.exec") { database.exec(sql); return null; }
    const bindings = (params.params as unknown[]).map((value) => {
      if (isRecord(value) && typeof value.$bytes === "string") return base64ToBytes(value.$bytes);
      if (isRecord(value) && typeof value.$bigint === "string") return BigInt(value.$bigint);
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      throw new TypeError("Invalid binding");
    });
    const statement = database.prepare(sql);
    if (method === "sqlite.run") { statement.run(...bindings); return null; }
    if (method === "sqlite.all") {
      statement.setReadBigInts(true);
      return statement.all(...bindings).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        value instanceof Uint8Array ? { $bytes: bytesToBase64(value) }
          : typeof value === "bigint" ? value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value) : { $bigint: value.toString() }
          : value,
      ])));
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return { host, database, log };
}
