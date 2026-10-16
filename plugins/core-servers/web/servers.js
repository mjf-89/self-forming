// plugins/core-servers/web/servers.js (moved from apps/common/servers.js, X2)
import { Type, validateToolArguments } from "../../../library/pi-ai.js";
import { defineDoc, defineExtension, defineTask, defineTool } from "../../../library/pi-durable.js";
import { withAbortSignal } from "../../../library/chord/context.js";
var SERVER_TASK_KIND = "self-forming.server";
var SERVERS_DOC_KIND = "self-forming.servers";
var ServersDoc = defineDoc({
  kind: SERVERS_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ servers: {} })
});
var DEFAULT_TIMING = {
  intervalMs: 2e4,
  // pause between health checks of a healthy server
  backoffMs: [2e3, 5e3, 15e3, 3e4, 6e4],
  // pause before restart n (the n-th consecutive failure)
  maxFailures: 6,
  // consecutive failures after which the task ends as failed
  defaultGraceMs: 1e4,
  // time a fresh process gets before its first check
  execTimeoutSec: 15,
  // limit of every shell command
  logTailLines: 20,
  // log lines attached to the final error
  stopGraceMs: 5e3,
  // time the server's processes get between TERM and KILL when it is stopped or restarted
  stopPollMs: 500,
  // how often a stop call looks for a failed cleanup while it waits
  postponeMs: 5e3
  // browser: pause before repeating a check that the Linux VM could not run (busy, starting)
};
var NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
var MAX_CAPTURE = 64 * 1024;
var MAX_LOG_LINES = 500;
var q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
var sessionOf = (taskId) => `srv-${taskId}`;
var errorText = (error) => error instanceof Error ? error.message : String(error);
var clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
// Browser edition: servers need the session's execution environment (execution@1, Settings → Providers) to be the
// Linux one (env.shell.language "bash", exec-linux). browserServersEnv(env) checks that and marks the environment for
// the browser paths; with the JavaScript environment every servers operation fails with BROWSER_NEEDS_BASH. Commands
// are passed through unchanged (no added variables). Android sessions use their environment unchanged.
var BROWSER = Symbol("self-forming servers: browser Linux environment");
var BROWSER_NEEDS_BASH = "Background servers need Bash, but this conversation's execution environment is not Linux (it cannot run Bash). Select \"Linux (Bash)\" in Settings → Providers → Execution environment; the conversation switches in place once the agent is idle.";
// Guest-only state of browser servers (scripts, logs, pid files, secrets stub): outside /workspace, so it never reaches
// the page files (a stale pid file must not survive into a fresh VM) and ends with the VM like the processes.
var BROWSER_STATE_DIR = "/var/lib/sf-servers";
var wrappedEnvs = /* @__PURE__ */ new WeakMap();
function browserServersEnv(env) {
  if (!env || env[BROWSER]) return env;
  if (env.shell?.language !== "bash") throw new Error(BROWSER_NEEDS_BASH);
  let wrapped = wrappedEnvs.get(env);
  if (!wrapped) {
    wrapped = Object.freeze({
      [BROWSER]: true,
      shell: env.shell,
      get cwd() {
        return env.cwd;
      },
      exec: (command, options, context) => env.exec(command, options, context)
    });
    wrappedEnvs.set(env, wrapped);
  }
  return wrapped;
}
var isBrowserEnv = (env) => env?.[BROWSER] === true;
var isBrowserHost = (hostInfo) => hostInfo?.platform === "browser";
// One id per page (shared by every copy of this module): the browser VM lives exactly as long as the page. A Server task
// checkpoint that names another id was supervising a process of an earlier page load, which ended with that page.
var pageVm = () => globalThis.__sfServersPageVm ??= `vm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
var BROWSER_LIFETIME = "Browser edition: servers run inside this tab's Linux VM (Alpine); they stop when the tab is closed or reloaded and are started again when the app is opened again. Their ports are reachable only from commands inside that VM (e.g. curl http://127.0.0.1:<port>/); the browser has no preview of guest ports. Logs live inside the VM only. Service secrets are not supported in the browser edition.";
var BROWSER_SECRETS_UNSUPPORTED = "service secrets are not supported in the browser edition (no secret broker); run this server without secrets";
function normalizeHealth(value) {
  if (value === void 0 || value === null || value === "" || value === 0 || value === "none") return void 0;
  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`health port must be 1-65535, got ${value}.`);
    return port;
  }
  const url = String(value).trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("health must be a port number or an http(s) URL.");
  return url;
}
function healthCommand(health) {
  if (typeof health === "number") return `curl -sS -m 3 -o /dev/null http://127.0.0.1:${health}/`;
  return `curl -fsS -m 3 -o /dev/null ${q(health)}`;
}
async function execIn(env, context, command, timeoutSec, extraEnv) {
  let out = "";
  const controller = new AbortController();
  const signal = context.abortSignal ? AbortSignal.any([controller.signal, context.abortSignal]) : controller.signal;
  const pending = env.exec(command, {
    timeout: timeoutSec,
    ...extraEnv ? { env: extraEnv } : {},
    onOutput: (text) => {
      out = (out + text).slice(-MAX_CAPTURE);
    }
  }, withAbortSignal(signal, context));
  pending.catch(() => {
  });
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Command did not finish in ${timeoutSec}s: ${clip(command, 80)}`));
    }, (timeoutSec + 5) * 1e3);
  });
  try {
    const result = await Promise.race([pending, limit]);
    if (!result.ok) {
      if (result.error?.code === "aborted" && context.abortSignal?.aborted) throw result.error;
      return { ok: false, code: -1, out, error: result.error?.message ?? String(result.error?.code ?? "exec failed") };
    }
    return { ok: result.value.exitCode === 0, code: result.value.exitCode, out };
  } finally {
    clearTimeout(timer);
  }
}
var SECRETS_WAIT_SEC = 20;
var SECRETS_PENDING_MAX_SEC = SECRETS_WAIT_SEC + 25;
var START_ENV = { PI_SECRET_SCOPE: "servers" };
var SECRETS_UNAVAILABLE = "secrets unavailable: ";
var servicesDirOf = (workspace, browser) => browser ? BROWSER_STATE_DIR : `${workspace}/.services`;
var pathsOf = (input, browser = false) => ({
  script: `${servicesDirOf(input.workspace, browser)}/${input.name}.sh`,
  log: `${servicesDirOf(input.workspace, browser)}/logs/${input.name}.log`,
  // Browser: a stub that reports that secrets are unsupported (BROWSER_SECRETS_SCRIPT).
  sfSecrets: browser ? `${BROWSER_STATE_DIR}/bin/sf-secrets` : `${input.workspace}/.tools/bin/sf-secrets`,
  // Exists while the launcher waits for the secret broker (a fingerprint answer); the supervisor then does not count a failed health check.
  waitFile: `${servicesDirOf(input.workspace, browser)}/logs/${input.name}.secrets-wait`,
  // One line "secrets unavailable: <reason>" when the last launch could not get its secrets (never values); absent otherwise.
  secretsState: `${servicesDirOf(input.workspace, browser)}/logs/${input.name}.secrets`
});
// The secret helper (source: scripts/sf-secrets.sh, kept identical by tests/plugin-servers-fix-secrets.test.mjs).
// Installed as <workspace>/.tools/bin/sf-secrets before every launch (helperInstallScript).
var SF_SECRETS_SCRIPT = `#!/bin/sh
# sf-secrets-version: 1
# sf-secrets: fetch the service secrets enabled for this command's scope from the Self Forming
# secret broker (SecretBroker.kt) and hand them to a shell. Installed by manage_server
# (servers.js) as <workspace>/.tools/bin/sf-secrets; the source is scripts/sf-secrets.sh.
#
#   sf-secrets --exports [--label TEXT] [--wait SECONDS]
#       stdout: one \`export NAME='value'\` line per delivered secret (single-quote escaped),
#       nothing else. Use: eval "$(sf-secrets --exports --label 'My server')"
#   sf-secrets --names [--label TEXT] [--wait SECONDS]
#       stdout: the delivered names only (never values), one per line.
#
# Needs SF_SECRETS_URL and SF_SECRETS_TOKEN (set by the app for terminal, server and agent
# commands). Without them it prints nothing and exits 0. --wait is how long the broker may
# wait for a fingerprint answer (default 20, broker maximum 120).
# Diagnostics go to stderr and never contain values. Names that were not delivered are
# reported as one stderr line starting with "sf-secrets: secrets unavailable: ".
# Exit status: 0 broker answered (some names may still be unavailable, see stderr);
# 1 secrets unavailable (reason on stderr); 2 usage error.
set -u

mode=
label=
wait=20
say() { printf 'sf-secrets: %s\\n' "$*" >&2; }
unavailable() { say "secrets unavailable: $*"; exit 1; }
usage() { say "usage: sf-secrets --exports|--names [--label TEXT] [--wait SECONDS]"; exit 2; }

while [ $# -gt 0 ]; do
  case $1 in
    --exports) mode=exports ;;
    --names) mode=names ;;
    --label) [ $# -ge 2 ] || usage; label=$2; shift ;;
    --label=*) label=\${1#--label=} ;;
    --wait) [ $# -ge 2 ] || usage; wait=$2; shift ;;
    --wait=*) wait=\${1#--wait=} ;;
    -h|--help) mode=help ;;
    *) usage ;;
  esac
  shift
