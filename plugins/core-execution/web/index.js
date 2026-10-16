// E1 (browser edition): execution@1 comes from the two providers exec-linux / exec-js (Settings →
// Providers); they open this plugin's environment over the page backend with their shell
// (createExecution({..., shell})). Here the browser keeps workspace@1, the page VFS backend
// (web/browser/) and the settings section; Android keeps this plugin's own execution@1.
// core-execution: the execution@1 adapter (docs/plugins.md §9) and, since X1, its implementation:
// the pi-durable ExecutionEnv is execution-env.js in this folder (hand-ported from
// packages/native-host/src/execution-env.ts). create({bridge, hostInfo, owner}) returns this
// plugin's definition parts; execution@1 is createExecution(...): open(cwd?, {owner}?) opens that
// environment over the page's bridge (owner defaults to the page's execution owner). openExecution
// (tests, forks) replaces the opener. The returned environment keeps the local
// exec/read/write/stream and cleanup APIs. The caller still owns environment lifetime; no
// implicit cleanup kills running processes or a durable session on hide/background.
// Bundled fallback: app.js gives createExecution(...) of this (statically registered) module to the
// page's session options, so the chat and its tools work without composition. execution-env.js is
// imported lazily (built-in entries import no library module at evaluation); if it cannot be loaded,
// the old export of the fixed native-host.js is used as the last resort.
// X4: also provides workspace@1 — the text workspace (list/read/write over the bridge's
// workspace.* methods; workspace.js in this folder, packages/native-host/src/workspace.ts
// hand-ported). It lives here rather than in core-workspace-tools because this plugin already
// receives the page's bridge and owns the host-side file/execution access; core-workspace-tools
// only holds the three agent tools, which get a workspace from the session. open(bridge?)
// returns the workspace over the page's bridge (or the given one). Fallback: createWorkspace(...)
// of this statically registered module (app.js session options); workspace.js is imported lazily
// and, only if it cannot load, createNativeWorkspace of native-host.js is used.
// Also (S1c) contributes the Settings → Background work screen (execution-settings.js) as
// settings.sections key "execution", slot "execution" (#execution-panel). app.js mounts the same
// nodes as the bundled fallback (mountBundled) and wires them (initExecutionSettings).
import { section, initExecutionSettings, executionOwner, EXECUTION_SLOT, EXECUTION_PANEL_ID } from "./execution-settings.js";
import { mountBundledPanel } from "../../../provider-panels.js";

const EXECUTION_SERVICE = "execution";
const WORKSPACE_SERVICE = "workspace";
// Equals settings-sections.js SETTINGS_SECTIONS (declared statically, like core-secrets).
const SETTINGS_SECTIONS = "settings.sections";
export const SECTION_KEY = "execution";
export const NO_EXECUTION = "Files and terminal need the app's execution service.";

export { section, initExecutionSettings, executionOwner, EXECUTION_SLOT, EXECUTION_PANEL_ID };

/** Bundled fallback: the Background work nodes into #execution-panel unless already attached. */
export const mountBundled = (doc = document) => mountBundledPanel(section, doc);

let implementation;
/**
 * This plugin's openNativeExecutionEnv; native-host.js's export only if execution-env.js fails to
 * load. Cached for the page; load/fallback (tests) bypass the cache.
 */
export function loadExecutionEnv({ load, fallback } = {}) {
  if (load || fallback) return resolveExecutionEnv(load, fallback);
  if (!implementation) {
    const pending = resolveExecutionEnv();
    implementation = pending;
    pending.catch(() => { if (implementation === pending) implementation = void 0; });
  }
  return implementation;
}
function resolveExecutionEnv(load = () => import("./execution-env.js"), fallback = () => import("../../../native-host.js")) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.openNativeExecutionEnv !== "function") throw new TypeError("execution-env.js has no openNativeExecutionEnv");
    return module.openNativeExecutionEnv;
  }).catch(async (cause) => {
    console.error("core-execution environment unavailable: using native-host.js", cause);
    return (await fallback()).openNativeExecutionEnv;
  });
}

