// exec-linux: the Bash shell of the browser edition's Linux execution environment (execution@1
// provider "exec-linux"): Alpine i686 in v86 (browser-v86.js, this folder), one VM per page,
// created on first use. The FileSystem half of the environment is core-execution's page VFS
// backend (browser-execution.js), which calls exec() with a per-run context. The guest
// /workspace is a live 9p mount of the page VFS /workspace (browser-v86.js; no copies: edits on
// either side are visible at once); /scratch is a fast VM-local directory, wiped with the VM.
// Both are allowed as cwd. Each file operation on /workspace costs about ten 9p round trips over
// the emulated NIC, so many-file work (dependencies, builds, caches) belongs in /scratch.
//
// Shell semantics (pi-durable Shell contract):
//   string -> `bash --noprofile --norc -c SOURCE` in the guest.
//   argv   -> argv[0] exec'd directly with the rest as its arguments (never shell text).
//   stdout/stderr are separate raw byte streams. Timeout/abort TERM, then KILL, the command's
//   own process group (the VM is never reset; unrelated guest processes such as tmux servers
//   survive). Processes that leave the group (setsid) are not tracked. An unconfirmed cancel
//   marks Linux unhealthy until the page reloads. Requires an image with bash.
// Guest network uses the page's selected transport (plain TCP; the guest does its own TLS),
// EXCEPT 192.168.86.1:564: that connection is served on the page by p9-server.js over this
// page's VFS /workspace (the live mount, see above and mountLive).
// Fixed bootstrap: browser-host.js creates this shell before composition, so recovery and
// composition share the ONE VM. Not editable through app revisions.
import { createP9Server, P9_HOST, P9_PORT } from "./p9-server.js";

const WORKSPACE = "/workspace";
const SCRATCH = "/scratch";          // VM-local fast directory (browser-v86.js creates it)
const failure = (code, message, path) => Object.assign(new Error(message), { code, path });
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const LINUX_SHELL = Object.freeze({ id: "bash", language: "bash", name: "Linux (Bash)" });

/**
 * createLinuxShell({ vfs, network, assets? }) -> { describe, exec(context), status, dispose() }.
 * context: { id, command, directory, env, timeout, output(stream, bytes|text), setCancel(fn) }.
 */
export function createLinuxShell({ vfs, network, assets = null, load = () => import("./browser-v86.js"), liveMount = null } = {}) {
  if (!vfs) throw new TypeError("The Linux shell needs the page VFS");
  let linuxEnv, p9;
  const status = { phase: "off" };
  const p9Server = () => p9 ??= createP9Server(vfs, { root: WORKSPACE });
  const linux = () => linuxEnv ??= Promise.resolve().then(load).then(({ createLinuxEnv }) => createLinuxEnv({
    vfs,
    transport: {
      connect: async (host, port, timeoutMs) => host === P9_HOST && port === P9_PORT
        ? p9Server().connect()
        : (await network).connect(host, port, { tls: false, timeoutMs }),
    },
    // Live /workspace: the guest mounts this page's VFS over 9p (browser-v86.js prepareWorkspace).
    live: {
      disconnects: () => p9Server().stats.disconnects,
      sync: () => p9Server().sync(),
      reset: () => p9?.closeAll(),
      ...(liveMount ? { mount: liveMount } : {}),
    },
    onStatus: (s) => Object.assign(status, s),
    ...(assets ? { assets } : {}),
  })).catch((cause) => { linuxEnv = undefined; throw cause; });

  async function exec({ command, directory, env = {}, timeout, output, setCancel }) {
    if (typeof command !== "string" && !Array.isArray(command)) throw failure("spawn_error", "A Linux command is a shell source string or an argv array");
    if (Array.isArray(command) && (!command.length || command[0] === "" || command.some((arg) => typeof arg !== "string"))) throw failure("spawn_error", "Linux argv must be a non-empty array of strings with a program name");
    if (typeof directory !== "string" || ![WORKSPACE, SCRATCH].some((root) => directory === root || directory.startsWith(`${root}/`))) throw failure("spawn_error", `Linux commands run inside ${WORKSPACE} or ${SCRATCH}`);
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME.test(name)) throw failure("spawn_error", `Invalid environment variable name: ${JSON.stringify(name)}`);
      if (typeof value !== "string" || value.includes("\0")) throw failure("spawn_error", `Environment variable ${name} must be a string without NUL`);
    }
    const controller = new AbortController();
    setCancel(() => controller.abort());
    const shell = await linux();
    if (status.phase !== "ready") output("stderr", "Starting Linux (first use downloads ~24 MB)…\n");
    await shell.ready();
    if (controller.signal.aborted) throw failure("aborted", "Command aborted");
    let result;
    try {
      result = await shell.run(command, { cwd: directory, env, onOutput: output, signal: controller.signal, timeoutMs: timeout ? timeout * 1000 : 0 });
    } catch (error) {
      if (error?.name === "AbortError") throw failure("aborted", "Command aborted");
      if (error?.code === "invalid") throw failure("spawn_error", error.message);
      if (error?.code === "LINUX_IMAGE_LACKS_BASH" || error?.code === "LINUX_IMAGE_LACKS_SETSID") throw failure("shell_unavailable", error.message);
      if (error?.code === "LINUX_UNHEALTHY") throw failure("shell_unavailable", error.message);
      if (error?.code === "LINUX_WORKSPACE_UNAVAILABLE") throw failure("shell_unavailable", error.message);   // retryable: the next command retries the mount
      throw error;
    }
    if (result.kernelOops) throw failure("shell_unavailable", "The Linux kernel crashed (oops) during this command, so its result cannot be trusted; reload the page to start a fresh Linux VM.");
    const unconfirmed = result.cancelConfirmed === false ? " (cancellation NOT confirmed; Linux is unhealthy until the page reloads)" : "";
    if (result.timedOut) throw failure("timeout", `Command timed out after ${timeout} seconds${unconfirmed}`);
    if (result.aborted || controller.signal.aborted) throw failure("aborted", `Command aborted${unconfirmed}`);
    if (result.spawnError) throw failure("spawn_error", result.spawnError);
    return { exitCode: result.exitCode };
  }

  /** Mount the page VFS /workspace live at guestPath (e.g. "/mnt/live"); remounts after a drop. */
  async function mountLive(guestPath, options) {
    const shell = await linux();
    await shell.ready();
    return shell.mountLive(guestPath, options);
  }

  return Object.freeze({
    describe: LINUX_SHELL,
    /** Guest-only cwd roots that are not page files (browser-execution.js skips its VFS check). */
    localRoots: Object.freeze([SCRATCH]),
    exec,
    mountLive,
    /** Guest diagnostics text for a command that does not finish (see browser-v86.js diagnose). */
    async diagnose(timeoutMs) { return linuxEnv ? (await linuxEnv).diagnose(timeoutMs) : "Linux is not running."; },
    /** The live /workspace mount of the running VM: { mode: "live"|"unmounted"|"unavailable", detail } or null. */
    async workspace() { return linuxEnv ? (await linuxEnv).workspace : null; },
    /** The page-side 9p server (created on first guest connection or first access). */
    get p9() { return p9Server(); },
    status,
    dispose() { void linuxEnv?.then((shell) => shell.dispose()).catch(() => {}); linuxEnv = undefined; p9?.closeAll(); },
  });
}
