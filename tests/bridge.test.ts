import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeBridge, NativeBridgeError } from "../packages/native-host/src/bridge.ts";
import { createNativeWorkspace } from "../packages/native-host/src/workspace.ts";
import { deferred, MockHost } from "./bridge-support.ts";

test("bridge correlates overlapping replies and keeps working after a rejected call", async () => {
  const first = deferred<number>();
  const host = new MockHost(({ method }) => {
    if (method === "first") return first.promise;
    if (method === "fail") throw Object.assign(new Error("Denied"), { code: "EACCES" });
    return 2;
  });
  const bridge = createNativeBridge(host);
  const pending = bridge.call<number>("first");
  assert.equal(await bridge.call("second"), 2);
  first.resolve(1);
  assert.equal(await pending, 1);
  await assert.rejects(bridge.call("fail"), (error: unknown) => error instanceof NativeBridgeError && error.code === "EACCES");
  assert.equal(await bridge.call("third"), 2);
  bridge.close();
});

test("bridge close rejects pending calls and invalidates observers exactly once", async () => {
  const host = new MockHost(() => new Promise(() => {}));
  const bridge = createNativeBridge(host);
  const pending = assert.rejects(bridge.call("waiting"), /closed/);
  let closes = 0;
  bridge.onClose(() => { closes++; });
  bridge.close();
  bridge.close();
  await pending;
  assert.equal(closes, 1);
  assert.equal(bridge.closed, true);
  await assert.rejects(bridge.call("after"), /closed/);
  assert.equal(host.onmessage, null);
});

test("invalid native messages invalidate the bridge instead of leaving requests pending", async () => {
  const host = new MockHost(() => new Promise(() => {}));
  const bridge = createNativeBridge(host);
  const pending = assert.rejects(bridge.call("waiting"), (error: unknown) => error instanceof NativeBridgeError && error.code === "protocol_error");
  host.send({ id: "bad", ok: false, error: "not structured" });
  await pending;
  assert.equal(bridge.closed, true);
});

test("bridge enforces UTF-8 message limit before writing and isolates event listeners", async () => {
  const host = new MockHost();
  const bridge = createNativeBridge(host);
  await assert.rejects(bridge.call("large", { text: "😀".repeat(1024 * 1024) }), /4 MiB/);
  assert.equal(host.requests.length, 0);
  let events = 0;
  bridge.subscribe(() => { throw new Error("observer failure"); });
  const unsubscribe = bridge.subscribe(() => { events++; });
  host.send({ event: "host.lifecycle", id: "host", foreground: true });
  unsubscribe();
  host.send({ event: "host.lifecycle", id: "host", foreground: false });
  assert.equal(events, 1);
  assert.equal(bridge.closed, false);
  bridge.close();
});

test("native workspace has relative text read/write/list and measures UTF-8 size", async () => {
  const files = new Map<string, string>();
  const host = new MockHost(({ method, params }) => {
    if (method === "workspace.write") { files.set(String(params.path), String(params.text)); return null; }
    if (method === "workspace.read") return { text: files.get(String(params.path)) };
    return [{ name: "note.txt", path: "note.txt", directory: false, size: 5 }];
  });
  const bridge = createNativeBridge(host);
  const workspace = createNativeWorkspace(bridge);
  await workspace.write("note.txt", "hello");
  assert.equal(await workspace.read("note.txt"), "hello");
  assert.equal((await workspace.list())[0].name, "note.txt");
  for (const path of ["../secret", "/absolute", "C:/secret", "folder\\secret", "nul\0path"]) {
    await assert.rejects(workspace.read(path), /relative|cannot contain/);
  }
  await assert.rejects(workspace.write("large", "😀".repeat(262145)), /1 MiB/);
  bridge.close();
});

test("notification Stop reaches subscribers without disrupting pending bridge calls", async () => {
  const reply = deferred<number>();
  const host = new MockHost(() => reply.promise);
  const bridge = createNativeBridge(host);
  const pending = bridge.call<number>("working");
  let stops = 0;
  bridge.subscribe(event => { if (event.event === "agent.stopped") stops++; });
  host.send({ event: "agent.stopped", id: "agent" });
  assert.equal(stops, 1);
  assert.equal(bridge.closed, false);
  reply.resolve(42);
  assert.equal(await pending, 42);
  bridge.close();
});

test("malformed notification Stop invalidates the bridge and settles pending calls", async () => {
  const host = new MockHost(() => new Promise(() => {}));
  const bridge = createNativeBridge(host);
  const pending = assert.rejects(bridge.call("working"),
    (error: unknown) => error instanceof NativeBridgeError && error.code === "protocol_error");
  host.send({ event: "agent.stopped", id: "incorrect-sender" });
  await pending;
  assert.equal(bridge.closed, true);
});
