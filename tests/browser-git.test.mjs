// No build/dependencies/network required: node --test tests/browser-git.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Vfs, MemoryBackend, normalizePath } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createBrowserGit, createGitFs, createGitHttp } from "../plugins/core-git/web/browser-git.js";

// Match the existing browser tests' Node 18 compatibility, not runtime shims.
globalThis.crypto ??= webcrypto;
const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

async function fixture(t, { raw = false } = {}) {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  t.after(() => vfs.flush());
  const at = (path) => normalizePath(path, "/workspace");
  // The console worker facade: async, serializable VFS errors, object options.
  // Also exercise raw stat/readdir records from browser-host's RPC results.
  const rpc = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) { throw Object.assign(new Error(e.message), { code: e.code, path: e.path }); }
  };
  const fs = {
    readFile: rpc(async (p) => (await vfs.read(at(p))).slice()),
    writeFile: rpc((p, data) => vfs.write(at(p), data)),
    stat: rpc((p) => {
      const info = vfs.info(at(p));
      return raw ? info : { ...info, mtime: new Date(info.mtimeMs), isFile: () => info.kind === "file", isDirectory: () => info.kind === "directory" };
    }),
    readdir: rpc((p) => raw ? vfs.readdir(at(p)).map((name) => vfs.info(at(`${p}/${name}`))) : vfs.readdir(at(p))),
    mkdir: rpc((p, options) => vfs.mkdir(at(p), options?.recursive ?? true)),
    rm: rpc((p, options) => vfs.remove(at(p), { recursive: Boolean(options?.recursive), force: Boolean(options?.force) })),
  };
  fs.promises = fs;
  return { fs, vfs };
}
function author() {
  const id = crypto.randomUUID();
  return { name: `Generated test author ${id}`, email: `${id}@example.invalid`, timestamp: 1700000000, timezoneOffset: 0 };
}
const offline = () => { throw new Error("Unexpected network access in local test"); };

for (const raw of [false, true]) test(`local init/add/commit/log/branch/checkout with ${raw ? "raw RPC" : "worker"} fs`, async (t) => {
  const { fs, vfs } = await fixture(t, { raw });
  const identity = author();
  const prompts = [];
  const git = createBrowserGit({ fs, fetch: offline, cwd: "/workspace/project", onAuthor: (info) => { prompts.push(info); return identity; } });
  assert.equal(git.version(), "1.44.2");
  await git.init({ defaultBranch: "main" });
  await fs.writeFile("/workspace/project/readme.txt", encode("hello\n"));
  assert.equal(await git.status({ filepath: "readme.txt" }), "*added");
  await git.add({ filepath: "readme.txt" });
  assert.equal(await git.status({ filepath: "readme.txt" }), "added");
  const oid = await git.commit({ message: "initial\n" });
  assert.match(oid, /^[a-f0-9]{40}$/);
  assert.equal(await git.status({ filepath: "readme.txt" }), "unmodified");
  const [entry] = await git.log();
  assert.equal(entry.oid, oid);
  assert.equal(entry.commit.message, "initial\n");
  assert.deepEqual(entry.commit.author, identity);
  assert.deepEqual(entry.commit.committer, identity);
  assert.deepEqual(prompts, [{ operation: "commit", dir: "/workspace/project" }]);
  assert.equal(await git.getConfig({ path: "user.name" }), undefined);
  await git.branch({ ref: "topic", checkout: true });
  assert.equal(await git.currentBranch(), "topic");
  assert.deepEqual(await git.listBranches(), ["main", "topic"]);
  // Same length, and deliberately the SAME mtime: VFS clock granularity cannot
  // safely provide upstream's stat-cache guarantee.
  const mtime = vfs.info("/workspace/project/readme.txt").mtimeMs;
  await fs.writeFile("/workspace/project/readme.txt", encode("other\n"));
  vfs.get("/workspace/project/readme.txt").mtimeMs = mtime;
  assert.equal(await git.status({ filepath: "readme.txt" }), "*modified");
  const reopened = createBrowserGit({ fs, fetch: offline, cwd: "/workspace/project" });
  assert.equal(await reopened.status({ filepath: "readme.txt" }), "*modified");
  assert.deepEqual(await git.statusMatrix(), [["readme.txt", 1, 2, 1]]);
  await git.add({ filepath: "readme.txt" });
  await git.commit({ message: "topic", author: identity });
  await git.checkout({ ref: "main" });
  assert.equal(decode(await fs.readFile("/workspace/project/readme.txt")), "hello\n");
  assert.equal((await git.log()).length, 1);
  await git.tag({ ref: "v1" });
  assert.deepEqual(await git.listTags(), ["v1"]);
  await git.remove({ filepath: "readme.txt" });
  assert.equal(await git.status({ filepath: "readme.txt" }), "*undeleted");
});