let workspaceImplementation;
/** This plugin's createNativeWorkspace; native-host.js's export only if workspace.js fails to load. */
export function loadNativeWorkspace({ load, fallback } = {}) {
  if (load || fallback) return resolveNativeWorkspace(load, fallback);
  if (!workspaceImplementation) {
    const pending = resolveNativeWorkspace();
    workspaceImplementation = pending;
    pending.catch(() => { if (workspaceImplementation === pending) workspaceImplementation = void 0; });
  }
  return workspaceImplementation;
}
function resolveNativeWorkspace(load = () => import("./workspace.js"), fallback = () => import("../../../native-host.js")) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.createNativeWorkspace !== "function") throw new TypeError("workspace.js has no createNativeWorkspace");
    return module.createNativeWorkspace;
  }).catch(async (cause) => {
    console.error("core-execution workspace unavailable: using native-host.js", cause);
    return (await fallback()).createNativeWorkspace;
  });
}

/** The workspace@1 value over the page bridge: {list, read, write} (text only, 1 MiB). */
export function createWorkspace({ bridge, loaded = loadNativeWorkspace } = {}) {
  if (!bridge) return undefined;
  const through = (method) => async (...args) => (await loaded())(bridge)[method](...args);
  return Object.freeze({ list: through("list"), read: through("read"), write: through("write") });
}

/**
 * The execution@1 value: open(cwd?, {owner}?) → the pi-durable ExecutionEnv over the page bridge.
 * shell (browser edition, E1): the page shell the environment runs commands with ("javascript"
 * or "bash"); the execution@1 providers exec-js and exec-linux open their environments with it
 * (FileSystem = this plugin's page VFS backend, Shell = the provider's). Android: no shell.
 */
export function createExecution({ bridge, hostInfo, owner, shell, loaded = loadExecutionEnv } = {}) {
  return Object.freeze({
    async open(cwd, options = {}) {
      if (!bridge || !hostInfo?.capabilities?.executionEnv) throw new Error(NO_EXECUTION);
      const open = await loaded();
      return open(bridge, cwd, { owner: options?.owner ?? owner, ...shell === undefined ? {} : { shell } });
    }
  });
}

// Browser edition (E1): execution@1 comes from exec-js / exec-linux (Settings → Providers);
// this plugin then provides only workspace@1 and the shared page VFS backend (browserBackend).
export function create({ openExecution, bridge, hostInfo, owner, browserBackend, browserGit, providesExecution = !browserBackend } = {}) {
  if (openExecution !== void 0 && typeof openExecution !== "function") throw new TypeError("openExecution must be a function");
  const execution = openExecution || !providesExecution ? null : createExecution({ bridge, hostInfo, owner });
  const workspace = createWorkspace({ bridge });
  return {
    setup(ctx) {
      if (browserBackend && browserGit) ctx.cleanup(browserBackend.bindGitResolver(() => {
        // Declared git@1 use; only actual composition failure uses bundled recovery.
        const resolved = browserGit.resolve();
        return resolved === browserGit.service ? resolved : ctx.get("git", 1);
      }));
      ctx.contribute(SETTINGS_SECTIONS, SECTION_KEY, section, 60);
      ctx.provide(WORKSPACE_SERVICE, 1, Object.freeze({
        open(override) {
          if (ctx.signal.aborted) throw new Error("Workspace adapter is stopped");
          const target = override ?? bridge;
          if (!target) throw new Error("The workspace needs the app's native host.");
          return override ? createWorkspace({ bridge: override }) : workspace;
        }
      }));
      if (providesExecution || openExecution) ctx.provide(EXECUTION_SERVICE, 1, Object.freeze({
        open(...args) {
          if (ctx.signal.aborted) throw new Error("Execution adapter is stopped");
          return openExecution ? openExecution(...args) : execution.open(...args);
        }
      }));
    }
  };
}
