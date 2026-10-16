// core-storage: opens the conversation store and provides storage@1 (step X3, docs/plugin-ownership.md).
// Essential built-in (bundle self-forming-core, no dependencies). storage@1 = {open({env, name}?) →
// Promise<pi-durable Storage>, databaseName}; every open returns a new store that its caller (the
// session engine) closes. Which store:
// - browser edition (host.info platform "browser") with an execution environment: the JSONL store
//   in the browser file system, JsonlStorage.open("/data/conversations", env, BACKGROUND_CONTEXT,
//   {fsync: true}) (formerly globalThis.__piOpenStorage of apps/browser/browser-main.js);
// - with a native bridge: pi-durable's SqliteStorage over the native database "self-forming"
//   (native-database.js in this folder, packages/native-host/src/sqlite.ts hand-ported);
// - neither: an in-memory store (local development).
// Names are permanent: the database "self-forming", the JSONL folder and the doc/task kinds (which
// belong to the session engine and the plugins, not to this module) are unchanged, so existing
// conversations open as before. The SQLite engine itself stays in the Android host (SqliteStore.kt,
// SqlScript.kt; pending X3n → this plugin's native half, a later APK step).
// Fallback: app.js puts createStorage(...) of this statically registered module into the session
// options (used by the bundled core-agent and whenever storage@1 is unavailable); the session
// engine opens it itself as its last resort (tests, forks). native-database.js is imported lazily
// and, only if it cannot be loaded, the old openNativeDatabase export of the fixed native-host.js is
// used. No library module is imported at evaluation.
export const STORAGE_SERVICE = "storage";
export const DATABASE_NAME = "self-forming";
export const BROWSER_CONVERSATIONS = "/data/conversations";

let implementation;
/** This plugin's openNativeDatabase; native-host.js's export only if native-database.js fails to load. */
export function loadNativeDatabase({ load, fallback } = {}) {
  if (load || fallback) return resolveNativeDatabase(load, fallback);
  if (!implementation) {
    const pending = resolveNativeDatabase();
    implementation = pending;
    pending.catch(() => { if (implementation === pending) implementation = void 0; });
  }
  return implementation;
}
function resolveNativeDatabase(load = () => import("./native-database.js"), fallback = () => import("../../../native-host.js")) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.openNativeDatabase !== "function") throw new TypeError("native-database.js has no openNativeDatabase");
    return module.openNativeDatabase;
  }).catch(async (cause) => {
    console.error("core-storage database unavailable: using native-host.js", cause);
    return (await fallback()).openNativeDatabase;
  });
}

const isBrowser = (hostInfo) => hostInfo?.platform === "browser";

/** The storage@1 value: open({env, name}?) opens a new conversation store (see above). */
export function createStorage({ bridge, hostInfo, loaded = loadNativeDatabase, stopped } = {}) {
  async function open({ env, name = DATABASE_NAME } = {}) {
    if (stopped?.()) throw new Error("Conversation storage is stopped");
    if (env && isBrowser(hostInfo ?? globalThis.__piHostInfo)) {
      const [{ JsonlStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
        import("../../../library/pi-durable/storage/jsonl.js"),
        import("../../../library/chord/context.js")
      ]);
      return JsonlStorage.open(BROWSER_CONVERSATIONS, env, BACKGROUND_CONTEXT, { fsync: true });
    }
    if (!bridge) return new (await import("../../../library/pi-durable.js")).MemoryStorage();
    const [openNativeDatabase, { SqliteStorage }] = await Promise.all([loaded(), import("../../../library/pi-durable/storage/sqlite.js")]);
    return SqliteStorage.open(await openNativeDatabase(bridge, name));
  }
  return Object.freeze({ open, databaseName: DATABASE_NAME });
}

export function create({ bridge, hostInfo } = {}) {
  return {
    setup(ctx) {
      ctx.provide(STORAGE_SERVICE, 1, createStorage({ bridge, hostInfo, stopped: () => ctx.signal.aborted }));
    }
  };
}
