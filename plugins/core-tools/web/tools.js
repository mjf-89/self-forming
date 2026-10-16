// core-tools implementation (moved verbatim from apps/common/native-tools.js, X2): the file
// and shell tool builders. Loaded lazily by the row (index.js load()), never at module evaluation
// of the registry. Library imports use the served paths.
import { createBashTool, createReadTool, createWriteTool, createEditTool } from "../../../library/pi-durable/tools.js";
const JAVASCRIPT_DESCRIPTION = "Run JavaScript in a fresh Web Worker (one call = one clean context; nothing carries over except files). Pass the code as `command`. The value of the last expression is printed; with top-level await, use console.log or return. Returns the console output (stdout = console.log, stderr = console.error/uncaught errors); a thrown error or process.exit(n) with n != 0 fails the call. Globals: fs (async, paths relative to the working folder: readFile(p, 'utf8'), writeFile, appendFile, readdir(p, {withFileTypes}), stat, exists, mkdir(p, {recursive}), rm(p, {recursive}), rename, copyFile, readJSON, writeJSON, glob(dir) = recursive file list), path (join, resolve, dirname, basename, extname, relative), process (cwd, chdir, env, argv, exit), sleep(ms), require('fs'|'path'), git (isomorphic-git bound to the working folder: clone, init, add, commit, log, status, statusMatrix, branch, checkout, fetch, pull, push, ...; see the JavaScript environment notes). Network: fetch and git go through the app's selected network provider (normally the Tailscale exit node or Tor), so CORS does not block them. Libraries: await import('https://esm.sh/<package>'). No shell, Node.js, npm or child processes. Await all asynchronous work: the worker stops when the code finishes. Optionally provide a timeout in seconds.";
const LINUX_DESCRIPTION = "Run a Bash command in a real Linux (Alpine, i686, GNU coreutils) emulated inside this browser tab. A string runs as `bash -c`; stdout and stderr are reported separately. /workspace is the same folder as your file tools, live (no copying): changes on either side are visible immediately, including to running servers, but each file operation there is slow. /scratch is a fast folder local to Linux that is wiped when the page reloads: put dependencies, build output, caches and large clones there. Each call has a fresh shell: cd and exports do not carry over. Network (apk add, curl, wget, git) goes through the app's selected route (Tailscale exit node or Tor). Installed packages and anything outside /workspace last until the page reloads. Commands run one at a time; pass a timeout in seconds for long jobs. A timeout or cancellation stops that command's processes (TERM, then KILL) without restarting Linux; processes it started in their own session (setsid, tmux) keep running. The first call starts Linux (a few seconds, ~24 MB download the first time).";
const BACKGROUND_NOTE = " Background processes can outlive a Bash call and remain running while the app is in the background. Start servers with stdin redirected from /dev/null and stdout/stderr to a log file; save the PID and verify with a separate command. Each call has a fresh shell: cd and exports do not carry to the next call. Cancellation stops that call's processes; Settings or the notification can stop the whole environment. Android process death or force-stop ends running processes; inspect before restarting.";
// Browser edition (E1): exactly one shell tool, matching the session's execution environment
// (execution@1, chosen in Settings → Providers): Linux -> `bash`, JavaScript -> `javascript`.
const SWITCH_TO_JS = " (The user can switch the execution environment to JavaScript in Settings → Providers; the conversation then reopens with it once you are idle.)";
const SWITCH_TO_LINUX = " (The user can switch the execution environment to Linux with Bash in Settings → Providers; the conversation then reopens with it once you are idle.)";
/** The shell of a browser session's environment: "bash" or "javascript" (env.shell, else JavaScript). */
export const browserShellOf = (env) => env?.shell?.language === "bash" ? "bash" : "javascript";
/** read, write, edit and the shell: bash, or in the browser edition the selected environment's shell. */
function fileAndShellTools({ hostInfo, env, injectSecrets = false, backgroundExecution = false } = {}) {
  const bash = createBashTool({ prepare: async (execution) => {
    if (injectSecrets) execution.env = { ...execution.env, PI_SECRET_SCOPE: "agent" };
  } });
  const browser = hostInfo?.platform === "browser";
  if (backgroundExecution) bash.description += BACKGROUND_NOTE;
  if (!browser) return [createReadTool(), createWriteTool(), createEditTool(), bash];
  const offersLinux = hostInfo?.capabilities?.linuxShell === true;
  const shell = browserShellOf(env) === "bash"
    ? { ...bash, description: LINUX_DESCRIPTION + SWITCH_TO_JS }
    : { ...bash, name: "javascript", description: JAVASCRIPT_DESCRIPTION + (offersLinux ? SWITCH_TO_LINUX : "") };
  return [createReadTool(), createWriteTool(), createEditTool(), shell];
}
export { fileAndShellTools };
