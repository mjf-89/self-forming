// Supervised background servers on pi-durable (pi-mono packages/durable: README "Tasks", docs/spec.md TaskRuntime).
//
// manage_server starts a command in a detached tmux session (`srv-<taskId>`) on the ONE shared tmux server (the new session gets SF_SECRETS_URL/SF_SECRETS_TOKEN, never values; its launcher fetches this server's
// secrets from the secret broker with sf-secrets) and a durable background task keeps it alive: it restarts the process when it crashes or stops answering its health check, with backoff, and it resumes after
// an app restart. Server tasks belong to the ROOT conversation (background, so chat Stop does not touch them) whichever
// conversation or subagent called the tool.
//
// "check-at" design: the checkpoint holds the time of the next check (`nextCheckAt`). The task sleeps on the durable clock
// until then, so an idle healthy server writes one small checkpoint every `intervalMs`, and a restarted app simply
// continues from the stored time. The registry document is only written on start, stop, restart and configuration change.
import { Type } from "./library/pi-ai.js";
import { defineDoc, defineExtension, defineTask, defineTool } from "./library/pi-durable.js";
import { withAbortSignal } from "./library/chord/context.js";

export const SERVER_TASK_KIND = "self-forming.server";
export const SERVERS_DOC_KIND = "self-forming.servers";

/** Session-scoped registry of the servers by name. Session documents are latest-only. */
export const ServersDoc = defineDoc({
  kind: SERVERS_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ servers: {} })
});

const DEFAULT_TIMING = {
  intervalMs: 20000, // pause between health checks of a healthy server
  backoffMs: [2000, 5000, 15000, 30000, 60000], // pause before restart n (the n-th consecutive failure)
  maxFailures: 6, // consecutive failures after which the task ends as failed
  defaultGraceMs: 10000, // time a fresh process gets before its first check
  execTimeoutSec: 15, // limit of every shell command
  logTailLines: 20 // log lines attached to the final error
};
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_CAPTURE = 64 * 1024;
const MAX_LOG_LINES = 500;

const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const sessionOf = (taskId) => `srv-${taskId}`;
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

/** "7799" / 7799 → port; "http(s)://…" → URL; undefined otherwise-empty. Throws on anything else. */
export function normalizeHealth(value) {
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
  // A port counts as served when anything answers HTTP on it (even 404); a URL must answer with a 2xx/3xx status.
  if (typeof health === "number") return `curl -sS -m 3 -o /dev/null http://127.0.0.1:${health}/`;
  return `curl -fsS -m 3 -o /dev/null ${q(health)}`;
}

/**
 * One shell command in the task's environment: never throws for a nonzero exit or a timeout, only for a missing
 * environment or when the invocation is cancelled. Bounded in time even when the environment ignores `timeout`.
 */
async function shell(runtime, context, command, timeoutSec, extraEnv) {
  const env = await runtime.env(context);
  if (!env) throw new Error("No execution environment is available.");
  return execIn(env, context, command, timeoutSec, extraEnv);
}

