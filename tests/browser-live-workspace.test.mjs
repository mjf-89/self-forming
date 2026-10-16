// Live /workspace is the only mode of the browser Linux environment (browser-v86.js +
// linux-shell.js): the guest mounts the page VFS over 9p before commands, a failed mount fails the
// command with a clear retryable error (never runs it on a stale/empty /workspace) and the next
// command retries; /scratch is a valid cwd. Fake engine: NO VM is started here.
import test from "node:test";
import assert from "node:assert/strict";
import { Vfs, MemoryBackend } from "../plugins/core-execution/web/browser/browser-vfs.js";
import { createLinuxShell } from "../plugins/exec-linux/web/browser/linux-shell.js";
import { createBrowserExecution } from "../plugins/core-execution/web/browser/browser-execution.js";
import { createLinuxEnv, liveMountScript, WORKSPACE_UNAVAILABLE } from "../plugins/exec-linux/web/browser/browser-v86.js";

const te = new TextEncoder();
const isMount = (request) => request.mode === "shell" && /LIVE9P/.test(request.source);

/** A fake engine: mount requests answer from `plan` (array of "fail"|"mounted"|"ok"|"restarted"). */
function fakeEngine(plan, log) {
  let transport = null;
  const factory = async ({ transport: t }) => {
    transport = t;
    return {
      boot: async () => { log.push("boot"); },
      async exec(request, onOutput) {
        if (isMount(request)) {
          const step = plan.shift() ?? "ok";
          log.push(`mount:${step}`);
          if (step === "restarted") return { restarted: true };
          if (step === "fail") { onOutput("stderr", te.encode("LIVE9P error: mount failed\n")); return { exitCode: 4 }; }
          assert.match(request.source, /mkdir -p \/scratch/, "the mount step creates /scratch");
          onOutput("stdout", te.encode(`LIVE9P ${step}\n`));
          return { exitCode: 0 };
        }
        log.push(`run:${request.source ?? request.argv.join(" ")}@${request.cwd}`);
        if (request.source === "restart-me") return { restarted: true };
        return { exitCode: 0 };
      },
      cancelExec: async () => ({ confirmed: true }),
      dispose: async () => { log.push("dispose"); },
    };
  };
  return { factory, get transport() { return transport; } };
}
const assets = { stateBuffer: new ArrayBuffer(8) };   // skip loading the real snapshot

function liveHooks() {
  const hooks = { n: 0, syncs: 0, resets: 0, disconnects: () => hooks.n, sync: async () => { hooks.syncs++; }, reset: () => { hooks.resets++; } };
  return hooks;
}

test("mount failure fails the command with LINUX_WORKSPACE_UNAVAILABLE without running it; the next command retries", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  const live = liveHooks();
  const fake = fakeEngine(["fail", "mounted"], log);
  const env = createLinuxEnv({ vfs, live, assets, createEngine: fake.factory });
  await assert.rejects(env.run("echo hi"), (e) => e.code === WORKSPACE_UNAVAILABLE && e.retryable === true
    && /Linux could not mount \/workspace \(LIVE9P error: mount failed\)/.test(e.message) && /Try again/.test(e.message));
  assert.deepEqual(log, ["boot", "mount:fail"], "the command never ran against an unmounted /workspace");
  assert.equal(env.workspace.mode, "unavailable");
  assert.equal(live.syncs, 0);

  assert.equal((await env.run("echo hi")).exitCode, 0);
  assert.deepEqual(log.slice(2), ["mount:mounted", "run:echo hi@/workspace"]);
  assert.deepEqual(env.workspace, { mode: "live", detail: "mounted" });
  assert.equal(live.syncs, 1, "buffered guest writes are committed after each command");

  assert.equal((await env.run("ls", { cwd: "/scratch" })).exitCode, 0);
  assert.deepEqual(log.slice(4), ["run:ls@/scratch"], "no mount step while the connection is up");
  assert.equal(live.syncs, 2);

  live.n++;                                                 // the 9p connection dropped
  assert.equal((await env.run("pwd")).exitCode, 0);
  assert.deepEqual(log.slice(5), ["mount:ok", "run:pwd@/workspace"], "a disconnect triggers the probe/remount step");
  await env.dispose();
});

test("a VM restart forgets the mount and resets the 9p connections; the next command mounts again", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  const live = liveHooks();
  const env = createLinuxEnv({ vfs, live, assets, createEngine: fakeEngine(["mounted", "restarted", "mounted"], log).factory });
  assert.equal(live.resets, 0);
  assert.deepEqual(await env.run("restart-me"), { exitCode: 125, restarted: true });
  assert.equal(env.workspace.mode, "unmounted");
  assert.ok(live.resets >= 2, "boot and the restart reset the page 9p server connections");
  assert.deepEqual(await env.run("x"), { exitCode: 125, restarted: true }, "restart during the mount step");
  assert.equal((await env.run("y")).exitCode, 0);
  assert.deepEqual(log, ["boot", "mount:mounted", "run:restart-me@/workspace", "mount:restarted", "mount:mounted", "run:y@/workspace"]);
  await env.dispose();
});

