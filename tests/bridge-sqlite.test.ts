import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { createNativeBridge } from "../packages/native-host/src/bridge.ts";
import { openNativeDatabase } from "../packages/native-host/src/sqlite.ts";
import { deferred, sqliteHost, MockHost } from "./bridge-support.ts";

test("paged native SQLite reassembles image-sized history larger than one bridge response", async () => {
  const value = "x".repeat(1200 * 1024);
  let opens = 0, nexts = 0;
  const host = new MockHost(({ method }) => {
    if (method === "sqlite.open") return { handle: "db", queryPaging: true };
    if (method === "sqlite.queryOpen") { opens++; return { rows: [{ value }, { value }], cursor: "query" }; }
    if (method === "sqlite.queryNext") { nexts++; return { rows: [{ value }, { value }], cursor: null }; }
    if (method === "sqlite.close") return null;
    throw new Error(`Unexpected ${method}`);
  });
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "paged");
  try {
    const rows = await db.all<{value: string}>("SELECT value FROM history");
    assert.equal(rows.length, 4);
    assert.ok(rows.every(row => row.value === value));
    assert.equal(opens, 1, "SQL runs once, not once per page");
    assert.equal(nexts, 1);
  } finally { await db.close(); bridge.close(); }
});

test("failed native page decoding releases its live statement before later operations", async () => {
  const calls: string[] = [];
  const host = new MockHost(({ method }) => {
    calls.push(method);
    if (method === "sqlite.open") return { handle: "db", queryPaging: true };
    if (method === "sqlite.queryOpen") return { rows: [{ invalid: {} }], cursor: "query" };
    if (["sqlite.queryClose", "sqlite.close", "sqlite.exec"].includes(method)) return null;
    throw new Error(`Unexpected ${method}`);
  });
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "invalid_page");
  try {
    await assert.rejects(db.all("SELECT value FROM history"), /Invalid SQLite value/);
    await db.exec("SELECT 1");
    assert.ok(calls.indexOf("sqlite.queryClose") < calls.indexOf("sqlite.exec"));
  } finally { await db.close(); bridge.close(); }
});

test("native SQLite preserves blobs, large signed integers, scalar values and empty results", async () => {
  const { host } = sqliteHost();
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "test");
  await db.exec("CREATE TABLE values_test (b BLOB, i INTEGER, t TEXT, r REAL, n TEXT); CREATE TABLE empty_test (x INTEGER)");
  const bytes = new Uint8Array([0, 127, 128, 255]);
  const integer = 9223372036854775807n;
  await db.run("INSERT INTO values_test VALUES (?, ?, ?, ?, ?)", bytes, integer, "à😀", 1.25, null);
  assert.deepEqual(await db.get("SELECT * FROM values_test"), { b: bytes, i: integer, t: "à😀", r: 1.25, n: null });
  assert.equal(await db.get("SELECT * FROM empty_test"), undefined);
  assert.deepEqual(await db.all("SELECT * FROM empty_test"), []);
  await db.close();
  await db.close();
  await assert.rejects(db.exec("SELECT 1"), /closed/);
  bridge.close();
});

test("ordinary calls and later transactions wait behind rollback and preserve call order", async () => {
  const { host, log } = sqliteHost();
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "test");
  await db.exec("CREATE TABLE q (x INTEGER)");
  const gate = deferred();
  const started = deferred();
  const original = new Error("rollback this");
  const tx = db.transaction(async (handle) => {
    await handle.run("INSERT INTO q VALUES (?)", 1);
    started.resolve();
    await gate.promise;
    throw original;
  });
  const rejected = assert.rejects(tx, (error: unknown) => error === original);
  await started.promise;
  const before = db.all("SELECT x FROM q");
  const write = db.run("INSERT INTO q VALUES (?)", 2);
  const after = db.all("SELECT x FROM q");
  let secondStarted = false;
  const second = db.transaction(async (handle) => {
    secondStarted = true;
    await handle.run("INSERT INTO q VALUES (?)", 3);
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(log.filter((sql) => sql.startsWith("SELECT")).length, 0);
  gate.resolve();
  await rejected;
  assert.deepEqual(await before, []);
  await write;
  assert.deepEqual(await after, [{ x: 2 }]);
  await second;
  assert.deepEqual(await db.all("SELECT x FROM q ORDER BY x"), [{ x: 2 }, { x: 3 }]);
  await db.close();
  bridge.close();
});

test("transaction handles expire before commit acknowledgement and settlement waits for it", async () => {
  const { host } = sqliteHost();
  const originalHandler = host.handler;
  const commitStarted = deferred();
  const releaseCommit = deferred();
  host.handler = async (request) => {
    const result = await originalHandler(request);
    if (request.params.sql === "COMMIT") { commitStarted.resolve(); await releaseCommit.promise; }
    return result;
  };
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "test");
  let saved!: SqliteExecutor;
  let settled = false;
  const tx = db.transaction(async (handle) => { saved = handle; await handle.exec("CREATE TABLE probe (x INTEGER)"); })
    .then(() => { settled = true; });
  await commitStarted.promise;
  await assert.rejects(saved.run("INSERT INTO probe VALUES (?)", 7), /no longer active/);
  assert.equal(settled, false);
  releaseCommit.resolve();
  await tx;
  assert.deepEqual(await db.all("SELECT * FROM probe"), []);
  await db.close();
  bridge.close();
});

test("rollback failure reports uncertainty and quarantines the database handle", async () => {
  const { host } = sqliteHost();
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "test");
  const original = new Error("callback rejected after escaped commit");
  await assert.rejects(db.transaction(async (handle) => {
    await handle.exec("CREATE TABLE committed (x INTEGER)");
    await handle.exec("COMMIT");
    throw original;
  }), (error: unknown) => error instanceof AggregateError && error.errors[0] === original);
  const requests = host.requests.length;
  await assert.rejects(db.exec("SELECT 1"), AggregateError);
  assert.equal(host.requests.length, requests);
  await db.close();
  bridge.close();
});

test("bridge loss rejects queued database work even if an application callback never resolves", async () => {
  const { host, database } = sqliteHost();
  const bridge = createNativeBridge(host);
  const db = await openNativeDatabase(bridge, "test");
  const started = deferred();
  let saved!: SqliteExecutor;
  const tx = db.transaction(async (handle) => { saved = handle; started.resolve(); await new Promise(() => {}); });
  const txRejected = assert.rejects(tx, /bridge is closed/);
  await started.promise;
  const queuedRejected = assert.rejects(db.get("SELECT 1"), /bridge is closed/);
  bridge.close();
  await Promise.all([txRejected, queuedRejected]);
  await assert.rejects(saved.exec("SELECT 1"), /no longer active|closed/);
  await assert.rejects(db.get("SELECT 1"), /closed/);
  await db.close();
  database.close(); // Mock host's teardown, matching native WebView teardown.
});
