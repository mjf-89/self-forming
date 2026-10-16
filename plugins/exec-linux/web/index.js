// exec-linux: the browser edition's Linux execution environment, a provider of execution@1
// (step E1; chosen with the other provider in Settings → Providers → Execution environment).
// open(cwd?, {owner}?) returns the full pi-durable ExecutionEnv (FileSystem + Shell):
// FileSystem = the page VFS backend owned by core-execution (the same files as every other
// tool); Shell = Bash in Alpine Linux (v86, i686) inside the tab (a string runs as bash -c, argv is exec'd directly; separate stdout/stderr; /workspace synced around each command; cancel stops the command's process group without resetting the VM).
// The environment describes itself as env.shell = {id: "bash", language, name}; consumers
// (core-tools, core-prompt, core-servers) read that instead of any command-level selector.
// Browser only: plugin-builtins.js registers it in the browser edition with the opener
// `createExecution` it is given (core-execution's page-bridge environment, called with this
// shell). The shell implementation (web/browser/linux-shell.js) is created once per page by the
// fixed browser host and shared with the bundled recovery path; this entry imports nothing at
// evaluation. Switching providers reopens the page session in place once no conversation is
// working (core-agent, agent-sessions.js reopenWhenIdle): new environment, shell tool and prompt.
export const PROVIDER_ID = "exec-linux";
export const SHELL_ID = "bash";
export const NAME = "Linux (Bash)";
export const HINT = "real programs and Bash in an in-tab Alpine VM; slower, ~24 MB first download";
export const NOT_AVAILABLE = "This page has no in-tab Linux (linuxShell).";

/** True when the page offers this shell (host.info capabilities). */
export const offered = (hostInfo) => hostInfo?.platform === "browser" && hostInfo?.capabilities?.executionEnv === true && hostInfo?.capabilities?.linuxShell === true;

/** The runtime definition parts: provides execution@1 over createExecution({..., shell}). */
export function create({ createExecution, bridge, hostInfo, owner } = {}) {
  if (typeof createExecution !== "function") throw new TypeError("exec-linux needs core-execution's createExecution");
  const execution = createExecution({ bridge, hostInfo, owner, shell: SHELL_ID });
  return {
    name: NAME,
    hint: HINT,
    setup(ctx) {
      ctx.provide("execution", 1, Object.freeze({
        shell: SHELL_ID,
        available: () => offered(hostInfo),
        open(...args) {
          if (ctx.signal.aborted) throw new Error(`${NAME} is stopped`);
          if (!offered(hostInfo)) throw new Error(NOT_AVAILABLE);
          return execution.open(...args);
        }
      }));
    }
  };
}