test("no implicit identity, even with identity configured in a repository", async (t) => {
  const { fs } = await fixture(t);
  const git = createBrowserGit({ fs, fetch: offline });
  await git.init();
  await fs.writeFile("/workspace/.git/config", encode("[user]\nname = Configured person\nemail = configured@example.invalid\n"));
  for (const op of ["commit", "merge", "pull", "annotatedTag"]) {
    await assert.rejects(git[op]({ message: "test", ref: "v1" }), { code: "AuthorRequired" });
  }
  await assert.rejects(git.commit({ author: { name: "Incomplete" }, message: "no" }), { code: "AuthorRequired" });
  await assert.rejects(git.commit({ author: author(), committer: { email: "incomplete@example.invalid" }, message: "no" }), { code: "AuthorRequired" });
});

test("filesystem codes, stat fields, bytes, and missing primitives", async (t) => {
  const { fs } = await fixture(t, { raw: true });
  const p = createGitFs(fs).promises;
  await assert.rejects(p.stat("missing"), { code: "ENOENT", path: "/workspace/missing" });
  await assert.rejects(p.writeFile("/outside", "no"), { code: "EACCES" });
  await assert.rejects(p.mkdir("/workspace"), { code: "EEXIST" });
  await p.mkdir("empty");
  await p.mkdir("empty", { recursive: true });
  await p.writeFile("empty/a", "héllo");
  assert.equal(await p.readFile("empty/a", "utf8"), "héllo");
  assert.ok((await p.readFile("empty/a")) instanceof Uint8Array);
  const s = await p.lstat("empty/a");
  assert.equal(s.mode, 0o100644);
  assert.equal(s.size, 6);
  assert.equal(s.ctimeMs, s.mtimeMs);
  assert.ok(s.ctime instanceof Date && s.mtime instanceof Date);
  assert.ok(s.isFile() && !s.isDirectory() && !s.isSymbolicLink());
  assert.equal((await p.stat("empty")).mode, 0o40755);
  await assert.rejects(p.readFile("empty"), { code: "EISDIR" });
  await assert.rejects(p.readdir("empty/a"), { code: "ENOTDIR" });
  await assert.rejects(p.mkdir("empty/a"), { code: "EEXIST" });
  await assert.rejects(p.mkdir("absent/child"), { code: "ENOENT" });
  await assert.rejects(p.rmdir("empty"), { code: "ENOTEMPTY" });
  await assert.rejects(p.rmdir("empty/a"), { code: "ENOTDIR" });
  await assert.rejects(p.unlink("empty"), { code: "EISDIR" });
  await assert.rejects(p.rm("empty"), { code: "EISDIR" });
  await p.rm("nonexistent", { force: true });
  await assert.rejects(p.symlink("a", "empty/link"), { code: "ENOTSUP" });
  await assert.rejects(p.readlink("empty/a"), { code: "EINVAL" });
  await assert.rejects(p.writeFile("script", "#!/bin/sh", { mode: 0o777 }), { code: "ENOTSUP" });
  assert.deepEqual(await p.readdir("empty"), ["a"]);
  await p.unlink("empty/a");
  await p.rmdir("empty");
  await assert.rejects(p.stat("empty"), { code: "ENOENT" });
  const broken = createGitFs({ ...fs, promises: undefined, stat: async () => { throw { code: "unknown", message: "storage failed" }; } }).promises;
  await assert.rejects(broken.stat("a"), { code: "EIO", message: "storage failed" });
});

test("bound paths/transports cannot be overridden; URLs cannot persist credentials", async (t) => {
  const { fs, vfs } = await fixture(t);
  const git = createBrowserGit({ fs, fetch: offline, cwd: "/workspace/bound" });
  await git.init({ dir: "/workspace/elsewhere", fs: {}, http: {} });
  assert.ok(vfs.exists("/workspace/bound/.git/HEAD"));
  assert.ok(!vfs.exists("/workspace/elsewhere"));
  for (const url of ["https://dummy:dummy@example.invalid/repo.git", "https://example.invalid/repo.git?token=dummy", "ssh://example.invalid/repo.git"]) {
    await assert.rejects(git.clone({ url }), /credential-free|HTTP\(S\)/);
    await assert.rejects(git.addRemote({ remote: "origin", url }), /credential-free|HTTP\(S\)/);
  }
  await git.addRemote({ remote: "origin", url: "https://example.invalid/repo.git" });
  assert.deepEqual(await git.listRemotes(), [{ remote: "origin", url: "https://example.invalid/repo.git" }]);
  assert.ok(!decode(await vfs.read("/workspace/bound/.git/config")).includes("dummy"));
});