done
if [ "$mode" = help ]; then
  sed -n '3,20s/^# \\{0,1\\}//p' "$0" >&2
  exit 0
fi
[ -n "$mode" ] || usage
case $wait in
  ''|*[!0-9.]*|*.*.*|.) usage ;;
esac

# Not running under the app (or a scope without secrets): nothing to do.
[ -n "\${SF_SECRETS_URL:-}" ] && [ -n "\${SF_SECRETS_TOKEN:-}" ] || exit 0

command -v curl >/dev/null 2>&1 || unavailable "curl is not installed"
command -v jq >/dev/null 2>&1 || unavailable "jq is not installed"
case $SF_SECRETS_URL in
  http://127.0.0.1:[0-9]*|http://localhost:[0-9]*) ;;
  *) unavailable "SF_SECRETS_URL is not a loopback broker address" ;;
esac
case $SF_SECRETS_TOKEN in
  *[!A-Za-z0-9._~+/=-]*) unavailable "SF_SECRETS_TOKEN has an unexpected format" ;;
esac

query_label=$(printf '%s' "\${label:-A Linux command}" | jq -sRr '@uri') || unavailable "could not encode the label"
url="\${SF_SECRETS_URL%/}/v1/env?label=\${query_label}&wait=\${wait}"
max_time=$(awk -v w="$wait" 'BEGIN { w += 0; if (w > 120) w = 120; printf "%d", w + 15 }')

# The token goes through curl's config on stdin (printf is a shell builtin), never argv.
attempt=0
while :; do
  attempt=$((attempt + 1))
  answer=$(printf 'header = "Authorization: Bearer %s"\\n' "$SF_SECRETS_TOKEN" |
    curl -sS -K - --max-time "$max_time" --connect-timeout 5 -w '\\n%{http_code}' -- "$url" 2>/dev/null)
  code=$?
  status=\${answer##*
}
  body=\${answer%
*}
  if [ "$code" -ne 0 ]; then
    case $code in
      7) reason="the secret broker is not reachable at $SF_SECRETS_URL (was the app restarted? restart this process)" ;;
      28) reason="the secret broker did not answer within \${max_time}s" ;;
      *) reason="request to the secret broker failed (curl exit $code)" ;;
    esac
    [ "$code" -eq 7 ] && [ "$attempt" -lt 3 ] && { sleep 1; continue; }
    unavailable "$reason"
  fi
  case $status in
    200) break ;;
    503) [ "$attempt" -lt 3 ] && { sleep 1; continue; }; unavailable "the secret broker is busy (HTTP 503)" ;;
    401) unavailable "the secret broker refused the token (HTTP 401; the app was probably restarted since this process started: restart it)" ;;
    *) unavailable "the secret broker answered HTTP $status" ;;
  esac
done

# Validate the shape before printing anything, so stdout is all-or-nothing.
printf '%s' "$body" | jq -e '(.values | type == "object") and ([.values[] | type == "string"] | all)' >/dev/null 2>&1 ||
  unavailable "the secret broker sent an unexpected answer"

NAMES='[.values | keys[] | select(test("^[A-Za-z_][A-Za-z0-9_]*$"))]'
if [ "$mode" = exports ]; then
  out=$(printf '%s' "$body" | jq -r '.values | to_entries[] | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) | "export \\(.key)=\\(.value | @sh)"') ||
    unavailable "could not format the secrets"
  [ -z "$out" ] || printf '%s\\n' "$out"
  unset out
else
  printf '%s' "$body" | jq -r "$NAMES | .[]"
fi

