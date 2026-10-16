// exec-js: the JavaScript shell of the browser edition's JavaScript execution environment
// (execution@1 provider "exec-js"). A command runs in a fresh module Worker
// (browser-console-worker.js, this folder); its fs/fetch/git calls are answered by the page.
// The FileSystem half of the environment is core-execution's page VFS backend
// (browser-execution.js), which calls exec() with a per-run context.
//
// Shell semantics (pi-durable Shell contract, honestly limited):
//   string             -> JavaScript source (the console semantics: last expression printed,
//                         top-level await, console.log -> stdout, console.error -> stderr).
//   ["node", file, ...args] -> runs the VFS file `file` (relative to cwd) as that source with
//                         process.argv = ["node", <absolute file>, ...args]. No real Node.js.
//   any other argv     -> spawn_error (there are no programs to spawn).
//   timeout/abort      -> the Worker is terminated (nothing else of the command can survive).
// Fixed bootstrap: browser-host.js creates this shell before composition, so recovery and
// composition share it. Not editable through app revisions.
const WORKSPACE = "/workspace";
const CHUNK = 64 * 1024;
const failure = (code, message, path) => Object.assign(new Error(message), { code, path });

export const JS_SHELL = Object.freeze({ id: "javascript", language: "javascript", name: "JavaScript" });

/**
 * createJavaScriptShell() -> { describe, exec(context) }. context: { id, command, directory,
 * env, timeout, output(stream, text), fs(op, args, cwd), readFile(path) -> bytes (absolute VFS
 * path, rejects when missing), resolvePath(path) -> absolute, fetch(input, init, tor), git(),
 * setCancel(fn) }. Resolves { exitCode }; rejects with code timeout/aborted/spawn_error.
 */