test("HTTP streams request/response chunks and preserves headers/status/signal", async () => {
  const signal = new AbortController().signal;
  let produced = 0, received = 0;
  const chunks = [encode("first"), encode("second")];
  async function* upload() { for (const chunk of chunks) { produced++; yield chunk; } }
  const transport = createGitHttp(async (url, init) => {
    assert.equal(url, "https://example.invalid/repo.git/git-upload-pack");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("content-type"), "application/x-git-upload-pack-request");
    assert.equal(init.headers.get("authorization"), "Basic ZHVtbXk6ZHVtbXk="); // dummy:dummy
    assert.equal(init.headers.get("x-extra"), "preserved");
    assert.equal(init.credentials, "omit");
    assert.equal(init.signal, signal);
    assert.equal(init.duplex, "half");
    assert.equal(produced, 0, "no eager buffering");
    const reader = init.body.getReader();
    for (const chunk of chunks) assert.equal((await reader.read()).value, chunk, "no copy");
    assert.ok((await reader.read()).done);
    return new Response(new ReadableStream({ pull(controller) {
      if (received < chunks.length) controller.enqueue(chunks[received++]);
      else controller.close();
    } }, { highWaterMark: 0 }), { status: 201, statusText: "Created", headers: { "X-Git-Test": "yes" } });
  });
  const response = await transport.request({ url: "https://example.invalid/repo.git/git-upload-pack", method: "POST", body: upload(), signal,
    headers: { "Content-Type": "application/x-git-upload-pack-request", Authorization: "Basic ZHVtbXk6ZHVtbXk=" },
    fetchOptions: { credentials: "include", headers: { "X-Extra": "preserved" } },
  });
  assert.equal(received, 0);
  assert.equal(response.statusCode, 201);
  assert.equal(response.statusMessage, "Created");
  assert.equal(response.headers["x-git-test"], "yes");
  const result = [];
  for await (const chunk of response.body) result.push(decode(chunk));
  assert.deepEqual(result, ["first", "second"]);
});

test("HTTP cancellation releases readers, empty/error responses and errors propagate", async () => {
  let canceled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(encode("chunk")); }, cancel() { canceled = true; } });
  const transport = createGitHttp(async () => new Response(stream));
  const { body } = await transport.request({ url: "https://example.invalid/repo.git" });
  for await (const chunk of body) { assert.equal(decode(chunk), "chunk"); break; }
  assert.ok(canceled);
  assert.ok(!stream.locked);
  const empty = await createGitHttp(async () => new Response(null, { status: 401 })).request({ url: "https://example.invalid/" });
  assert.equal(empty.statusCode, 401);
  for await (const _ of empty.body) assert.fail("empty response");
  await assert.rejects(createGitHttp(offline).request({ url: "https://example.invalid/" }), /Unexpected network/);
  await assert.rejects(createGitHttp(offline).request({ url: "https://dummy:dummy@example.invalid/" }), { code: "UnsafeGitUrl" });
});