async function execIn(env, context, command, timeoutSec, extraEnv) {
  let out = "";
  const controller = new AbortController();
  const signal = context.abortSignal ? AbortSignal.any([controller.signal, context.abortSignal]) : controller.signal;
  const pending = env.exec(command, {
    timeout: timeoutSec,
    ...(extraEnv ? { env: extraEnv } : {}),
    onOutput: (text) => { out = (out + text).slice(-MAX_CAPTURE); }
  }, withAbortSignal(signal, context));
  pending.catch(() => {});
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Command did not finish in ${timeoutSec}s: ${clip(command, 80)}`));
    }, (timeoutSec + 5) * 1000);
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

// ─── tmux session helpers (only called by the supervising task) ───────────────────────────
// ONE shared tmux server for every supervised server. A new session gets SF_SECRETS_URL / SF_SECRETS_TOKEN (and only those,
// no values) from the environment of the starting command through tmux's update-environment; the launcher then fetches the
// values for this server from the secret broker with sf-secrets.
const SECRETS_WAIT_SEC = 20; // how long a launcher waits for a fingerprint answer
const SECRETS_PENDING_MAX_SEC = SECRETS_WAIT_SEC + 25;
const START_ENV = { PI_SECRET_SCOPE: "servers" };

const pathsOf = (input) => ({
  script: `${input.workspace}/.services/${input.name}.sh`,
  log: `${input.workspace}/.services/logs/${input.name}.log`,
  sfSecrets: `${input.workspace}/.tools/bin/sf-secrets`,
  // Exists while the launcher waits for the secret broker (a fingerprint answer); the supervisor then does not count a failed health check.
  waitFile: `${input.workspace}/.services/logs/${input.name}.secrets-wait`
});

/** Launcher script: fetch secrets, cd, rotate a big log, `exec bash -lc <command>` with all output appended to the log. */
function launcherScript(input, session) {
  const { log, sfSecrets, waitFile } = pathsOf(input);
  return [
    "#!/bin/sh",
    `# ${session}: generated by self-forming manage_server; rewritten at every start.`,
    `LOG=${q(log)}`,
    `mkdir -p ${q(`${input.workspace}/.services/logs`)}`,
    `if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi`,
    `echo "=== $(date '+%F %T') starting ${input.name}" >> "$LOG"`,
    // Secrets for this server (needs SF_SECRETS_URL/TOKEN from the tmux session environment; a no-op without them).
    `WAITFILE=${q(waitFile)}`,
    `: > "$WAITFILE"`,
    `eval "$(${q(sfSecrets)} --exports --label ${q(`Server ${input.name}`)} --wait ${SECRETS_WAIT_SEC} 2>> "$LOG")"`,
    `rm -f "$WAITFILE"`,
    `cd ${q(input.cwd)} || { echo "cannot cd to the working directory" >> "$LOG"; exit 1; }`,
    `exec bash -lc ${q(input.command)} >> "$LOG" 2>&1`,
    ""
  ].join("\n");
}

const missingSession = /^(?:no server running on |no sessions$|can't find session: |error connecting to .+ \((?:No such file or directory|Connection refused)\))/m;
async function sessionExists(env, context, session, timeoutSec, socket = "-L sf-servers") {
  const result = await execIn(env, context, `tmux ${socket} has-session -t ${q(`=${session}`)} 2>&1`, timeoutSec);
  if (result.ok) return true;
  if (result.code === 1 && missingSession.test(result.out.trim())) return false;
  throw new Error(`Cannot inspect tmux session ${session}: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
}

// Each command runs in its own PRoot, and tmux refuses clients whose (real) user id differs from what it sees as its own
// ("access not allowed"): the server is started with an explicit server-access rule for the real uid, and a server that
// still refuses (started before this rule) is killed by process name and restarted.
const TMUX_PREP = `U=$(awk '/^Uid:/{print $2}' /proc/self/status); getent passwd "$U" >/dev/null || echo "aid_$U:x:$U:$U::/nonexistent:/usr/sbin/nologin" >> /etc/passwd; if tmux -L sf-servers ls 2>&1 | grep -q "access not allowed"; then pkill -f "[t]mux -L sf-servers" 2>/dev/null; sleep 0.3; fi; `;
// Supervised servers share one dedicated tmux server (socket "sf-servers") that only this supervisor starts, with the
// servers scope (no secret values), so a tmux started by an AI command can never leak into them.
/** Kills the session on the shared tmux server and any legacy per-session tmux server (older versions used `tmux -L <session>`). */
async function killSessionIn(env, context, session, timeoutSec) {
  await ensureTmux(env, context);
  for (const socket of ["-L sf-servers", "", `-L ${q(session)}`]) {
    if (!(await sessionExists(env, context, session, timeoutSec, socket))) continue;
    const result = await execIn(env, context, `tmux ${socket} kill-session -t ${q(`=${session}`)} 2>&1`, timeoutSec);
    // A session can exit between inspection and kill. Disappearance, not the kill exit code, is the receipt.
    if (await sessionExists(env, context, session, timeoutSec, socket)) {
      throw new Error(`tmux session ${session} is still running: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
    }
  }
}