export function createJavaScriptShell({ workerUrl = new URL("./browser-console-worker.js", import.meta.url) } = {}) {
  function run({ id, code, argv, directory, env, timeout, output, fs, fetch: routedFetch, git, setCancel }) {
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(workerUrl, { type: "module", name: `js ${id}` });
      let timer;
      let finished = false;
      const netRequests = new Map();
      const gitController = new AbortController();
      const gitCallbacks = new Map();
      let callbackSeq = 0;
      const activeGitCalls = new Set();
      const gitCall = async (m) => {
        if (activeGitCalls.has(m.callId) || activeGitCalls.size >= 16) throw new Error("Too many or duplicate Git calls");
        activeGitCalls.add(m.callId);
        try {
          const service = git();
          if (!service?.call) throw new Error("Git is unavailable in this execution host");
          const options = { ...m.options };
          const allowed = new Set(["onAuthor", "onAuth", "onAuthSuccess", "onAuthFailure", "onProgress", "onMessage"]);
          for (const name of m.callbacks ?? []) {
            if (!allowed.has(name)) throw new Error("Unknown Git callback");
            options[name] = (...args) => new Promise((resolve, reject) => {
              if (finished) { reject(gitController.signal.reason); return; }
              const callbackId = ++callbackSeq;
              gitCallbacks.set(callbackId, { resolve, reject });
              worker.postMessage({ type: "git-callback", callId: m.callId, callbackId, name, args });
            });
          }
          return await service.call({ operation: m.operation, options, cwd: m.cwd, signal: gitController.signal });
        } finally { activeGitCalls.delete(m.callId); }
      };
      const cancelRequest = (requestId) => {
        const state = netRequests.get(requestId);
        netRequests.delete(requestId);
        state?.controller.abort();
        void state?.reader?.cancel().catch(() => {});
      };
      const networkCall = async (m) => {
        if (m.op === "cancel") { cancelRequest(m.requestId); return; }
        if (m.op === "start") {
          if (netRequests.has(m.requestId) || netRequests.size >= 16) throw new Error("Too many or duplicate worker requests");
          const state = { controller: new AbortController(), reader: null, rest: null, pulling: false };
          netRequests.set(m.requestId, state);
          try {
            const response = await routedFetch(m.url, { ...m.init, signal: state.controller.signal }, m.tor);
            if (finished || state.controller.signal.aborted) {
              void response.body?.cancel().catch(() => {});
              throw new DOMException("Request cancelled", "AbortError");
            }
            state.reader = response.body?.getReader();
            if (!state.reader) netRequests.delete(m.requestId);
            return { status: response.status, statusText: response.statusText, headers: [...response.headers], url: response.url, redirected: response.redirected, hasBody: Boolean(state.reader) };
          } catch (error) { cancelRequest(m.requestId); throw error; }
        }
        const state = netRequests.get(m.requestId);
        if (!state?.reader) throw new Error("Request is closed");
        if (m.op !== "pull" || state.pulling) throw new Error("Invalid or concurrent stream pull");
        state.pulling = true;
        try {
          if (!state.rest?.length) {
            const { value, done } = await state.reader.read();
            if (done) { netRequests.delete(m.requestId); state.reader.releaseLock(); return { done: true }; }
            state.rest = value;
          }
          const value = state.rest.slice(0, CHUNK);
          state.rest = state.rest.subarray(value.length);
          return { done: false, value };
        } catch (error) { cancelRequest(m.requestId); throw error; }
        finally { state.pulling = false; }
      };
      const finish = (settle) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        gitController.abort(new DOMException("Execution ended", "AbortError"));
        for (const pending of gitCallbacks.values()) pending.reject(gitController.signal.reason);
        gitCallbacks.clear();
        for (const requestId of [...netRequests.keys()]) cancelRequest(requestId);
        worker.terminate();
        settle();
      };
      worker.onmessage = async (event) => {
        const m = event.data;
        if (finished) return;
        if (m?.type === "git-callback-result") {
          const pending = gitCallbacks.get(m.callbackId);
          if (!pending) return;
          gitCallbacks.delete(m.callbackId);
          if (m.ok) pending.resolve(m.value);
          else pending.reject(Object.assign(new Error(m.error?.message || "Git callback failed"), { name: m.error?.name, code: m.error?.code }));
        }
        else if (m?.type === "git") {
          try {
            const value = await gitCall(m);
            if (!finished) worker.postMessage({ type: "git-result", callId: m.callId, ok: true, value });
          } catch (error) {
            if (!finished) worker.postMessage({ type: "git-result", callId: m.callId, ok: false,
              error: { name: error.name, message: error.message, code: error.code, path: error.path } });
          }
        }
        else if (m?.type === "net") {
          try {
            const value = await networkCall(m);
            if (!finished && m.callId) worker.postMessage({ type: "net-result", callId: m.callId, ok: true, value });
          } catch (error) {
            if (!finished && m.callId) worker.postMessage({ type: "net-result", callId: m.callId, ok: false, error: { name: error.name, message: error.message, code: error.code } });
          }
        }
        else if (m?.type === "out") output(m.stream === "stderr" ? "stderr" : "stdout", String(m.text));
        else if (m?.type === "done") finish(() => resolvePromise({ exitCode: Number.isInteger(m.exitCode) ? m.exitCode : 1 }));
        else if (m?.type === "fs") {
          try {
            const value = await fs(m.op, m.args, m.cwd ?? directory);
            if (!finished) worker.postMessage({ type: "fs-result", callId: m.callId, ok: true, value });
          } catch (error) {
            if (!finished) worker.postMessage({ type: "fs-result", callId: m.callId, ok: false, error: { code: error.code ?? "unknown", message: error.message, path: error.path } });
          }
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        output("stderr", `${event.message || "The JavaScript worker failed to start"}\n`);
        finish(() => resolvePromise({ exitCode: 1 }));
      };
      if (timeout) timer = setTimeout(() => {
        output("stderr", `\nStopped after ${timeout} s (timeout).\n`);
        finish(() => reject(failure("timeout", `Command timed out after ${timeout} seconds`)));
      }, timeout * 1000);
      setCancel(() => finish(() => reject(failure("aborted", "Command aborted"))));
      worker.postMessage({ type: "run", code, argv, cwd: directory, home: WORKSPACE, env: { HOME: WORKSPACE, PWD: directory, ...env } });
    });
  }

  async function exec(context) {
    const { command } = context;
    if (typeof command === "string") return run({ ...context, code: command, argv: [] });
    if (!Array.isArray(command) || command.some((arg) => typeof arg !== "string")) throw failure("spawn_error", "A JavaScript command is source text or an argv array of strings");
    if (command[0] !== "node" || command.length < 2) {
      throw failure("spawn_error", `The JavaScript environment runs source text or ["node", <file>, ...args]; there is no program ${JSON.stringify(command[0] ?? "")} to spawn. Select Linux in Settings → Providers for real programs.`);
    }
    const file = context.resolvePath(command[1]);
    let bytes;
    try { bytes = await context.readFile(file); }
    catch (error) { throw failure("spawn_error", `Cannot run ${file}: ${error?.message || error}`); }
    return run({ ...context, code: new TextDecoder().decode(bytes), argv: ["node", file, ...command.slice(2)] });
  }
  return Object.freeze({ describe: JS_SHELL, exec, dispose() {} });
}
