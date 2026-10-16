// Browser edition: runs the real app session (session.js, native-host.js, Pi library)
// against the in-page browser host, in Node with small Worker/localStorage stand-ins.
// Build first: scripts/build-browser.sh
import test from "node:test";
import { heavy } from "./heavy.mjs";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { existsSync } from "node:fs";

const DIST = new URL(process.env.PI_BROWSER_TEST_DIST ?? "../dist/browser/", import.meta.url);
const skip = heavy || (!existsSync(new URL("browser-host.js", DIST)) && "run scripts/build-browser.sh first");

// ---------------------------------------------------------------- browser stand-ins
class WebWorker {
  constructor(url) {
    const bootstrap = `
      const { parentPort, workerData } = require("node:worker_threads");
      globalThis.self = globalThis;
      globalThis.addEventListener = () => {};
      globalThis.postMessage = (m) => parentPort.postMessage(m);
      const queue = [];
      parentPort.on("message", (data) => globalThis.onmessage ? globalThis.onmessage({ data }) : queue.push(data));
      import(workerData.url).then(() => { for (const data of queue.splice(0)) globalThis.onmessage({ data }); },
        (e) => { console.error(e); process.exit(3); });`;
    this.worker = new NodeWorker(bootstrap, { eval: true, workerData: { url: String(url) } });
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { void this.worker.terminate(); }
}
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.Worker = WebWorker;
if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto; // Node 18
Promise.withResolvers ??= () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }; // Node < 22

/** Simulates IndexedDB: records survive "reloads" (new Vfs instances). */
class SharedBackend {
  constructor() { this.meta = new Map(); this.content = new Map(); this.saves = 0; }
  async open() {}
  async loadMeta() { return [...this.meta].map(([k, v]) => [k, structuredClone(v)]); }
  async readContent(id) { return this.content.get(id)?.slice(); }
  async save({ meta = [], content = [] }) {
    this.saves++;
    for (const [id, data] of content) data ? this.content.set(id, data.slice()) : this.content.delete(id);
    for (const [path, record] of meta) record ? this.meta.set(path, structuredClone(record)) : this.meta.delete(path);
  }
  close() {}
}

const context = {};
async function openHost(backend) {
  const { Vfs } = await import(new URL("builtin/core-execution/web/browser/browser-vfs.js", DIST));
  const { createBrowserHost } = await import(new URL("browser-host.js", DIST));
  const { createNativeBridge } = await import(new URL("native-host.js", DIST));
  // E1: the JavaScript execution@1 provider's environment (core-execution's page backend, shell javascript).
  const { openNativeExecutionEnv } = await import(new URL("builtin/core-execution/web/execution-env.js", DIST));
  const vfs = await Vfs.open({ backend });
  const host = await createBrowserHost({ version: "test-browser", vfs });
  const bridge = createNativeBridge(host.transport);
  const info = await bridge.call("host.info");
  globalThis.__piHostInfo = info;
  const env = await openNativeExecutionEnv(bridge, undefined, { shell: "javascript" });
  return { vfs, host, bridge, env, info };
}
async function run(env, command, options = {}) {
  let out = "", err = "";
  const result = await env.exec(command, { ...options, onOutput: (text, _c, info) => { if (info.stream === "stderr") err += text; else out += text; } }, context);
  return { result, out, err };
}

test("files: write, read, list, rename, remove through the native ExecutionEnv adapter", { skip }, async () => {
  const { env, vfs } = await openHost(new SharedBackend());
  assert.equal(env.cwd, "/workspace");
  assert.ok((await env.writeFile("notes/a.txt", "hello\nworld\n", context)).ok);
  assert.equal((await env.readTextFile("/workspace/notes/a.txt", context)).value, "hello\nworld\n");
  assert.ok((await env.appendFile("notes/a.txt", "!", context)).ok);
  assert.deepEqual((await env.readTextLines("notes/a.txt", undefined, context)).value, ["hello", "world", "!"]);
  const list = await env.listDir("notes", context);
  assert.deepEqual(list.value.map((e) => [e.name, e.kind, e.size]), [["a.txt", "file", 13]]);
  assert.ok((await env.renameFile("notes", "moved", context)).ok);
  assert.equal((await env.exists("moved/a.txt", context)).value, true);
  assert.equal((await env.exists("notes", context)).value, false);
  const missing = await env.readTextFile("nope.txt", context);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "not_found");
  const outside = await env.writeFile("/etc/passwd", "x", context);
  assert.equal(outside.error.code, "permission_denied");
  assert.ok((await env.remove("moved", { recursive: true }, context)).ok);
  const big = new Uint8Array(700 * 1024).map((_, i) => i % 251);
  assert.ok((await env.writeFile("big.bin", big, context)).ok);
  assert.deepEqual((await env.readBinaryFile("big.bin", context)).value, big);
  await vfs.flush();
});