delivered=$(printf '%s' "$body" | jq -r "$NAMES | join(\\", \\")")
skipped=$(printf '%s' "$body" | jq -r '[.values | keys[] | select(test("^[A-Za-z_][A-Za-z0-9_]*$") | not)] | length')
denied=$(printf '%s' "$body" | jq -r '[.denied[]? | strings] | join(", ")')
locked=$(printf '%s' "$body" | jq -r '[.locked[]? | strings] | join(", ")')
unset body answer
[ -n "$delivered" ] && say "delivered: $delivered" || say "no secrets are enabled for this scope"
[ "$skipped" = 0 ] || say "skipped $skipped secret(s) with names that are not shell variable names"
missing=
[ -z "$denied" ] || missing="declined or not answered in time: $denied"
[ -z "$locked" ] || missing="\${missing:+$missing; }cannot be unlocked (no fingerprint or screen lock available): $locked"
[ -z "$missing" ] || say "secrets unavailable: $missing"
exit 0
`;
// Browser edition: no secret broker. The stub keeps commands that call sf-secrets working with a clear reason (stderr, the
// server's status through SF_SECRETS_STATE) instead of "command not found"; it never prints values (there are none).
var BROWSER_SECRETS_SCRIPT = `#!/bin/sh
# sf-secrets (browser edition): there is no secret broker in the browser edition. Installed by manage_server.
SF_MSG='${SECRETS_UNAVAILABLE}${BROWSER_SECRETS_UNSUPPORTED}'
printf 'sf-secrets: %s\\n' "$SF_MSG" >&2
if [ -n "\${SF_SECRETS_STATE:-}" ]; then printf '%s\\n' "$SF_MSG" > "$SF_SECRETS_STATE" 2>/dev/null; fi
exit 1
`;
// Identity of one launch's process tree ("pid starttime sid sidstarttime" of the launcher), for stop.
var pidFileOf = (workspace, session, browser = false) => `${servicesDirOf(workspace, browser)}/run/${session}.pid`;
// Browser launcher: same process identity record and log handling; instead of the broker, a note in the log, the stub on PATH.
function browserSecretsLines(input) {
  const { secretsState } = pathsOf(input, true);
  return [
    `rm -f ${q(secretsState)}`,
    `echo "secrets: not supported in the browser edition (no secret broker); this server runs without service secrets" >> "$LOG"`,
    `SF_SECRETS_STATE=${q(secretsState)}; export SF_SECRETS_STATE`,
    `PATH=${q(`${BROWSER_STATE_DIR}/bin`)}:"$PATH"; export PATH`,
    `unset SF_STAT SF_ID SF_SID SF_SIDSTART`
  ];
}
function launcherScript(input, session, { browser = false } = {}) {
  const { log, sfSecrets, waitFile, secretsState } = pathsOf(input, browser);
  const dir = servicesDirOf(input.workspace, browser);
  return [
    "#!/bin/sh",
    `# ${session}: generated by self-forming manage_server; rewritten at every start.`,
    `LOG=${q(log)}`,
    `mkdir -p ${q(`${dir}/logs`)} ${q(`${dir}/run`)}`,
    `if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi`,
    `echo "=== $(date '+%F %T') starting ${input.name}" >> "$LOG"`,
    // Record which processes are this server's (stop also finds them after the tmux session is gone).
    `read -r SF_STAT < /proc/$$/stat; set -f; set -- \${SF_STAT##*\\) }; SF_SID=$4; SF_ID="$$ \${20} $4"; SF_SIDSTART=\${20}`,
    `if [ "$SF_SID" != "$$" ]; then SF_SIDSTART=; if [ "$SF_SID" -gt 1 ] 2>/dev/null && [ -r "/proc/$SF_SID/stat" ] && read -r SF_STAT < "/proc/$SF_SID/stat"; then set -- \${SF_STAT##*\\) }; SF_SIDSTART=\${20}; fi; fi`,
    `set +f; set --; echo "$SF_ID $SF_SIDSTART" > ${q(pidFileOf(input.workspace, session, browser))}`,
    ...browser ? [...browserSecretsLines(input), `cd ${q(input.cwd)} || { echo "cannot cd to the working directory" >> "$LOG"; exit 1; }`, `exec bash -lc ${q(input.command)} >> "$LOG" 2>&1`, ""] : androidSecretsLines()
  ].join("\n");
  function androidSecretsLines() {
    return [
      // Secrets for this server through the broker (SF_SECRETS_URL/TOKEN from the tmux session environment).
      `SF_HELPER=${q(sfSecrets)}`,
      `SF_STATE=${q(secretsState)}`,
      `WAITFILE=${q(waitFile)}`,
      `SF_REASON=`,
      `rm -f "$SF_STATE"`,
      `if [ -z "\${SF_SECRETS_URL:-}" ] || [ -z "\${SF_SECRETS_TOKEN:-}" ]; then`,
      `  echo "secrets: none (no secret broker in this environment)" >> "$LOG"`,
      `elif [ ! -x "$SF_HELPER" ]; then`,
      `  SF_REASON="the helper $SF_HELPER is missing"`,
      `else`,
      `  : > "$WAITFILE"`,
      `  SF_EXPORTS=$("$SF_HELPER" --exports --label ${q(`Server ${input.name}`)} --wait ${SECRETS_WAIT_SEC} 2> "$SF_STATE.err"); SF_RC=$?`,
      `  rm -f "$WAITFILE"`,
      `  cat "$SF_STATE.err" >> "$LOG" 2>/dev/null`,
      `  SF_REASON=$(sed -n 's/^sf-secrets: ${SECRETS_UNAVAILABLE}//p' "$SF_STATE.err" 2>/dev/null | sed -n '$p')`,
      `  rm -f "$SF_STATE.err"`,
      `  if [ "$SF_RC" -eq 0 ]; then eval "$SF_EXPORTS" || SF_REASON="\${SF_REASON:+$SF_REASON; }the helper output could not be applied"`,
      `  elif [ -z "$SF_REASON" ]; then SF_REASON="sf-secrets failed (exit $SF_RC)"; fi`,
      `  unset SF_EXPORTS`,
      `fi`,
      `if [ -n "$SF_REASON" ]; then echo "${SECRETS_UNAVAILABLE}$SF_REASON" >> "$LOG"; printf '${SECRETS_UNAVAILABLE}%s\\n' "$SF_REASON" > "$SF_STATE"; fi`,
      `unset SF_REASON SF_RC SF_STAT SF_ID SF_SID SF_SIDSTART SF_HELPER SF_STATE`,
      `cd ${q(input.cwd)} || { echo "cannot cd to the working directory" >> "$LOG"; exit 1; }`,
      `exec bash -lc ${q(input.command)} >> "$LOG" 2>&1`,
      ""
    ];
  }
}
/** Installs or refreshes <workspace>/.tools/bin/sf-secrets (mode 0700) when it is missing or differs. Never fails the caller. */
function helperInstallScript(workspace, { browser = false } = {}) {
  const bin = browser ? `${BROWSER_STATE_DIR}/bin` : `${workspace}/.tools/bin`;
  const helper = `${bin}/sf-secrets`;
  const eof = "__SF_SECRETS_HELPER_EOF__";
  return [
    `SF_H=${q(helper)}; SF_T="$SF_H.new.$$"`,
    `if mkdir -p ${q(bin)} && cat > "$SF_T" <<'${eof}'`,
    `${browser ? BROWSER_SECRETS_SCRIPT : SF_SECRETS_SCRIPT}${eof}`,
    `then if [ -x "$SF_H" ] && cmp -s "$SF_T" "$SF_H"; then rm -f "$SF_T"; else chmod 700 "$SF_T" && mv -f "$SF_T" "$SF_H" || { rm -f "$SF_T"; echo "sf-secrets could not be installed" >&2; }; fi`,
    `else rm -f "$SF_T"; echo "sf-secrets could not be installed" >&2; fi`,
    "true"
  ].join("\n");
}
var missingSession = /^(?:no server running on |no sessions$|no current target$|can't find session: |error connecting to .+ \((?:No such file or directory|Connection refused)\))/m;
async function sessionExists(env, context, session, timeoutSec, socket = "-L sf-servers") {
  const result = await execIn(env, context, `tmux ${socket} has-session -t ${q(`=${session}`)} 2>&1`, timeoutSec);
  if (result.ok) return true;
  if (result.code === 1 && missingSession.test(result.out.trim())) return false;
  throw new Error(`Cannot inspect tmux session ${session}: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
}
var TMUX_PREP = `U=$(awk '/^Uid:/{print $2}' /proc/self/status); getent passwd "$U" >/dev/null || echo "aid_$U:x:$U:$U::/nonexistent:/usr/sbin/nologin" >> /etc/passwd; if tmux -L sf-servers ls 2>&1 | grep -q "access not allowed"; then pkill -f "[t]mux -L sf-servers" 2>/dev/null; sleep 0.3; fi; `;
var STOP_GRACE_MS = 5e3;
var sessionSockets = (session) => ["-L sf-servers", "", `-L ${q(session)}`];
// Lists the live processes of one server, "pid:starttime:pgid:sid" per line, from /proc (works in PRoot; no ps/pstree).
// Members: the given roots ("pid:start", start empty = trust the pid, e.g. a tmux pane pid) and all their descendants, plus
// every process of a given process group or session ("id:start"). A group id counts only while its leader is a root, has the
// recorded start time, or no longer exists (the kernel never reuses a pid that still names a group or session). Never lists
// the scanning shell, its ancestors or descendants, pid 0/1, zombies, or members found only through a group or session
// that the scanning shell or one of its ancestors belongs to (the app's own command groups).
var TREE_AWK = `{
  i = length($0); while (i > 0 && substr($0, i, 1) != ")") i--
  n = split(substr($0, i + 2), f, " "); if (n < 20) next
  p = $1 + 0; st[p] = f[1]; pp[p] = f[2] + 0; pg[p] = f[3] + 0; sd[p] = f[4] + 0; t0[p] = f[20]
}
END {
  self += 0; ex[self] = 1; a = self
  while ((a in pp) && pp[a] > 1 && !(pp[a] in ex)) { a = pp[a]; ex[a] = 1 }
  for (a in ex) { if (a in pg) bad[pg[a]] = 1; if (a in sd) bad[sd[a]] = 1 }
  ds[self] = 1; c = 1; while (c) { c = 0; for (p in pp) if (!(p in ds) && (pp[p] in ds)) { ds[p] = 1; c = 1 } }
  n = split(roots, r, " ")
  for (k = 1; k <= n; k++) { split(r[k], x, ":"); p = x[1] + 0; if (p > 1 && (p in pp) && (x[2] == "" || x[2] == t0[p])) mk[p] = 1 }
  n = split(groups, r, " ")
  for (k = 1; k <= n; k++) {
    split(r[k], x, ":"); g = x[1] + 0
    if (g <= 1 || (g in bad)) continue
    if (!(g in pp) || (g in mk) || (x[2] != "" && x[2] == t0[g])) gr[g] = 1
  }
  for (p in pp) if ((pg[p] in gr) || (sd[p] in gr)) mk[p] = 1
  c = 1; while (c) { c = 0; for (p in pp) if (!(p in mk) && (pp[p] in mk)) { mk[p] = 1; c = 1 } }
  for (p in mk) if (!(p in ex) && !(p in ds) && st[p] != "Z" && st[p] != "X" && p + 0 > 1) print p ":" t0[p] ":" pg[p] ":" sd[p]
}`;
/**
 * Shell for one step of a verified stop (POSIX sh, coreutils/BusyBox only). Roots: the pane pids of the session on every
 * socket, the launcher identity in pidFile (missing for servers launched before it existed) and `known` entries from an
 * earlier step. mode "stop": TERM every member, wait up to graceMs, KILL survivors (repeatedly, up to 2 s). mode "check":
 * only list. Prints "sf-tree found: <entries>" (everything seen) and "sf-tree alive: <entries>"; "check" removes the
 * pidFile once nothing is left.
 */
function treeScript({ mode, session, sockets, pidFile, known = [], graceMs = STOP_GRACE_MS }) {
  const steps = Math.max(1, Math.ceil(graceMs / 250));
  return [
    `SF_AWK=${q(TREE_AWK)}`,
    `SF_R=''; SF_G=''; SF_SEEN=''; SF_TERMED=''; SF_L=''`,
    `sf_num() { case $1 in ''|*[!0-9]*) return 1;; esac; }`,
    // Adds an entry "pid:start:pgid:sid" as a root (that very process) and its group and session (see TREE_AWK).
    `sf_add() { p=\${1%%:*}; r=\${1#*:}; t=\${r%%:*}; r=\${r#*:}; SF_R="$SF_R $p:$t"; SF_G="$SF_G \${r%%:*}: \${r#*:}:"; }`,
    ...sockets.map((socket) => `for p in $(tmux ${socket} list-panes -s -t ${q(`=${session}`)} -F '#{pane_pid}' 2>/dev/null); do sf_num "$p" && SF_R="$SF_R $p:" && SF_G="$SF_G $p:"; done`),
    ...pidFile ? [
      `SF_PIDFILE=${q(pidFile)}`,
      `if [ -r "$SF_PIDFILE" ] && read -r a b c d < "$SF_PIDFILE" && sf_num "$a" && sf_num "$b"; then SF_R="$SF_R $a:$b"; SF_G="$SF_G $a:$b"; if sf_num "$c"; then sf_num "$d" || d=; SF_G="$SF_G $c:$d"; fi; fi`
    ] : [],
    ...known.length ? [`for e in ${known.map((entry) => q(entry)).join(" ")}; do sf_add "$e"; done`] : [],
    // Rescans add what they find, so children of members are never lost when a member exits first.
    `sf_scan() { SF_L=$(cat /proc/[0-9]*/stat 2>/dev/null | awk -v self="$$" -v roots="$SF_R" -v groups="$SF_G" "$SF_AWK"); for e in $SF_L; do SF_SEEN="$SF_SEEN $e"; sf_add "$e"; done; }`,
    // Signals a listed process only while it is still the same process (start time unchanged).
    `sf_signal() { s=$1; shift; for e in "$@"; do p=\${e%%:*}; t=\${e#*:}; t=\${t%%:*}; [ -r "/proc/$p/stat" ] || continue; [ "$(sed 's/.*) //' "/proc/$p/stat" 2>/dev/null | cut -d' ' -f20)" = "$t" ] && kill -"$s" "$p" 2>/dev/null; done; return 0; }`,
    // TERM once per process (a second TERM makes some servers skip their clean shutdown).
    `sf_term() { for e in $SF_L; do case " $SF_TERMED " in *" $e "*) ;; *) SF_TERMED="$SF_TERMED $e"; sf_signal TERM "$e";; esac; done; }`,
    "sf_scan",
    ...mode === "stop" ? [
      `if [ -n "$SF_L" ]; then`,
      `  sf_term; i=0`,
      `  while [ -n "$SF_L" ] && [ $i -lt ${steps} ]; do sleep 0.25; sf_scan; sf_term; i=$((i + 1)); done`,
      `  i=0; while [ -n "$SF_L" ] && [ $i -lt 8 ]; do sf_signal KILL $SF_L; sleep 0.25; sf_scan; i=$((i + 1)); done`,
      `fi`
    ] : [
      `[ -n "$SF_L" ] || [ -z "\${SF_PIDFILE:-}" ] || rm -f "$SF_PIDFILE"`
    ],
    `echo "sf-tree found: $(printf '%s\\n' $SF_SEEN | sort -u | tr '\\n' ' ')"`,
    `echo "sf-tree alive: $(printf '%s\\n' $SF_L | sort -u | tr '\\n' ' ')"`
  ].join("\n");
}
function parseTree(out) {
  const field = (name) => (out.match(new RegExp(`^sf-tree ${name}:(.*)$`, "m"))?.[1] ?? "").split(/\s+/).filter((entry) => /^\d+:\d*:\d*:\d*$/.test(entry));
  return { found: field("found"), alive: field("alive") };
}
// Health endpoints this phone serves itself: a port, or an http(s) URL on loopback. A remote URL may answer without this server.
var localHealth = (health) => typeof health === "number" || typeof health === "string" && /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(health);
var pidsOf = (entries) => [...new Set(entries.map((entry) => entry.split(":")[0]))].join(", ");
async function treeStep(env, context, options, timeoutSec) {
  const result = await execIn(env, context, treeScript(options), timeoutSec);
  if (!result.ok) throw new Error(`Cannot inspect the processes of ${options.session}: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
  return parseTree(result.out);
}
/**
 * Verified stop of one server: TERM its whole process tree (and process group/session), wait graceMs, KILL survivors,
 * kill the tmux session, then verify that no member is alive and (when something of the server existed) that its health
 * endpoint no longer answers. One retry; then throws with the surviving pids. target: {workspace, health} of the server
 * (both optional), graceMs and sockets (tests: a private tmux socket). Never signals a process outside the tree.
 */
async function killSessionIn(env, context, session, timeoutSec, target = {}) {
  try {
    await ensureTmux(env, context);
  } catch (error) {
    // Browser: without tmux in the image no server of ours could ever have started; there is nothing to stop.
    if (isBrowserEnv(env) && error?.message === BROWSER_TMUX_MISSING) return;
    throw error;
  }
  const sockets = target.sockets ?? sessionSockets(session);
  const graceMs = target.graceMs ?? STOP_GRACE_MS;
  const pidFile = isBrowserEnv(env) ? pidFileOf(target.workspace, session, true) : target.workspace ? pidFileOf(target.workspace, session) : void 0;
  const stopTimeoutSec = timeoutSec + Math.ceil(graceMs / 1e3) + 10;
  let known = [];
  let problem;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const stopped = await treeStep(env, context, { mode: "stop", session, sockets, pidFile, known, graceMs }, stopTimeoutSec);
    known = [.../* @__PURE__ */ new Set([...known, ...stopped.found])];
    let hadSession = false;
    for (const socket of sockets) {
      if (!await sessionExists(env, context, session, timeoutSec, socket)) continue;
      hadSession = true;
      const result = await execIn(env, context, `tmux ${socket} kill-session -t ${q(`=${session}`)} 2>&1`, timeoutSec);
      if (await sessionExists(env, context, session, timeoutSec, socket)) {
        throw new Error(`tmux session ${session} is still running: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
      }
    }
    // Nothing of this server existed (no session, no process): there is nothing to verify, and a listener on its port is not ours.
    if (!hadSession && !known.length && attempt === 1) return;
    const checked = await treeStep(env, context, { mode: "check", session, sockets, pidFile, known }, timeoutSec + 10);
    known = [.../* @__PURE__ */ new Set([...known, ...checked.found])];
    if (checked.alive.length) {
      problem = `process(es) ${pidsOf(checked.alive)} of ${session} are still alive after TERM and KILL`;
      continue;
    }
    if (localHealth(target.health) && (await execIn(env, context, healthCommand(target.health), timeoutSec)).ok) {
      problem = `health endpoint ${target.health} still answers, but no process of ${session} is left${known.length ? ` (stopped: ${pidsOf(known)})` : ""}; whatever answers is not part of this server and was not touched`;
      continue;
    }
    return;
  }
  throw new Error(`Stop of ${session} is not verified: ${problem}.`);
}
var TMUX_INSTALL_TIMEOUT_SEC = 300;
var TMUX_INSTALL = [
  "command -v tmux >/dev/null 2>&1 && exit 0",
  "export DEBIAN_FRONTEND=noninteractive",
  "exec 9>/tmp/sf-tmux-install.lock; flock 9 2>/dev/null || true",
  "command -v tmux >/dev/null 2>&1 && exit 0",
  "apt-get install -y -q tmux >/tmp/sf-tmux-install.log 2>&1 || { apt-get update -q >>/tmp/sf-tmux-install.log 2>&1 && apt-get install -y -q tmux >>/tmp/sf-tmux-install.log 2>&1; }",
  "command -v tmux >/dev/null 2>&1 || { tail -n 5 /tmp/sf-tmux-install.log; exit 1; }"
].join("\n");
// Browser edition: never installs packages for servers. The image must already contain tmux (and bash, curl, procps).
var BROWSER_TMUX_CHECK = [
  "command -v tmux >/dev/null 2>&1 || { echo 'this Linux image lacks tmux'; exit 1; }",
  // Servers and their health checks use 127.0.0.1, but the VM image boots with the loopback interface down.
  "ip link set lo up 2>/dev/null || ifconfig lo 127.0.0.1 up 2>/dev/null || true"
].join("\n");
var BROWSER_TMUX_MISSING = "Background servers need tmux, but this Linux image lacks tmux. The browser edition does not install packages for servers; use a Linux image that includes tmux.";
// Checked once per execution environment on Android (no longer once per page). In the browser it is checked before every
// use: the in-page VM can be replaced (reload, reset) without the environment object changing, and the check is one command.
var tmuxReady = /* @__PURE__ */ new WeakMap();
async function ensureTmux(env, context) {
  if (isBrowserEnv(env)) {
    const checked = await execIn(env, context, BROWSER_TMUX_CHECK, TMUX_INSTALL_TIMEOUT_SEC);
    if (checked.ok) return;
    if (checked.code === 1 && /lacks tmux/.test(checked.out)) throw new Error(BROWSER_TMUX_MISSING);
    throw new Error(`Cannot check for tmux in the browser's Linux: ${clip(checked.out.trim() || checked.error || `exit ${checked.code}`, 300)}`);
  }
  if (tmuxReady.has(env)) return;
  const result = await execIn(env, context, TMUX_INSTALL, TMUX_INSTALL_TIMEOUT_SEC);
  if (!result.ok) throw new Error(`tmux is missing and could not be installed: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
  tmuxReady.set(env, true);
}
async function launchSession(env, context, input, session, { timeoutSec } = {}) {
  await ensureTmux(env, context);
  const browser = isBrowserEnv(env);
  const { script } = pathsOf(input, browser);
  const dir = servicesDirOf(input.workspace, browser);
  const eof = `__PI_SERVER_${session}_EOF__`;
  const write = await execIn(
    env,
    context,
    `mkdir -p ${q(`${dir}/logs`)} ${q(`${dir}/run`)} && cat > ${q(script)} <<'${eof}' || exit 1
${launcherScript(input, session, { browser })}${eof}
${helperInstallScript(input.workspace, { browser })}`,
    timeoutSec
  );
  if (!write.ok) throw new Error(`Could not write the launcher script: ${clip(write.out.trim() || write.error || `exit ${write.code}`, 300)}`);
  // Browser: no secret broker (no update-environment of its variables, no secret scope); the guest runs as root.
  const tmuxStart = browser ? `tmux -L sf-servers start-server \\; set-option -g exit-empty off; tmux -L sf-servers new-session -d -s ${q(session)} -c ${q(input.cwd)} ${q(`sh ${q(script)}`)}` : `tmux -L sf-servers start-server \\; set-option -g exit-empty off; tmux -L sf-servers server-access -a "aid_$U" 2>/dev/null; ` + [
    "tmux -L sf-servers set-option -g update-environment " + q("SF_SECRETS_URL SF_SECRETS_TOKEN"),
    `new-session -d -s ${q(session)} -c ${q(input.cwd)} ${q(`sh ${q(script)}`)}`
  ].join(" \\; ");
  const started = await execIn(
    env,
    context,
    `${TMUX_PREP}${tmuxStart} 2>&1`,
    timeoutSec,
    browser ? void 0 : START_ENV
  );
  if (!started.ok) throw new Error(`tmux could not start ${session}: ${clip(started.out.trim() || started.error || `exit ${started.code}`, 300)}`);
}
var stoppedByCaller = (runtime, context) => runtime.signal.aborted || context.abortSignal?.aborted === true;
var ServerConflict = class extends Error {
};
// Browser: a supervision check that could not run (the VM was busy, starting or timed out); not a verdict on the server.
var CheckPostponed = class extends Error {
};
/**
 * The supervised-server implementation of one app session: the durable task Server
 * (kind self-forming.server), the manage_server tool and manage(args, api, context),
 * the one code path behind both the tool and servers@1 (servers-service.js).
 * Returns {extension, tools, tasks, manage, validate}; extension is the permanent
 * "self-forming-servers" (core-servers contributes its tools and tasks, A4).
 * validate(args) checks servers@1 input against the tool schema, as pi-durable does
 * for a tool call (throws with the same message).
 */
function createServers({ rootConversationId, abortTask, timing: timingOptions, hostInfo } = {}) {
  // Browser edition (hostInfo.platform "browser", Linux environment): every environment is checked by browserServersEnv, state
  // lives in the VM only, no secrets, tab-bound lifetime. Commands queue behind other Linux commands of the tab, so they
  // get a longer limit there, and a check that could not run (busy or slow Linux) postpones the check instead of counting
  // as a failure.
  const browser = isBrowserHost(hostInfo);
  const timing = { ...DEFAULT_TIMING, ...browser ? { execTimeoutSec: 60 } : {}, ...timingOptions };
  const backoffFor = (failures) => timing.backoffMs[Math.min(Math.max(failures, 1), timing.backoffMs.length) - 1];
  const paths = (input) => pathsOf(input, browser);
  const bind = (env) => browser ? browserServersEnv(env) : env;
  const envOf = async (runtime, context) => bind(await runtime.env(context));
  const shell = async (runtime, context, command, timeoutSec, extraEnv) => {
    const env = await envOf(runtime, context);
    if (!env) throw new Error("No execution environment is available.");
    return execIn(env, context, command, timeoutSec, extraEnv);
  };
  const logTail = async (runtime, context, input, lines) => {
    try {
      const result = await shell(runtime, context, `tail -n ${lines} -- ${q(paths(input).log)} 2>/dev/null`, timing.execTimeoutSec);
      return result.out.trim();
    } catch (error) {
      if (stoppedByCaller(runtime, context)) throw error;
      return "";
    }
  };
  const hasSession = async (runtime, context, session) => {
    const env = await envOf(runtime, context);
    if (!browser) return sessionExists(env, context, session, timing.execTimeoutSec);
    try {
      return await sessionExists(env, context, session, timing.execTimeoutSec);
    } catch (error) {
      if (stoppedByCaller(runtime, context)) throw error;
      throw new CheckPostponed(errorText(error));
    }
  };
  const stopTarget = (input) => ({ workspace: input?.workspace, health: input?.health, graceMs: timing.stopGraceMs });
  const killSession = async (runtime, context, session, input) => killSessionIn(await envOf(runtime, context), context, session, timing.execTimeoutSec, stopTarget(input));
  const healthy = async (runtime, context, health) => {
    const result = await shell(runtime, context, healthCommand(health), timing.execTimeoutSec);
    // Browser: the command did not run at all (Linux busy, timed out, VM starting): no verdict about the server.
    if (browser && !result.ok && result.code === -1) throw new CheckPostponed(`health check could not run: ${result.error}`);
    return result.ok;
  };
  const secretsPending = async (runtime, context, input) => {
    if (browser) return false;
    const file = q(paths(input).waitFile);
    return (await shell(runtime, context, `[ -f ${file} ] && [ $(( $(date +%s) - $(stat -c %Y ${file}) )) -lt ${SECRETS_PENDING_MAX_SEC} ]`, timing.execTimeoutSec)).ok;
  };
  async function startSession(runtime, context, input, session) {
    const env = await envOf(runtime, context);
    if (!env) throw new Error("No execution environment is available.");
    await launchSession(env, context, input, session, { timeoutSec: timing.execTimeoutSec });
  }
  const checkpointOf = (checkpoint, change) => {
    const next = { ...checkpoint, ...change };
    for (const key of Object.keys(next)) if (next[key] === void 0) delete next[key];
    return next;
  };
  async function fail(runtime, context, task, reason) {
    const input = task.input;
    const session = sessionOf(runtime.taskId);
    const checkpoint = task.state.checkpoint;
    const failures = (checkpoint.failures ?? 0) + 1;
    await killSession(runtime, context, session, input);
    let detail = "";
    try {
      detail = await logTail(runtime, context, input, failures >= timing.maxFailures ? timing.logTailLines : 5);
    } catch (error) {
      if (stoppedByCaller(runtime, context)) throw error;
    }
    if (failures >= timing.maxFailures || checkpoint.conflict) {
      const message = clip(`${input.name} failed: ${reason}${detail ? `
Last log lines:
${detail}` : ""}`, 4e3);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), context);
      return;
    }
    const lastError = clip(`${reason}${detail ? ` | log: ${detail.split("\n").slice(-3).join(" / ")}` : ""}`, 700);
    await runtime.commit(() => ({
      status: "running",
      checkpoint: checkpointOf(checkpoint, {
        phase: "ensure",
        failures,
        restarts: (checkpoint.restarts ?? 0) + 1,
        nextCheckAt: runtime.now() + backoffFor(failures),
        lastError,
        external: void 0,
        healthyAt: void 0,
        cleanupReason: void 0,
        cleanupFailures: void 0
      })
    }), context);
  }
  async function guarded(task, runtime, context, body) {
    try {
      await body();
    } catch (error) {
      if (stoppedByCaller(runtime, context)) return;
      // Browser: the conversation's execution environment is (now) JavaScript. Not a failure of the
      // server: its process keeps running in the tab's Linux VM; supervision waits in the same phase
      // until the environment is Linux again (Settings → Providers switches it in place).
      if (browser && errorText(error) === BROWSER_NEEDS_BASH) {
        await runtime.commit(() => ({ status: "running", checkpoint: checkpointOf(task.state.checkpoint, { nextCheckAt: runtime.now() + timing.postponeMs, lastError: clip(`Waiting for Linux: ${BROWSER_NEEDS_BASH}`, 700) }) }), context);
        return;
      }
      try {
        await fail(runtime, context, { ...task, state: { ...task.state, checkpoint: { ...task.state.checkpoint, conflict: error instanceof ServerConflict || task.state.checkpoint.conflict } } }, errorText(error));
      } catch (second) {
        if (stoppedByCaller(runtime, context)) return;
        const checkpoint = task.state.checkpoint;
        const cleanupFailures = (checkpoint.cleanupFailures ?? 0) + 1;
        const next = {
          status: "running",
          checkpoint: checkpointOf(checkpoint, {
            phase: "cleanup",
            cleanupFailures,
            nextCheckAt: runtime.now() + backoffFor(cleanupFailures),
            cleanupReason: checkpoint.cleanupReason ?? errorText(error),
            conflict: error instanceof ServerConflict || checkpoint.conflict || void 0,
            lastError: clip(`Cleanup pending: ${errorText(second)}`, 700),
            healthyAt: void 0
          })
        };
        await runtime.commit(() => next, context).catch((third) => {
          if (!stoppedByCaller(runtime, context)) runtime.report(third);
        });
      }
    }
  }
  const Server = defineTask({
    name: SERVER_TASK_KIND,
    version: 2,
    migrate(input, checkpoint, fromVersion) {
      if (fromVersion !== 1) throw new Error(`Unsupported server task version ${fromVersion}.`);
      return { input, checkpoint: checkpointOf(checkpoint, {
        // Older tasks could merely observe an arbitrary listener. Require ownership before supervising again.
        ...checkpoint.external ? { phase: "ensure", nextCheckAt: 0, healthyAt: void 0 } : {},
        external: void 0
      }) };
    },
    initial: (input) => ({ phase: "ensure", nextCheckAt: 0, restarts: 0, failures: 0 }),
    phases: {
      // Make sure the tmux session exists (after the backoff), then give it its start grace.
      ensure: (task, runtime, context) => guarded(task, runtime, context, async () => {
        const { input } = task;
        const checkpoint = task.state.checkpoint;
        const session = sessionOf(runtime.taskId);
        if (checkpoint.nextCheckAt > runtime.now()) await runtime.sleep(checkpoint.nextCheckAt, context);
        await ensureTmux(await envOf(runtime, context), context);
        if (!await hasSession(runtime, context, session)) {
          await killSession(runtime, context, session, input);
          if (input.health !== void 0 && await healthy(runtime, context, input.health)) {
            throw new ServerConflict(`Health endpoint ${input.health} is already answering outside ${session}. Stop that process explicitly or choose a free port; it has not been adopted or restarted.`);
          }
          await startSession(runtime, context, input, session);
        }
        await runtime.commit(() => ({
          status: "running",
          checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: runtime.now() + input.startGraceMs, external: void 0, ...browser ? { vm: pageVm() } : {} })
        }), context);
      }),
      cleanup: (task, runtime, context) => guarded(task, runtime, context, async () => {
        if (task.state.checkpoint.nextCheckAt > runtime.now()) await runtime.sleep(task.state.checkpoint.nextCheckAt, context);
        await fail(runtime, context, task, task.state.checkpoint.cleanupReason ?? "process cleanup failed");
      }),
      // Sleep until the next check, then check the session and the health; healthy → next check, else restart.
      watch: (task, runtime, context) => guarded(task, runtime, context, async () => {
        const { input } = task;
        const checkpoint = task.state.checkpoint;
        const session = sessionOf(runtime.taskId);
        // Browser: this task supervised a process of an earlier page load (that VM ended with the page). Start it again
        // in this page's VM right away; that is not a failure of the server.
        if (browser && checkpoint.vm !== pageVm()) {
          await runtime.commit(() => ({
            status: "running",
            checkpoint: checkpointOf(checkpoint, { phase: "ensure", nextCheckAt: 0, healthyAt: void 0, vm: void 0, lastError: "The browser tab was closed or reloaded, which stopped the previous process; starting it again." })
          }), context);
          return;
        }
        if (checkpoint.nextCheckAt > runtime.now()) await runtime.sleep(checkpoint.nextCheckAt, context);
        let problem;
        let waitingForSecrets = false;
        try {
          if (!await hasSession(runtime, context, session)) problem = "the process exited (tmux session ended)";
          else if (input.health !== void 0 && !await healthy(runtime, context, input.health)) {
            if (await secretsPending(runtime, context, input)) waitingForSecrets = true;
            else problem = `health check failed (${input.health})`;
          }
        } catch (error) {
          if (!(error instanceof CheckPostponed)) throw error;
          await runtime.commit(() => ({ status: "running", checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: runtime.now() + timing.postponeMs, lastError: clip(`Check postponed (the Linux VM did not run it): ${error.message}`, 700) }) }), context);
          return;
        }
        if (problem !== void 0) throw new Error(problem);
        if (waitingForSecrets) {
          await runtime.commit(() => ({ status: "running", checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: runtime.now() + 3e3 }) }), context);
          return;
        }
        const at = runtime.now();
        await runtime.commit(() => ({
          status: "running",
          checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: at + timing.intervalMs, failures: 0, healthyAt: at, external: void 0 })
        }), context);
      })
    },
    abort: async (task, runtime, context) => {
      let checkpoint = task.state.checkpoint;
      for (; ; ) {
        try {
          if (checkpoint.nextCleanupAt > runtime.now()) await runtime.sleep(checkpoint.nextCleanupAt, context);
          await killSession(runtime, context, sessionOf(runtime.taskId), task.input);
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
          return;
        } catch (error) {
          if (stoppedByCaller(runtime, context)) return;
          const cleanupFailures = (checkpoint.cleanupFailures ?? 0) + 1;
          checkpoint = checkpointOf(checkpoint, { cleanupFailures, nextCleanupAt: runtime.now() + backoffFor(cleanupFailures), lastError: clip(`Stop pending: ${errorText(error)}`, 700) });
          await runtime.commit(() => ({ status: "running", checkpoint }), context);
        }
      }
    }
  });
  const reply = (text, details) => ({ content: [{ type: "text", text }], ...details ? { details } : {} });
  const isLive = (record) => record !== void 0 && record.state.status !== "terminal";
  function describe(name, entry, record) {
    const session = sessionOf(entry.taskId);
    const hint = browser ? `output: manage_server logs, or tmux -L sf-servers capture-pane -p -t ${session} in bash` : `tmux -L sf-servers attach -t ${session}`;
    const settings = `${entry.command}${entry.cwd ? ` (in ${entry.cwd})` : ""}${entry.health !== void 0 ? ` \xB7 health ${entry.health}` : ""}`;
    const state = record?.state;
    let label;
    let restarts = 0;
    let lastError;
    if (!state) label = "unknown (task record missing)";
    else if (state.status === "terminal") {
      const outcome = state.outcome;
      if (outcome.status === "aborted" || entry.stoppedAt) label = "stopped";
      else if (outcome.status === "failed") {
        label = "failed";
        lastError = outcome.error?.message;
      } else if (outcome.status === "completed") label = "stopped";
      else {
        label = `failed (task ${outcome.status})`;
        lastError = outcome.error?.message ?? outcome.reason;
      }
    } else if (state.status === "completing" || record.abortRequested) {
      label = "stopping";
      lastError = state.checkpoint?.lastError;
    } else {
      const checkpoint = state.checkpoint ?? {};
      restarts = checkpoint.restarts ?? 0;
      lastError = checkpoint.lastError;
      if (checkpoint.phase === "cleanup") label = "cleanup pending";
      else if (browser && checkpoint.phase === "watch" && checkpoint.vm !== pageVm()) label = "restarting (the browser tab was closed or reloaded, which stopped the previous process)";
      else if (checkpoint.phase === "ensure" && (checkpoint.failures ?? 0) > 0) {
        const wait = Math.max(0, Math.round((checkpoint.nextCheckAt - Date.now()) / 1e3));
        label = `backing off (failure ${checkpoint.failures}, restarting in ${wait}s)`;
      } else if (checkpoint.phase === "watch" && checkpoint.healthyAt !== void 0 && (checkpoint.failures ?? 0) === 0) {
        label = "running";
      } else label = "starting";
    }
    const live = label !== "stopped" && !label.startsWith("failed");
    const lines = [`${name}: ${label}${state && state.status !== "terminal" ? ` \xB7 restarts ${restarts}` : ""} \xB7 ${settings}`];
    if (live && state) lines.push(`  session ${session} \xB7 ${hint}`);
    else lines.push(`  (task ${entry.taskId}; session ${session} is not running)`);
    if (lastError) lines.push(`  last error: ${clip(lastError, 1500)}`);
    return { text: lines.join("\n"), label, restarts, session };
  }
  // One code path for both callers: the manage_server tool (pi-durable tool api) and
  // servers@1 (servers-service.js, with an equivalent api over the session harness).
  async function manage(args, api, context) {
    const { action } = args;
    const env = bind(api.env);
    const workspaceOf = async () => {
      const root = env?.cwd ?? (await api.agent(context)).cwd;
      if (!root) throw new Error("No workspace directory is available.");
      return String(root).replace(/\/+$/, "");
    };
    const registry = async () => (await api.snapshot(ServersDoc, context))?.servers ?? {};
    const entryOf = (servers, name) => Object.hasOwn(servers, name) ? servers[name] : void 0;
    const needName = () => {
      if (!args.name) throw new Error(`${action} needs a name.`);
      if (!NAME_PATTERN.test(args.name)) throw new Error("name must be 1-40 letters, digits, dot, dash or underscore, starting with a letter or digit.");
      return args.name;
    };
    if (action === "status") {
      const servers = await registry();
      const names = args.name === void 0 ? Object.keys(servers).sort() : [args.name];
      if (!names.length) return reply(`No servers. Start one with manage_server start.${browser ? `\n${BROWSER_LIFETIME}` : ""}`);
      const lines = [];
      const details = {};
      const rows = [];
      for (const name of names) {
        const entry = entryOf(servers, name);
        if (!entry) {
          rows.push({ text: `${name}: no such server` });
          continue;
        }
        const record = await api.getTask(entry.taskId, context);
        const info = describe(name, entry, record);
        rows.push({ name, text: info.text, live: info.label !== "stopped" && !info.label.startsWith("failed"), workspace: record?.input?.workspace });
        details[name] = { taskId: entry.taskId, state: info.label, restarts: info.restarts, session: info.session };
      }
      const secrets = await secretsProblems(rows.filter((row) => row.live && row.workspace));
      for (const row of rows) {
        lines.push(row.text);
        const problem = row.name !== void 0 ? secrets.get(row.name) : void 0;
        if (problem) {
          lines.push(`  ${problem}`);
          details[row.name].secrets = problem;
        }
      }
      if (browser) lines.push(BROWSER_LIFETIME);
      return reply(lines.join("\n"), details);
    }
    if (action === "logs") {
      const name = needName();
      const entry = entryOf(await registry(), name);
      if (!entry) throw new Error(`No server named ${name}.`);
      if (!env) throw new Error("No execution environment is available.");
      const count = Math.min(Math.max(args.lines ?? 50, 1), MAX_LOG_LINES);
      const log = paths({ workspace: await workspaceOf(), name }).log;
      const result = await execIn(env, context, `if [ -f ${q(log)} ]; then tail -n ${count} -- ${q(log)}; else echo "(no log yet: ${log.replace(/["$`\\]/g, "")})"; fi`, timing.execTimeoutSec);
      return reply(result.out.trim() || "(log is empty)", { name, lines: count });
    }
    if (action === "stop" || action === "restart") {
      const name = needName();
      const servers = await registry();
      const entry = entryOf(servers, name);
      if (!entry) throw new Error(`No server named ${name}.${action === "restart" ? " Use start." : ""}`);
      const stopped = await stopServer(name, entry);
      if (action === "stop") return reply(stopped, { name, taskId: entry.taskId });
      return startServer(name, { ...entry, ...overrides(args, entry) }, true, stopped);
    }
    if (action === "start") {
      const name = needName();
      if (!args.command?.trim()) throw new Error("start needs a command.");
      return startServer(name, { command: args.command.trim(), cwd: args.cwd, health: normalizeHealth(args.health), startGraceSeconds: args.startGraceSeconds }, false);
    }
    throw new Error(`Unknown action ${action}.`);
    // "secrets unavailable: <reason>" lines the launchers of running servers left (no values ever reach these files).
    async function secretsProblems(rows) {
      const found = /* @__PURE__ */ new Map();
      if (!rows.length || !env) return found;
      const command = rows.map((row, index) => `f=${q(paths(row).secretsState)}; [ -s "$f" ] && printf '%s\\t%s\\n' ${index} "$(sed -n 1p "$f")"`).join("; ") + "; true";
      try {
        const result = await execIn(env, context, command, timing.execTimeoutSec);
        for (const line of result.out.split("\n")) {
          const match = /^(\d+)\t(secrets unavailable: .*)$/.exec(line);
          if (match && rows[Number(match[1])]) found.set(rows[Number(match[1])].name, clip(match[2], 500));
        }
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
      }
      return found;
    }
    function overrides(given, entry) {
      const next = {};
      if (given.command?.trim()) next.command = given.command.trim();
      if (given.cwd) next.cwd = given.cwd;
      if (given.health !== void 0) next.health = normalizeHealth(given.health);
      if (given.startGraceSeconds !== void 0) next.startGraceMs = Math.round(given.startGraceSeconds * 1e3);
      else next.startGraceMs = entry.startGraceMs;
      return next;
    }
    async function stopServer(name, entry) {
      const record = await api.getTask(entry.taskId, context);
      if (isLive(record)) {
        if (!abortTask) throw new Error("This session cannot stop servers (no abortTask hook).");
        const before = record.state.checkpoint?.cleanupFailures ?? 0;
        await abortTask(entry.taskId, context);
        await waitStopped(name, entry.taskId, before);
      } else if (env) {
        await killSessionIn(env, context, sessionOf(entry.taskId), timing.execTimeoutSec, stopTarget(record?.input ?? { workspace: await workspaceOf().catch(() => void 0), health: entry.health }));
      }
      const wasLive = isLive(record);
      const at = Date.now();
      if (wasLive || entry.stoppedAt === void 0) {
        await api.commit(async (tx) => {
          const doc = await tx.doc(ServersDoc);
          const current = Object.hasOwn(doc.servers, name) ? doc.servers[name] : void 0;
          if (current && current.taskId === entry.taskId && current.stoppedAt === void 0) doc.servers[name] = { ...entry, stoppedAt: at };
        }, context);
      }
      if (wasLive) return `Stopped ${name} (tmux session ${sessionOf(entry.taskId)} killed).`;
      return entry.stoppedAt !== void 0 ? `${name} was already stopped.` : `${name} was not running (${describe(name, entry, record).label}); marked stopped.`;
    }
    // The task's abort verifies the cleanup and keeps retrying it; the caller learns about a failed attempt instead of
    // waiting through every retry (and a restart never starts on top of a server that is still alive).
    async function waitStopped(name, taskId, before) {
      const done = api.waitForTask(taskId, context).then(() => true);
      done.catch(() => {
      });
      for (; ; ) {
        let timer;
        const tick = new Promise((resolve) => {
          timer = setTimeout(resolve, timing.stopPollMs, false);
        });
        const finished = await Promise.race([done, tick]).finally(() => clearTimeout(timer));
        if (finished) return;
        const current = await api.getTask(taskId, context);
        if (!isLive(current)) return void await done;
        const checkpoint = current.state.checkpoint ?? {};
        if ((checkpoint.cleanupFailures ?? 0) > before) {
          throw new Error(`${name} is not stopped yet: ${String(checkpoint.lastError ?? "cleanup failed").replace(/[.\s]+$/, "")}. The stop is retried in the background; check status before starting it again.`);
        }
      }
    }
    async function startServer(name, wanted, restarting, prefix) {
      const workspace = await workspaceOf();
      const cwd = wanted.cwd ? (wanted.cwd.startsWith("/") ? wanted.cwd : `${workspace}/${wanted.cwd}`).replace(/\/+$/, "") || "/" : workspace;
      const settings = { command: wanted.command, cwd, ...wanted.health !== void 0 ? { health: wanted.health } : {} };
      const startGraceMs = wanted.startGraceMs ?? (wanted.startGraceSeconds !== void 0 ? Math.round(wanted.startGraceSeconds * 1e3) : timing.defaultGraceMs);
      const outcome = await api.commit(async (tx) => {
        const doc = await tx.doc(ServersDoc);
        const current = Object.hasOwn(doc.servers, name) ? doc.servers[name] : void 0;
        const task = current ? await tx.task(current.taskId) : void 0;
        if (current && task && task.state.status !== "terminal") {
          const same = current.command === settings.command && current.cwd === settings.cwd && current.health === settings.health;
          return same ? { existing: { ...current }, task } : { conflict: { ...current } };
        }
        const input = { name, workspace, ...settings, startGraceMs };
        const taskId = await tx.createTask(Server, input, {
          ownership: { kind: "conversation" },
          background: true,
          conversationId: rootConversationId
        });
        doc.servers[name] = { taskId, ...settings, startGraceMs, createdAt: Date.now() };
        return { created: taskId };
      }, context);
      if (outcome.conflict) {
        throw new Error(`${name} is already running with different settings (command: ${outcome.conflict.command}, cwd: ${outcome.conflict.cwd}${outcome.conflict.health !== void 0 ? `, health: ${outcome.conflict.health}` : ""}). Use restart to change them.`);
      }
      if (outcome.existing) {
        const info = describe(name, outcome.existing, outcome.task);
        return reply(`${name} is already running with these settings; nothing to do.
${info.text}`, { name, taskId: outcome.existing.taskId, existing: true });
      }
      const session = sessionOf(outcome.created);
      return reply(`${prefix ? `${prefix}
` : ""}Scheduled ${restarting ? "restart of " : ""}${name} (tmux session ${session}, log ${browser ? `${BROWSER_STATE_DIR}/logs/${name}.log in the VM` : `.services/logs/${name}.log`}). Check status to confirm startup. ${browser ? `It is supervised: restarted when it crashes or fails its health check. It runs inside this browser tab's Linux VM: it stops when the tab is closed or reloaded and is started again when the app is opened again. Its port is reachable only from inside the VM (no browser preview). Logs: manage_server logs ${name}.` : `It is supervised: restarted when it crashes or fails its health check, and after app restarts. Check logs or attach with: tmux -L sf-servers attach -t ${session}`}`, { name, taskId: outcome.created, session });
    }
  }
  const manageServer = defineTool({
    name: "manage_server",
    description: (browser ? [
      "Run dev servers and other long-running processes as supervised background servers inside this browser tab's Linux VM (Alpine; use this instead of nohup or & in bash).",
      "Each server runs in a detached tmux session in the VM; it is restarted with backoff when it crashes or fails its health check. Servers live only while this tab is open: closing or reloading the tab stops them, and they are started again when the app is opened again.",
      "Start and restart schedule the process; use status to confirm it is running. A health endpoint already served outside its managed session is a conflict, never adopted. Stop waits for verified cleanup and retries if cleanup fails.",
      'Actions: start (name, command run with bash, cwd default /workspace, health optional: a port number or an http(s) URL checked with curl inside the VM, startGraceSeconds optional; does nothing if the same server is already running; settings differ -> use restart). stop (name). restart (name, optionally new command, cwd or health; health "none" removes the check). status (name, or all servers). logs (name, lines default 50, max 500).',
      "Ports are reachable only from commands inside the VM (curl http://127.0.0.1:<port>/ in bash); the browser cannot open them (no preview). /workspace in the VM is a live view of the page files: servers see edits made with the file tools immediately (file watchers may need polling). Service secrets are not supported in the browser edition.",
      `The process output is appended to ${BROWSER_STATE_DIR}/logs/<name>.log inside the VM (manage_server logs).`
    ] : [
      "Run dev servers and other long-running processes as supervised background servers (use this instead of nohup or & in bash).",
      "Each server runs in a detached tmux session; it is restarted with backoff when it crashes or fails its health check, and it comes back after the app restarts.",
      "Start and restart schedule the process; use status to confirm it is running. A health endpoint already served outside its managed session is a conflict, never adopted. Stop waits for verified cleanup and retries if cleanup fails.",
      'Actions: start (name, command, cwd default workspace, health optional: a port number or an http(s) URL, startGraceSeconds optional; does nothing if the same server is already running; settings differ -> use restart). stop (name). restart (name, optionally new command, cwd or health; health "none" removes the check). status (name, or all servers). logs (name, lines default 50, max 500).',
      "The process output is appended to .services/logs/<name>.log in the workspace."
    ]).join(" "),
    parameters: Type.Object({
      action: Type.Union(["start", "stop", "restart", "status", "logs"].map((value) => Type.Literal(value))),
      name: Type.Optional(Type.String({ maxLength: 40 })),
      command: Type.Optional(Type.String({ maxLength: 4e3 })),
      cwd: Type.Optional(Type.String({ maxLength: 500 })),
      health: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 65535 }), Type.String({ maxLength: 500 })])),
      startGraceSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LOG_LINES }))
    }),
    // Never rerun after a crash: a repeated stop/restart could hit newer work. status shows what is running.
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      // manage() answers in the servers@1 result shape ({content, details}); a pi-durable 1.2+ tool
      // result names the model's content `output` (pi-durable CHANGELOG 1.2.0, Breaking Changes).
      const { content, ...rest } = await manage(args, api, context);
      return { ...rest, output: content };
    }
  });
  const extension = defineExtension({ name: "self-forming-servers", tasks: [Server], tools: [manageServer] });
  const validate = (args) => validateToolArguments(manageServer, { type: "toolCall", id: "servers@1", name: manageServer.name, arguments: args });
  return Object.freeze({ extension, tools: Object.freeze([manageServer]), tasks: Object.freeze([Server]), manage, validate });
}
// Unchanged entry point (tests, older callers): the extension alone.
function createServerExtension(options = {}) {
  return createServers(options).extension;
}
export {
  BROWSER_LIFETIME,
  BROWSER_SECRETS_SCRIPT,
  BROWSER_STATE_DIR,
  BROWSER_TMUX_MISSING,
  SF_SECRETS_SCRIPT,
  SERVERS_DOC_KIND,
  SERVER_TASK_KIND,
  ServersDoc,
  createServerExtension,
  createServers,
  helperInstallScript,
  killSessionIn,
  launcherScript,
  browserServersEnv,
  BROWSER_NEEDS_BASH,
  normalizeHealth,
  treeScript
};