test("upstream HTTP auth challenge uses explicit callbacks without saving credentials", async (t) => {
  const { fs, vfs } = await fixture(t);
  const oid = "1".repeat(40);
  const pkt = (line) => (encode(line).length + 4).toString(16).padStart(4, "0") + line;
  const advertisement = pkt("# service=git-upload-pack\n") + "0000" +
    pkt(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`) + pkt(`${oid} refs/heads/main\n`) + "0000";
  const events = [];
  let requests = 0;
  const git = createBrowserGit({ fs,
    fetch: async (url, init) => {
      requests++;
      assert.match(url, /info\/refs\?service=git-upload-pack$/);
      if (!init.headers.has("authorization")) return new Response(null, { status: 401 });
      assert.equal(init.headers.get("authorization"), "Basic ZHVtbXk6ZHVtbXk=");
      return new Response(advertisement, { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } });
    },
    onAuth: (url) => { events.push("auth"); assert.equal(url, "https://example.invalid/repo.git"); return { username: "dummy", password: "dummy" }; },
    onAuthSuccess: () => { events.push("success"); },
    onAuthFailure: () => { assert.fail("Unexpected auth failure"); },
  });
  await git.init();
  const result = await git.getRemoteInfo({ url: "https://example.invalid/repo.git" });
  assert.deepEqual(events, ["auth", "success"]);
  assert.equal(requests, 2);
  assert.equal(result.refs.heads.main, oid);
  for (const path of vfs.walk("/workspace/.git")) {
    if (vfs.info(path).kind === "file") assert.ok(!decode(await vfs.read(path)).includes("dummy"));
  }
});

test("HTTP request cancellation forwards iterator return and direct bytes remain unbuffered", async () => {
  let returned = false;
  const iterable = { [Symbol.asyncIterator]() { return {
    next: async () => ({ done: false, value: encode("chunk") }),
    return: async () => { returned = true; return { done: true }; },
  }; } };
  const transport = createGitHttp(async (_url, init) => {
    const reader = init.body.getReader();
    await reader.read();
    await reader.cancel("test cancellation");
    return new Response(null, { status: 204 });
  });
  await transport.request({ url: "https://example.invalid/", method: "POST", body: iterable });
  assert.ok(returned);
  const body = encode("bytes");
  await createGitHttp(async (_url, init) => {
    assert.equal(init.body, body);
    assert.equal(init.duplex, undefined);
    return new Response(null, { status: 204 });
  }).request({ url: "https://example.invalid/", method: "POST", body });
});

test("vendored artifacts match recorded SHA-256 and have no runtime imports", async () => {
  const root = new URL("../apps/browser/vendor/isomorphic-git/", import.meta.url);
  const lines = (await readFile(new URL("SHA256SUMS", root), "utf8")).trim().split("\n");
  for (const line of lines) {
    const [, expected, path] = /^(\S+)  (.+)$/.exec(line);
    assert.equal(createHash("sha256").update(await readFile(new URL(path, root))).digest("hex"), expected, path);
  }
  const bundle = await readFile(new URL("index.js", root), "utf8");
  assert.ok(!/^import\s/m.test(bundle));
  assert.ok(bundle.endsWith("export default module.exports;\n"));
});

// Explicit opt-in; never default CI network traffic. Use a small HTTP(S) repo
// without symlinks/executables, or noCheckout to inspect any fetched repository.
test("optional real remote clone smoke", { skip: !process.env.BROWSER_GIT_SMOKE_URL }, async (t) => {
  const { fs } = await fixture(t);
  const git = createBrowserGit({ fs, cwd: "/workspace/clone" });
  await git.clone({ url: process.env.BROWSER_GIT_SMOKE_URL, depth: 1, singleBranch: true, noCheckout: true });
  assert.equal((await git.log({ depth: 1 })).length, 1);
});

test("browser has no global Buffer: browser-git installs the vendored one and pkt-line/pack code works", async () => {
  // Node has a global Buffer, which hid a real-browser failure ("Missing Buffer dependency" during clone).
  // Run in a child process with Buffer removed before browser-git is imported.
  const { execFileSync } = await import("node:child_process");
  const code = `
    delete globalThis.Buffer;
    if (typeof globalThis.Buffer !== "undefined") throw new Error("could not remove Buffer");
    globalThis.crypto ??= (await import("node:crypto")).webcrypto;
    const { createBrowserGit } = await import(${JSON.stringify(new URL("../plugins/core-git/web/browser-git.js", import.meta.url).href)});
    const { Buffer } = await import(${JSON.stringify(new URL("../apps/browser/vendor/buffer/buffer.js", import.meta.url).href)});
    if (globalThis.Buffer !== Buffer) throw new Error("vendored Buffer not installed");
    // pkt-line parsing (the clone path that failed in Chromium) via a fake smart-HTTP discovery response.
    const pkt = (s) => (s.length + 4).toString(16).padStart(4, "0") + s;
    const oid = "a".repeat(40);
    const body = pkt("# service=git-upload-pack\\n") + "0000" + pkt(oid + " HEAD\\0side-band-64k symref=HEAD:refs/heads/main\\n") + pkt(oid + " refs/heads/main\\n") + "0000";
    const fetch = async () => new Response(new TextEncoder().encode(body), { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    const unused = async () => { throw new Error("fs not used by getRemoteInfo"); };
    const fs = { readFile: unused, writeFile: unused, stat: unused, readdir: unused, mkdir: unused, rm: unused };
    const git = createBrowserGit({ fs, fetch, cwd: "/workspace" });
    const info = await git.getRemoteInfo({ url: "https://example.invalid/repo.git" });
    if (info.refs.heads.main !== oid) throw new Error("unexpected refs " + JSON.stringify(info));
    console.log("ok");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.match(out, /ok/);
});