test("javascript console: output, last value, fs, errors, timeout", { skip }, async () => {
  const { env } = await openHost(new SharedBackend());
  let r = await run(env, "console.log('hi', {a: 1}); 6 * 7");
  assert.equal(r.result.value.exitCode, 0);
  assert.equal(r.out, "hi { a: 1 }\n42\n");
  r = await run(env, "await fs.writeFile('x/y.json', JSON.stringify({ok: true})); return (await fs.readJSON('x/y.json')).ok");
  assert.equal(r.out, "true\n");
  assert.equal((await env.readTextFile("x/y.json", context)).value, '{"ok":true}');
  r = await run(env, "(await fs.readdir('x', {withFileTypes: true})).map(e => e.name + (e.isFile() ? '' : '/'))");
  assert.match(r.out, /y\.json/);
  r = await run(env, "throw new Error('boom')");
  assert.equal(r.result.value.exitCode, 1);
  assert.match(r.err, /boom/);
  r = await run(env, "process.exit(3)");
  assert.equal(r.result.value.exitCode, 3);
  r = await run(env, "await fs.readFile('missing.txt')");
  assert.equal(r.result.value.exitCode, 1);
  assert.match(r.err, /No such file/);
  r = await run(env, "while (true) {}", { timeout: 1 });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error.code, "timeout");
  r = await run(env, "process.cwd()", { cwd: "x" });
  assert.equal(r.out, "/workspace/x\n");
});

