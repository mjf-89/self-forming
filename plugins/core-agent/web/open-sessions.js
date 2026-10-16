// core-agent: opens the page's sessions (step C3d, docs/plugins-providers-agent-core.md §I).
// The opener was app.js start() openSession, moved verbatim. options: the page's session
// options (agent-sessions.js connect({sessionOptions})): bridge, hostInfo, owner (execution
// owner), execution (the bundled core-execution copy, app.js), chatgpt, claude, fetch,
// agentExtensions, agentProviders, revisions (app-revisions controller), onOpened(session, {env}), extra (further openAppSession options, tests).
// X1: the execution environment comes from execution@1 (core-execution), looked up at each
// opening by the plugin's setup (so a stopped core-execution is not used), else from options.execution (the bundled core-execution copy); only without either
// (tests, forks) from the old native-host.js export. session.js and native-host.js are imported
// lazily (built-in entries import no library module at evaluation).
// X4: the session's fetch comes from net.fetch@1 (core-net-native) and its text workspace from workspace@1
// (core-execution). Composed network requests resolve per call and fail closed when unavailable;
// only the separately invoked bundled opener (composition missing/failed) uses options.fetch.
// Workspace still uses its bundled page copy when no service opens it. Tests/forks without page
// copies may use the session engine's own last resort (native-host.js).
// X3: the conversation store comes from storage@1 (core-storage), looked up at each opening, else
// from options.storage (the bundled core-storage copy, app.js); without either (tests, forks) the
// session engine opens the bundled core-storage copy itself. Formerly the browser edition gave its
// JSONL store through globalThis.__piOpenStorage; that is core-storage's browser branch now.
// X3b: services.parts (id, version) → the active conversations.engine@1 / servers.engine@1 is
// handed to the session engine as engineParts; it uses its bundled copies without them.
async function openEnv({ bridge, owner, execution }, service) {
  const live = typeof service === "function" ? service() : service;
  const opener = live?.open ? live : execution?.open ? execution : null;
  if (opener) return opener.open(void 0, { owner });
  return (await import("../../../native-host.js")).openNativeExecutionEnv(bridge, void 0, { owner });
}

const live = (service) => {
  try { return typeof service === "function" ? service() : service; } catch { return null; }
};

/**
 * A composed session keeps a stable fetch, resolving net.fetch@1 on EVERY request, including
 * when the session opens before its provider is ready. Null means unavailable, not permission
 * to bypass selection with the page/native bundled copy. Only the separately invoked bundled
 * opener (no net getter: composition missing/failed) uses options.fetch, supplied by the page
 * from the owning implementation. Never supply a missing fetch and trigger the engine's last resort.
 */
export function fetchOption(options, { net } = {}) {
  if (typeof options.networkFetch === "function") return { fetch: options.networkFetch };
  if (!options.bridge || typeof net !== "function") return { fetch: options.fetch };
  const current = () => {
    const value = live(net);
    return typeof value === "function" ? value : null;
  };
  const fetch = Object.assign((input, init) => {
    const value = current();
    if (!value) return Promise.reject(new Error("Network is unavailable: no ready selected provider"));
    return value(input, init);
  }, {
    describe: () => current()?.describe?.() ?? { status: "unavailable", ready: async () => false }
  });
  return { fetch };
}
/** storage: a store opened by storage@1, else by the page's bundled copy; none without a bridge or when given in extra. */
export async function storageOption(options, { storage } = {}, env) {
  if (!options.bridge || options.extra?.storage) return {};
  const service = live(storage);
  const opener = typeof service?.open === "function" ? service : typeof options.storage?.open === "function" ? options.storage : null;
  return opener ? { storage: await opener.open({ env }) } : {};
}
/** workspace: workspace@1 over the page bridge, else the page's bundled copy. */
export function workspaceOption(options, { workspace } = {}) {
  let opened;
  if (options.bridge) {
    try { opened = live(workspace)?.open?.(); } catch { opened = void 0; }
  }
  const chosen = opened ?? options.workspace;
  return chosen ? { workspace: chosen } : {};
}

export function createSessionOpener(options, execution, services = {}) {
  return async ({ wanted }) => {
    const { bridge, hostInfo, revisions } = options;
    const { openAppSession } = await import("../../../session.js");
    const env = bridge && hostInfo?.capabilities?.executionEnv ? await openEnv(options, execution) : void 0;
    // E1: which environment this session got (env.shell in the browser), so core-agent can tell
    // when the selected execution@1 provider no longer matches the open session.
    try { services.opened?.(env); } catch { /* observation only */ }
    const opened = await openAppSession({
      bridge,
      env,
      // core-storage: SQLite database "self-forming" on Android, JSONL files in the browser edition.
      ...await storageOption(options, services, env),
      ...typeof services.parts === "function" ? { engineParts: services.parts } : {},
      chatgpt: options.chatgpt,
      claude: options.claude,
      ...fetchOption(options, services),
      ...workspaceOption(options, services),
      hostInfo,
      agentExtensions: options.agentExtensions,
      agentProviders: options.agentProviders,
      ...bridge && hostInfo?.capabilities?.apkInstall === true ? { apkInstaller: { call: (method, params) => bridge.call(method, params) } } : {},
      ...revisions ? { appRevision: {
        info: revisions.info,
        stage: revisions.stage,
        onStaged: (revision) => revisions?.queue(opened, revision)
      } } : {},
      ...options.extra
    });
    if (!wanted()) {
      await opened.close();
      return void 0;
    }
    options.onOpened?.(opened, { env });
    return opened;
  };
}

/**
 * Begins the page lifecycle (agent-sessions.js controller) with this opener; by names the
 * copy ("core-agent" from the plugin's setup, "bundled" from app.js); execution: the
 * execution@1 service or a function returning it (null when unavailable), from the plugin's
 * setup; none for the bundled copy; services: {net, workspace, storage} (getters returning the services, X4/X3; net.fetch@1 is itself a function) and parts (X3b). Throws while the page
 * has given no session options; false once another copy began.
 */
export function openSessions(lifecycle, by, execution, services) {
  const options = lifecycle?.sessionOptions;
  if (!options) throw new Error("The page has not given its session options yet.");
  return lifecycle.begin(createSessionOpener(options, execution, services), by);
}