// tmux is not part of the base Ubuntu environment: install it on first use (apt, noninteractive, one install at a time).
const TMUX_INSTALL_TIMEOUT_SEC = 300;
const TMUX_INSTALL = [
  "command -v tmux >/dev/null 2>&1 && exit 0",
  "export DEBIAN_FRONTEND=noninteractive",
  "exec 9>/tmp/sf-tmux-install.lock; flock 9 2>/dev/null || true",
  "command -v tmux >/dev/null 2>&1 && exit 0",
  "apt-get install -y -q tmux >/tmp/sf-tmux-install.log 2>&1 || { apt-get update -q >>/tmp/sf-tmux-install.log 2>&1 && apt-get install -y -q tmux >>/tmp/sf-tmux-install.log 2>&1; }",
  "command -v tmux >/dev/null 2>&1 || { tail -n 5 /tmp/sf-tmux-install.log; exit 1; }"
].join("\n");
let tmuxReady = false;
async function ensureTmux(env, context) {
  if (tmuxReady) return;
  const result = await execIn(env, context, TMUX_INSTALL, TMUX_INSTALL_TIMEOUT_SEC);
  if (!result.ok) throw new Error(`tmux is missing and could not be installed: ${clip(result.out.trim() || result.error || `exit ${result.code}`, 300)}`);
  tmuxReady = true;
}

/** Writes the launcher and starts this task's session. An existing session is never replaced on replay. */
async function launchSession(env, context, input, session, { timeoutSec } = {}) {
  await ensureTmux(env, context);
  const { script } = pathsOf(input);
  const eof = `__PI_SERVER_${session}_EOF__`;
  const write = await execIn(env, context,
    `mkdir -p ${q(`${input.workspace}/.services/logs`)} && cat > ${q(script)} <<'${eof}'\n${launcherScript(input, session)}${eof}`,
    timeoutSec);
  if (!write.ok) throw new Error(`Could not write the launcher script: ${clip(write.out.trim() || write.error || `exit ${write.code}`, 300)}`);
  // A tmux command chain stops at its first error, and server-access fails when the rule already exists: run it apart.
  // exit-empty off keeps the dedicated server (and its access rule) alive between servers.
  const tmuxStart = `tmux -L sf-servers start-server \\; set-option -g exit-empty off; tmux -L sf-servers server-access -a "aid_$U" 2>/dev/null; ` + [
    "tmux -L sf-servers set-option -g update-environment " + q("SF_SECRETS_URL SF_SECRETS_TOKEN"),
    `new-session -d -s ${q(session)} -c ${q(input.cwd)} ${q(`sh ${q(script)}`)}`
  ].join(" \\; ");
  const started = await execIn(env, context,
    `${TMUX_PREP}${tmuxStart} 2>&1`,
    timeoutSec, START_ENV);
  if (!started.ok) throw new Error(`tmux could not start ${session}: ${clip(started.out.trim() || started.error || `exit ${started.code}`, 300)}`);
}

const stoppedByCaller = (runtime, context) => runtime.signal.aborted || context.abortSignal?.aborted === true;
class ServerConflict extends Error {}