test("app session: offline demo writes and reads a file; conversation survives a reload", { skip }, async () => {
  const backend = new SharedBackend();
  const { JsonlStorage } = await import(new URL("library/pi-durable/storage/jsonl.js", DIST));
  const { openAppSession } = await import(new URL("session.js", DIST));
  let { bridge, env } = await openHost(backend);
  let storage = await JsonlStorage.open("/data/conversations", env, context, { fsync: true });
  let session = await openAppSession({ bridge, env, storage, demoTokensPerSecond: 10000, toolchain: false });
  const tools = session.snapshot;
  assert.equal(tools.mode, "offline");
  await session.send("Hello from the browser edition");
  for (let i = 0; i < 200 && (session.snapshot.busy || session.snapshot.messages.length < 3); i++) await new Promise((r) => setTimeout(r, 25));
  const texts = session.snapshot.messages.map((m) => m.text ?? "").join("\n");
  assert.match(texts, /demo-note\.txt/);
  assert.equal((await env.readTextFile("demo-note.txt", context)).value, "Hello from the browser edition");
  const count = session.snapshot.messages.length;
  await session.close();

  ({ bridge, env } = await openHost(backend)); // a "reload": fresh Vfs from the saved records
  storage = await JsonlStorage.open("/data/conversations", env, context, { fsync: true });
  session = await openAppSession({ bridge, env, storage, toolchain: false });
  for (let i = 0; i < 100 && session.snapshot.messages.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(session.snapshot.messages.length, count);
  await session.close();
});

test("agent tools: exactly one shell tool, matching the selected execution environment (E1)", { skip }, async () => {
  const { env } = await openHost(new SharedBackend());
  const { fileAndShellTools } = await import(new URL("builtin/core-tools/web/tools.js", DIST));
  const hostInfo = globalThis.__piHostInfo;
  // JavaScript environment (exec-js): a `javascript` tool that says Linux is selectable.
  assert.equal(env.shell?.id, "javascript");
  const js = fileAndShellTools({ hostInfo, env });
  assert.deepEqual(js.map((t) => t.name), ["read", "write", "edit", "javascript"]);
  assert.match(js[3].description, /Web Worker/);
  assert.match(js[3].description, /Settings → Providers/);
  // Linux environment (exec-linux): a `bash` tool with the Linux description.
  const linuxEnv = { shell: { id: "bash", language: "bash", name: "Linux (Bash)" } };
  const linux = fileAndShellTools({ hostInfo, env: linuxEnv });
  assert.deepEqual(linux.map((t) => t.name), ["read", "write", "edit", "bash"]);
  assert.match(linux[3].description, /real Linux/);
  assert.doesNotMatch(linux[3].description, /merged/);
  // A page without Linux does not advertise switching to it.
  const noLinux = fileAndShellTools({ hostInfo: { ...hostInfo, capabilities: { ...hostInfo.capabilities, linuxShell: false } }, env });
  assert.doesNotMatch(noLinux[3].description, /switch the execution environment to Linux/);
});

// ---------------------------------------------------------------- app revisions (fake IndexedDB + service worker)
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
          transaction(names) {
            const tx = { objectStore: (store) => {
              const map = db.stores.get(store);
              return {
                get: (key) => request(() => structuredClone(map.get(key))),
                put: (value, key) => request(() => { map.set(key, structuredClone(value)); }),
                count: (key) => request(() => map.has(key) ? 1 : 0),
                getAllKeys: () => request(() => [...map.keys()]),
                delete: (key) => request(() => { map.delete(key); }),
              };
            } };
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

test("app revisions: seed, stage, activate, ready, restore and roll back an unstarted revision", { skip }, async () => {
  globalThis.indexedDB = fakeIndexedDb();
  const messages = [];
  let reloads = 0;
  globalThis.location = { href: "http://127.0.0.1:8770/", reload: () => { reloads++; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { register: async () => {}, ready: Promise.resolve(), controller: { postMessage: (m) => messages.push(m) } } } });
  const files = { "index.html": '<script type="module" src="./browser-main.js"></script>', "app.js": "export {}", "app.css": "body{}" };
  globalThis.fetch = async (url) => { const name = new URL(url).pathname.slice(1); return { ok: name in files, status: 404, arrayBuffer: async () => new TextEncoder().encode(files[name]).buffer }; };
  const { Vfs, MemoryBackend } = await import(new URL("builtin/core-execution/web/browser/browser-vfs.js", DIST));
  const { createRevisions } = await import(new URL("browser-revisions.js", DIST));
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const manifest = { editableFiles: [...Object.keys(files), "browser-host.js", "library/pi-ai.js"] };
  let revisions = await createRevisions({ vfs, version: "9.9-browser", manifest });
  const source = "/workspace/.self-forming/app/9.9-browser";
  assert.equal(revisions.sourcePath, source);
  assert.deepEqual(vfs.readdir(source), ["README.md", "app.css", "app.js", "index.html"]);
  let info = await revisions.methods["app.info"]();
  assert.equal(info.revision, "bundled");

  vfs.write(`${source}/app.css`, new TextEncoder().encode("body{color:red}"));
  const { revision } = await revisions.methods["app.stage"]();
  assert.match(revision, /^r-/);
  info = await revisions.methods["app.activate"]({ revision });
  assert.equal(info.revision, revision);
  assert.deepEqual(messages.at(-1), { type: "revision-changed" });

  // Reload 1: the revision starts and reports ready.
  revisions = await createRevisions({ vfs, version: "9.9-browser", manifest });
  info = await revisions.methods["app.ready"]({ revision });
  assert.equal(info.revision, revision);
  // Reload 2: nothing pending, so no rollback.
  revisions = await createRevisions({ vfs, version: "9.9-browser", manifest });
  assert.equal((await revisions.methods["app.info"]()).revision, revision);

  // A second revision that never reports ready is rolled back on the following start.
  const second = (await revisions.methods["app.stage"]()).revision;
  await revisions.methods["app.activate"]({ revision: second });
  revisions = await createRevisions({ vfs, version: "9.9-browser", manifest }); // start 1, no ready
  assert.equal(reloads, 0);
  void createRevisions({ vfs, version: "9.9-browser", manifest });                // start 2: rollback + reload
  for (let i = 0; i < 50 && !reloads; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reloads, 1);
  revisions = await createRevisions({ vfs, version: "9.9-browser", manifest });
  info = await revisions.methods["app.info"]();
  assert.equal(info.revision, revision);
  assert.match(info.notice, /did not start/);

  info = await revisions.methods["app.restore"]({ target: "original" });
  assert.equal(info.revision, "bundled");
  assert.equal(info.previousRevision, revision);
  info = await revisions.methods["app.restore"]({ target: "previous" });
  assert.equal(info.revision, revision);
});
