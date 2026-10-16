// core-toolchain: the Android build tools (docs/plugins-providers-agent-core.md step C4).
// Self Forming-only built-in (bundle self-forming-tools, not essential): a fork leaves the
// folder out and the app simply never installs or announces the tools. The logic moved
// verbatim from session-engine.js: the `pi-android status` check, the detached background
// `pi-android install --accept-licenses` behind a flock guard (retried at the next start
// when it did not finish) and the "installed?" answer behind the welcome text.
// It starts on agent.harness@1 onSession when the handle's env has backgroundExecution,
// never in the browser, and ensures once per start (per handle). It provides
// toolchain@1 {installed(), ensure()} (app.js watchToolchain reads installed()). No
// library import.
export const TOOLCHAIN_SERVICE = "toolchain";
export const TOOLCHAIN_READY = "pi-android status 2>/dev/null | grep -q '^Android platform'";

let toolchainKnownReady = false;
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function toolchainStartCommand(workspace) {
  const dir = `${workspace}/.self-forming`;
  return [
    `mkdir -p ${shellQuote(dir)}`,
    `${TOOLCHAIN_READY} && exit 0`,
    `nohup flock -n ${shellQuote(`${dir}/toolchain.lock`)} sh -c 'exec >"$1" 2>&1; pi-android install --accept-licenses && pi-android doctor' sh ${shellQuote(`${dir}/toolchain.log`)} </dev/null >/dev/null 2>&1 &`,
    "exit 0"
  ].join("\n");
}
async function runQuiet(env, command, timeout, context) {
  let timer;
  try {
    const pending = env.exec(command, { timeout }, context);
    pending.catch(() => {
    });
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), (timeout + 5) * 1e3);
    });
    const result = await Promise.race([pending, limit]);
    return result.ok ? result.value.exitCode : void 0;
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
}

const isBrowser = () => globalThis.__piHostInfo?.platform === "browser";

/** The service over a source of the current harness handle (null while no session is open). */
export function createToolchainService(currentHandle) {
  const ensured = new WeakSet();
  return Object.freeze({
    /** true/false, or undefined when unknown (no environment, closed, browser, probe failed). */
    async installed() {
      const handle = currentHandle();
      const env = handle?.env;
      if (!env || isBrowser()) return void 0;
      const code = await runQuiet(env, TOOLCHAIN_READY, 20, handle.context);
      if (code === 0) toolchainKnownReady = true;
      return code === void 0 ? void 0 : code === 0;
    },
    /** Starts the detached background install if needed; once per session start. */
    async ensure() {
      const handle = currentHandle();
      const env = handle?.env;
      if (!env?.backgroundExecution || isBrowser() || toolchainKnownReady || ensured.has(handle)) return;
      ensured.add(handle);
      await runQuiet(env, toolchainStartCommand(env.cwd), 30, handle.context);
    }
  });
}

export function create() {
  return {
    setup(ctx) {
      const harness = ctx.get("agent.harness", 1);
      let handle = null;
      const service = createToolchainService(() => handle);
      ctx.provide(TOOLCHAIN_SERVICE, 1, service);
      if (!harness) return; // no sessions on this page: the service answers "unknown"
      const follow = (next) => {
        handle = next ?? null;
        if (handle?.env?.backgroundExecution) void service.ensure().catch(() => {
        });
      };
      ctx.cleanup(harness.onSession(follow));
      try { follow(harness.current()); } catch { /* not open yet */ }
    }
  };
}