export function createServerExtension({ rootConversationId, abortTask, timing: timingOptions } = {}) {
  const timing = { ...DEFAULT_TIMING, ...timingOptions };
  const backoffFor = (failures) => timing.backoffMs[Math.min(Math.max(failures, 1), timing.backoffMs.length) - 1];

  const paths = pathsOf;

  const logTail = async (runtime, context, input, lines) => {
    try {
      const result = await shell(runtime, context, `tail -n ${lines} -- ${q(paths(input).log)} 2>/dev/null`, timing.execTimeoutSec);
      return result.out.trim();
    } catch (error) {
      if (stoppedByCaller(runtime, context)) throw error;
      return "";
    }
  };

  const hasSession = async (runtime, context, session) =>
    sessionExists(await runtime.env(context), context, session, timing.execTimeoutSec);

  const killSession = async (runtime, context, session) =>
    killSessionIn(await runtime.env(context), context, session, timing.execTimeoutSec);

  const healthy = async (runtime, context, health) => (await shell(runtime, context, healthCommand(health), timing.execTimeoutSec)).ok;

  const secretsPending = async (runtime, context, input) => {
    const file = q(paths(input).waitFile);
    return (await shell(runtime, context, `[ -f ${file} ] && [ $(( $(date +%s) - $(stat -c %Y ${file}) )) -lt ${SECRETS_PENDING_MAX_SEC} ]`, timing.execTimeoutSec)).ok;
  };

  async function startSession(runtime, context, input, session) {
    const env = await runtime.env(context);
    if (!env) throw new Error("No execution environment is available.");
    await launchSession(env, context, input, session, { timeoutSec: timing.execTimeoutSec });
  }

  const checkpointOf = (checkpoint, change) => {
    const next = { ...checkpoint, ...change };
    for (const key of Object.keys(next)) if (next[key] === void 0) delete next[key];
    return next;
  };

  /** Failure path shared by both phases: kill the session, then back off or end as failed. Never throws unless cancelled. */
  async function fail(runtime, context, task, reason) {
    const input = task.input;
    const session = sessionOf(runtime.taskId);
    const checkpoint = task.state.checkpoint;
    const failures = (checkpoint.failures ?? 0) + 1;
    await killSession(runtime, context, session);
    let detail = "";
    try { detail = await logTail(runtime, context, input, failures >= timing.maxFailures ? timing.logTailLines : 5); } catch (error) {
      if (stoppedByCaller(runtime, context)) throw error;
    }
    if (failures >= timing.maxFailures || checkpoint.conflict) {
      const message = clip(`${input.name} failed: ${reason}${detail ? `\nLast log lines:\n${detail}` : ""}`, 4000);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), context);
      return;
    }
    const lastError = clip(`${reason}${detail ? ` | log: ${detail.split("\n").slice(-3).join(" / ")}` : ""}`, 700);
    await runtime.commit(() => ({
      status: "running",
      checkpoint: checkpointOf(checkpoint, {
        phase: "ensure", failures, restarts: (checkpoint.restarts ?? 0) + 1,
        nextCheckAt: runtime.now() + backoffFor(failures), lastError, external: void 0, healthyAt: void 0,
        cleanupReason: void 0, cleanupFailures: void 0
      })
    }), context);
  }

  /** Runs one phase body; any error becomes a failure + backoff commit. Cancellation (abort, app close) ends quietly. */
  async function guarded(task, runtime, context, body) {
    try {
      await body();
    } catch (error) {
      if (stoppedByCaller(runtime, context)) return;
      try {
        await fail(runtime, context, { ...task, state: { ...task.state, checkpoint: { ...task.state.checkpoint, conflict: error instanceof ServerConflict || task.state.checkpoint.conflict } } }, errorText(error));
      } catch (second) {
        if (stoppedByCaller(runtime, context)) return;
        // Never settle a failed task while its process cleanup is unconfirmed. Resume cleanup after close/reopen.
        const checkpoint = task.state.checkpoint;
        const cleanupFailures = (checkpoint.cleanupFailures ?? 0) + 1;
        const next = {
          status: "running",
          checkpoint: checkpointOf(checkpoint, {
            phase: "cleanup", cleanupFailures, nextCheckAt: runtime.now() + backoffFor(cleanupFailures),
            cleanupReason: checkpoint.cleanupReason ?? errorText(error),
            conflict: error instanceof ServerConflict || checkpoint.conflict || void 0,
            lastError: clip(`Cleanup pending: ${errorText(second)}`, 700), healthyAt: void 0
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
        ...(checkpoint.external ? { phase: "ensure", nextCheckAt: 0, healthyAt: void 0 } : {}),
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
        await ensureTmux(await runtime.env(context), context);
        if (!(await hasSession(runtime, context, session))) {
          await killSession(runtime, context, session); // migration: a legacy per-session tmux server (`tmux -L <session>`) may still hold the port
          if (input.health !== void 0 && await healthy(runtime, context, input.health)) {
            throw new ServerConflict(`Health endpoint ${input.health} is already answering outside ${session}. Stop that process explicitly or choose a free port; it has not been adopted or restarted.`);
          }
          await startSession(runtime, context, input, session);
        }
        await runtime.commit(() => ({
          status: "running",
          checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: runtime.now() + input.startGraceMs, external: void 0 })
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
        if (checkpoint.nextCheckAt > runtime.now()) await runtime.sleep(checkpoint.nextCheckAt, context);
        let problem;
        let waitingForSecrets = false;
        if (!(await hasSession(runtime, context, session))) problem = "the process exited (tmux session ended)";
        else if (input.health !== void 0 && !(await healthy(runtime, context, input.health))) {
          if (await secretsPending(runtime, context, input)) waitingForSecrets = true;
          else problem = `health check failed (${input.health})`;
        }
        if (problem !== void 0) throw new Error(problem);
        if (waitingForSecrets) {
          // The launcher still waits for the user's fingerprint: not a failure, look again shortly.
          await runtime.commit(() => ({ status: "running", checkpoint: checkpointOf(checkpoint, { phase: "watch", nextCheckAt: runtime.now() + 3000 }) }), context);
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
      for (;;) {
        try {
          if (checkpoint.nextCleanupAt > runtime.now()) await runtime.sleep(checkpoint.nextCleanupAt, context);
          await killSession(runtime, context, sessionOf(runtime.taskId));
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

  // ─── manage_server ─────────────────────────────────────────────────────────
  const reply = (text, details) => ({ content: [{ type: "text", text }], ...(details ? { details } : {}) });
  const isLive = (record) => record !== void 0 && record.state.status !== "terminal";

  function describe(name, entry, record) {
    const session = sessionOf(entry.taskId);
    const hint = `tmux -L sf-servers attach -t ${session}`;
    const settings = `${entry.command}${entry.cwd ? ` (in ${entry.cwd})` : ""}${entry.health !== void 0 ? ` · health ${entry.health}` : ""}`;
    const state = record?.state;
    let label;
    let restarts = 0;
    let lastError;
    if (!state) label = "unknown (task record missing)";
    else if (state.status === "terminal") {
      const outcome = state.outcome;
      if (outcome.status === "aborted" || entry.stoppedAt) label = "stopped";
      else if (outcome.status === "failed") { label = "failed"; lastError = outcome.error?.message; }
      else if (outcome.status === "completed") label = "stopped";
      else { label = `failed (task ${outcome.status})`; lastError = outcome.error?.message ?? outcome.reason; }
    } else if (state.status === "completing" || record.abortRequested) {
      label = "stopping";
      lastError = state.checkpoint?.lastError;
    }
    else {
      const checkpoint = state.checkpoint ?? {};
      restarts = checkpoint.restarts ?? 0;
      lastError = checkpoint.lastError;
      if (checkpoint.phase === "cleanup") label = "cleanup pending";
      else if (checkpoint.phase === "ensure" && (checkpoint.failures ?? 0) > 0) {
        const wait = Math.max(0, Math.round((checkpoint.nextCheckAt - Date.now()) / 1000));
        label = `backing off (failure ${checkpoint.failures}, restarting in ${wait}s)`;
      } else if (checkpoint.phase === "watch" && checkpoint.healthyAt !== void 0 && (checkpoint.failures ?? 0) === 0) {
        label = "running";
      } else label = "starting";
    }
    const live = label !== "stopped" && !label.startsWith("failed");
    const lines = [`${name}: ${label}${state && state.status !== "terminal" ? ` · restarts ${restarts}` : ""} · ${settings}`];
    if (live && state) lines.push(`  session ${session} · ${hint}`);
    else lines.push(`  (task ${entry.taskId}; session ${session} is not running)`);
    if (lastError) lines.push(`  last error: ${clip(lastError, 1500)}`);
    return { text: lines.join("\n"), label, restarts, session };
  }

  const manageServer = defineTool({
    name: "manage_server",
    description: [
      "Run dev servers and other long-running processes as supervised background servers (use this instead of nohup or & in bash).",
      "Each server runs in a detached tmux session; it is restarted with backoff when it crashes or fails its health check, and it comes back after the app restarts.",
      "Start and restart schedule the process; use status to confirm it is running. A health endpoint already served outside its managed session is a conflict, never adopted. Stop waits for verified cleanup and retries if cleanup fails.",
      "Actions: start (name, command, cwd default workspace, health optional: a port number or an http(s) URL, startGraceSeconds optional; does nothing if the same server is already running; settings differ -> use restart). stop (name). restart (name, optionally new command, cwd or health; health \"none\" removes the check). status (name, or all servers). logs (name, lines default 50, max 500).",
      "The process output is appended to .services/logs/<name>.log in the workspace."
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union(["start", "stop", "restart", "status", "logs"].map((value) => Type.Literal(value))),
      name: Type.Optional(Type.String({ maxLength: 40 })),
      command: Type.Optional(Type.String({ maxLength: 4000 })),
      cwd: Type.Optional(Type.String({ maxLength: 500 })),
      health: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 65535 }), Type.String({ maxLength: 500 })])),
      startGraceSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LOG_LINES }))
    }),
    // Never rerun after a crash: a repeated stop/restart could hit newer work. status shows what is running.
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const { action } = args;
      const workspaceOf = async () => {
        const root = api.env?.cwd ?? (await api.agent(context)).cwd;
        if (!root) throw new Error("No workspace directory is available.");
        return String(root).replace(/\/+$/, "");
      };
      const registry = async () => (await api.snapshot(ServersDoc, context))?.servers ?? {};
      const entryOf = (servers, name) => (Object.hasOwn(servers, name) ? servers[name] : void 0);
      const needName = () => {
        if (!args.name) throw new Error(`${action} needs a name.`);
        if (!NAME_PATTERN.test(args.name)) throw new Error("name must be 1-40 letters, digits, dot, dash or underscore, starting with a letter or digit.");
        return args.name;
      };

      if (action === "status") {
        const servers = await registry();
        const names = args.name === void 0 ? Object.keys(servers).sort() : [args.name];
        if (!names.length) return reply("No servers. Start one with manage_server start.");
        const lines = [];
        const details = {};
        for (const name of names) {
          const entry = entryOf(servers, name);
          if (!entry) { lines.push(`${name}: no such server`); continue; }
          const info = describe(name, entry, await api.getTask(entry.taskId, context));
          lines.push(info.text);
          details[name] = { taskId: entry.taskId, state: info.label, restarts: info.restarts, session: info.session };
        }
        return reply(lines.join("\n"), details);
      }

      if (action === "logs") {
        const name = needName();
        const entry = entryOf(await registry(), name);
        if (!entry) throw new Error(`No server named ${name}.`);
        if (!api.env) throw new Error("No execution environment is available.");
        const count = Math.min(Math.max(args.lines ?? 50, 1), MAX_LOG_LINES);
        const log = paths({ workspace: await workspaceOf(), name }).log;
        const result = await execIn(api.env, context, `if [ -f ${q(log)} ]; then tail -n ${count} -- ${q(log)}; else echo "(no log yet: ${log.replace(/["$`\\]/g, "")})"; fi`, timing.execTimeoutSec);
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

      /** Fields of a restart: the stored settings with the given ones replaced. */
      function overrides(given, entry) {
        const next = {};
        if (given.command?.trim()) next.command = given.command.trim();
        if (given.cwd) next.cwd = given.cwd;
        if (given.health !== void 0) next.health = normalizeHealth(given.health);
        if (given.startGraceSeconds !== void 0) next.startGraceMs = Math.round(given.startGraceSeconds * 1000);
        else next.startGraceMs = entry.startGraceMs;
        return next;
      }

      async function stopServer(name, entry) {
        const record = await api.getTask(entry.taskId, context);
        if (isLive(record)) {
          if (!abortTask) throw new Error("This session cannot stop servers (no abortTask hook).");
          await abortTask(entry.taskId, context);
          await api.waitForTask(entry.taskId, context);
        } else if (api.env) {
          // Already ended (stopped or failed): make sure no session is left behind.
          await killSessionIn(api.env, context, sessionOf(entry.taskId), timing.execTimeoutSec);
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

      async function startServer(name, wanted, restarting, prefix) {
        const workspace = await workspaceOf();
        const cwd = wanted.cwd ? (wanted.cwd.startsWith("/") ? wanted.cwd : `${workspace}/${wanted.cwd}`).replace(/\/+$/, "") || "/" : workspace;
        const settings = { command: wanted.command, cwd, ...(wanted.health !== void 0 ? { health: wanted.health } : {}) };
        const startGraceMs = wanted.startGraceMs ?? (wanted.startGraceSeconds !== void 0 ? Math.round(wanted.startGraceSeconds * 1000) : timing.defaultGraceMs);
        const outcome = await api.commit(async (tx) => {
          // All reads first (a Tx rejects reads after writes), then the writes. One commit makes start atomic.
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
          return reply(`${name} is already running with these settings; nothing to do.\n${info.text}`, { name, taskId: outcome.existing.taskId, existing: true });
        }
        const session = sessionOf(outcome.created);
        return reply(`${prefix ? `${prefix}\n` : ""}Scheduled ${restarting ? "restart of " : ""}${name} (tmux session ${session}, log .services/logs/${name}.log). Check status to confirm startup. It is supervised: restarted when it crashes or fails its health check, and after app restarts. Check logs or attach with: tmux -L sf-servers attach -t ${session}`, { name, taskId: outcome.created, session });
      }
    }
  });

  return defineExtension({ name: "self-forming-servers", tasks: [Server], tools: [manageServer] });
}