test("without live hooks createLinuxEnv serves the page VFS itself on 192.168.86.1:564 and forwards other hosts", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  const fake = fakeEngine([], log);
  const dialed = [];
  const env = createLinuxEnv({ vfs, assets, createEngine: fake.factory, transport: { connect: async (h, p) => { dialed.push(`${h}:${p}`); return "upstream"; } } });
  assert.equal((await env.run("true")).exitCode, 0);
  const stream = await fake.transport.connect("192.168.86.1", 564, 1000);
  assert.equal(typeof stream.read, "function"); assert.equal(typeof stream.write, "function");
  stream.close();
  assert.equal(await fake.transport.connect("example.com", 80, 1000), "upstream");
  assert.deepEqual(dialed, ["example.com:80"], "the 9p connection never reaches the network");
  await env.dispose();
});

test("linux-shell: live hooks always wired, /workspace and /scratch are cwds, mount failure -> retryable shell_unavailable", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  let opts = null;
  const fake = fakeEngine(["fail", "mounted"], log);
  const load = async () => ({ createLinuxEnv: (o) => { opts = o; return createLinuxEnv({ ...o, assets, createEngine: fake.factory }); } });
  const shell = createLinuxShell({ vfs, network: Promise.resolve({ connect: async () => { throw new Error("no network in this test"); } }), load });
  const exec = (directory, command = "true") => shell.exec({ command, directory, env: {}, timeout: 5, output() {}, setCancel() {} });
  await assert.rejects(exec("/workspace"), (e) => e.code === "shell_unavailable" && /could not mount \/workspace/.test(e.message) && /Try again/.test(e.message));
  assert.deepEqual(await shell.workspace(), { mode: "unavailable", detail: "LIVE9P error: mount failed" });
  assert.equal((await exec("/scratch/build")).exitCode, 0);
  assert.equal((await exec("/workspace/a")).exitCode, 0);
  assert.deepEqual(log.filter((l) => l.startsWith("run:")), ["run:true@/scratch/build", "run:true@/workspace/a"]);
  assert.equal((await shell.workspace()).mode, "live");
  await assert.rejects(exec("/tmp"), (e) => e.code === "spawn_error" && e.message === "Linux commands run inside /workspace or /scratch");
  await assert.rejects(exec("/workspacex"), (e) => e.code === "spawn_error");
  const live = opts.live;
  assert.equal(typeof live.disconnects, "function"); assert.equal(typeof live.sync, "function");
  const before = live.disconnects();
  shell.p9.connect().close();
  assert.equal(live.disconnects(), before + 1, "a dropped 9p connection is visible to the remount check");
  await live.sync();
  assert.equal(shell.workspaceMode, undefined, "no copy/live mode switch any more");
  shell.dispose();
});

test("the timeout budget includes the mount step: spent before launch -> timed out, command not launched", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  const fake = fakeEngine([], log);
  const env = createLinuxEnv({ vfs, live: liveHooks(), assets, createEngine: async (o) => {
    const e = await fake.factory(o);
    const exec = e.exec;
    e.exec = async (request, onOutput) => { if (isMount(request)) await new Promise((r) => setTimeout(r, 60)); return exec(request, onOutput); };
    return e;
  } });
  const r = await env.run("sleep 600", { timeoutMs: 20 });
  assert.equal(r.exitCode, 124); assert.equal(r.timedOut, true); assert.equal(r.cancelConfirmed, true);
  assert.deepEqual(log, ["boot", "mount:ok"], "not launched");
  assert.equal((await env.run("true", { timeoutMs: 5000 })).exitCode, 0);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(env.run("never", { signal: ac.signal }), (e) => e.name === "AbortError");
  assert.deepEqual(log.slice(2), ["run:true@/workspace"]);
  await env.dispose();
});

test("page backend: /scratch is a valid Linux cwd although it is not a page folder; other missing folders are refused", async () => {
  const vfs = await Vfs.open({ backend: new MemoryBackend() });
  const log = [];
  const fake = fakeEngine([], log);
  const load = async () => ({ createLinuxEnv: (o) => createLinuxEnv({ ...o, assets, createEngine: fake.factory }) });
  const backend = createBrowserExecution({ vfs, emit: () => {}, shells: { bash: createLinuxShell({ vfs, network: null, load }) } });
  const call = (params) => backend.methods["env.exec"]({ id: `x${Math.random()}`, owner: "t", shell: "bash", ...params });
  assert.deepEqual(await call({ command: "pwd", cwd: "/scratch/build" }), { exitCode: 0 });
  await assert.rejects(call({ command: "pwd", cwd: "/workspace/missing" }), (e) => e.code === "spawn_error" && /does not exist/.test(e.message));
  await assert.rejects(call({ command: "pwd", cwd: "/scratchy" }), (e) => e.code === "spawn_error");
  assert.deepEqual(log.filter((l) => l.startsWith("run:")), ["run:pwd@/scratch/build"]);
  backend.dispose();
});

test("liveMountScript: prepare step and cache option are validated", () => {
  const s = liveMountScript("/workspace", { prepare: "mkdir -p /scratch" });
  assert.match(s, /^mkdir -p \/scratch\n/);
  assert.match(s, /cache=none,msize=524288 192\.168\.86\.1 "\$p"/);
  assert.match(liveMountScript("/mnt/x", { cache: "mmap" }), /cache=mmap,/);
  assert.throws(() => liveMountScript("/mnt/x", { cache: "none;reboot" }), /cache mode/);
});
