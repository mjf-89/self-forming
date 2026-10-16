// servers@1 (docs/plugins.md §9c C2), Track A step A4. The essential built-in
// core-servers (core-agent-plugins.js) provides this service and contributes the
// permanent extension "self-forming-servers" (tool manage_server, durable task kind
// self-forming.server, doc kind self-forming.servers) through a session-bound
// create(host). The implementation stays servers.js; this module only connects it:
//
// - createServerSession({build}): one app session's server binding, created by
//   session.js when its host supports supervised servers (native execution
//   environment, or the browser edition with linuxShell) and given to the agent host as
//   host.servers. part() is that session's tools and tasks, built ONCE by build()
//   (servers.js createServers), so the bundled and the runtime copy of core-servers
//   install the very same task definition and tool (no hand-over of running Server
//   tasks when composition connects). connectHost(host) (step C2; connect() with the
//   pieces of host.harness, the session's agent.harness@1 handle) makes it usable by
//   servers@1 once the session's task scheduler runs; close() when the session closes.
// - createServersService({persistent}): the page-level servers@1 facade. Every
//   method validates its input against the manage_server schema and runs the same
//   manage() as the tool, on the most recently opened app session; results are the
//   tool's results ({content: [{type: "text", text}], details}); errors are thrown.
//   status() adds persistent: whether servers outlive the page and the app (true on
//   Android: tmux runs outside the WebView). Browser edition (with linuxShell): persistent
//   false and lifetime "tab" (the servers run in the tab's Linux VM; they stop with the tab
//   and are restarted when the app is opened again; guest ports have no browser preview).
//   A host where core-servers is blocked has no servers@1 provider: ctx.get("servers", 1)
//   is null for a plugin that uses it, a plugin that requires it is blocked (normal
//   dependency rules), and another provider can provide it without a conflict.
//
// No library import (tests load core-agent-plugins.js without the bundled library).
export const SERVERS_SERVICE = "servers";
export const SERVERS_SERVICE_VERSION = 1;

const sessions = []; // open app sessions with a server binding, oldest first
const START_FIELDS = ["name", "command", "cwd", "health", "startGraceSeconds"];
const CHANGE_FIELDS = ["command", "cwd", "health", "startGraceSeconds"];
const NO_SESSION = "Background servers are not available: no app session is open.";
const CLOSED = "Background servers are not available: the app session closed.";
// A session that is still starting (plugin readiness ≤5 s, then its tasks start) is
// waited for at most this long.
export const START_WAIT_MS = 15000;

/**
 * build() → servers.js createServers(...) result ({tools, tasks, manage, validate}),
 * called at most once, when the session first needs it.
 */
export function createServerSession({ build } = {}) {
  if (typeof build !== "function") throw new TypeError("createServerSession needs build()");
  let implementation, api, context, connected = false, closed = false, resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const servers = () => {
    if (!implementation) {
      const built = build();
      if (!built || !Array.isArray(built.tools) || !Array.isArray(built.tasks) || typeof built.manage !== "function" || typeof built.validate !== "function") {
        throw new TypeError("build() must return the servers.js implementation (tools, tasks, manage, validate)");
      }
      implementation = built;
    }
    return implementation;
  };
  const session = Object.freeze({
    /** This session's extension part for core-servers: the same objects on every call. */
    part() {
      const { tools, tasks } = servers();
      return { tools: [...tools], tasks: [...tasks] };
    },
    get open() { return !closed; },
    get connected() { return connected && !closed; },
    /**
     * harness: the session's pi-durable Harness; env: its execution environment;
     * rootConversationId: where server tasks live; callContext: the session's context.
     * The api mirrors what pi-durable gives a tool (env, agent, snapshot, getTask,
     * waitForTask, commit), so manage() behaves exactly as in a manage_server call.
     */
    connect({ harness, env, rootConversationId, context: callContext }) {
      if (closed || connected) return;
      if (!harness || callContext === undefined) throw new TypeError("connect needs the harness and a context");
      api = Object.freeze({
        env,
        agent: async (agentContext) => (await harness.conversation(rootConversationId, agentContext)).agent(agentContext),
        snapshot: (doc, snapshotContext) => harness.snapshot(doc, snapshotContext),
        getTask: (id, taskContext) => harness.getTask(id, taskContext),
        waitForTask: (id, taskContext) => harness.waitForTask(id, taskContext),
        commit: (change, commitContext) => harness.commit(change, commitContext)
      });
      context = callContext;
      connected = true;
      resolveReady();
    },
    /**
     * Step C2: connects through the session's agent host. host.harness is the session's
     * agent.harness@1 handle (agent-contracts.js): its env, rootConversationId, context
     * and methods are what connect() takes, so manage() behaves exactly as before.
     */
    connectHost(host) {
      const handle = host?.harness;
      if (!handle) throw new TypeError("connectHost needs an agent host with its agent.harness@1 handle");
      session.connect({ harness: handle, env: handle.env, rootConversationId: handle.rootConversationId, context: handle.context });
    },
    close() {
      if (closed) return;
      closed = true;
      const index = sessions.indexOf(session);
      if (index >= 0) sessions.splice(index, 1);
      resolveReady();
    },
    /** One manage_server action (validated like a tool call). Waits until connected. */
    async run(args, { waitMs = START_WAIT_MS } = {}) {
      if (!connected && !closed) {
        let timer;
        const waited = await Promise.race([ready.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); })]);
        clearTimeout(timer);
        if (!waited) throw new Error("Background servers are not available yet: the app session is still starting.");
      }
      if (closed || !api) throw new Error(CLOSED);
      const implementation = servers();
      return implementation.manage(implementation.validate(args), api, context);
    }
  });
  sessions.push(session);
  return session;
}

function pick(source, fields, label) {
  if (source === undefined || source === null) return {};
  if (typeof source !== "object" || Array.isArray(source)) throw new TypeError(`${label} must be an object`);
  const picked = {};
  for (const field of fields) if (source[field] !== undefined) picked[field] = source[field];
  return picked;
}

/** The servers@1 implementation (frozen). persistent: servers survive page and app restarts; lifetime "tab" (browser): they end with the tab. */
export function createServersService({ persistent = true, lifetime, waitMs = START_WAIT_MS } = {}) {
  // The newest connected session; otherwise the newest one still starting.
  const current = () => {
    const open = sessions.filter((session) => session.open);
    return open.filter((session) => session.connected).at(-1) ?? open.at(-1);
  };
  const run = async (args) => {
    const session = current();
    if (!session) throw new Error(NO_SESSION);
    return session.run(args, { waitMs });
  };
  return Object.freeze({
    /** {name, command, cwd?, health?, startGraceSeconds?} → manage_server start. */
    start(spec) {
      return Promise.resolve().then(() => run({ action: "start", ...pick(spec, START_FIELDS, "start() options") }));
    },
    stop(name) {
      return run({ action: "stop", name });
    },
    /** changes: {command?, cwd?, health?, startGraceSeconds?} (health "none" removes the check). */
    restart(name, changes) {
      return Promise.resolve().then(() => run({ action: "restart", name, ...pick(changes, CHANGE_FIELDS, "restart() changes") }));
    },
    /** One server or all; plus persistent (host limit, §9c C2). */
    async status(name) {
      const result = await run(name === undefined ? { action: "status" } : { action: "status", name });
      return { ...result, persistent, ...lifetime ? { lifetime } : {} };
    },
    logs(name, lines) {
      return run(lines === undefined ? { action: "logs", name } : { action: "logs", name, lines });
    }
  });
}
