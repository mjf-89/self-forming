// core-execution implementation of the text workspace (step X4): packages/native-host/src/
// workspace.ts (createNativeWorkspace) hand-ported to plain JS. Same bridge methods
// (workspace.list/read/write), path rules, 1 MiB limit and errors as the compiled module
// (tests/plugin-x4-workspace.test.mjs). MAX_WORKSPACE_TEXT_BYTES is copied (not exported by the
// fixed native-host.js).
const MAX_WORKSPACE_TEXT_BYTES = 1024 * 1024;

function relativePath(path) {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new TypeError("Workspace paths must be relative paths using forward slashes");
  }
  if (path.split("/").includes("..")) throw new TypeError("Workspace paths cannot contain '..'");
  return path;
}

/** Text workspace tools only. This is deliberately not a complete ExecutionEnv. */
export function createNativeWorkspace(bridge) {
  return {
    async list(path = "") { return bridge.call("workspace.list", { path: relativePath(path) }); },
    async read(path) {
      const result = await bridge.call("workspace.read", { path: relativePath(path) });
      if (typeof result?.text !== "string") throw new TypeError("Native workspace returned invalid text");
      if (new TextEncoder().encode(result.text).byteLength > MAX_WORKSPACE_TEXT_BYTES) {
        throw new RangeError("Workspace text exceeds the 1 MiB limit");
      }
      return result.text;
    },
    async write(path, text) {
      const resolved = relativePath(path);
      if (typeof text !== "string") throw new TypeError("Workspace content must be text");
      if (new TextEncoder().encode(text).byteLength > MAX_WORKSPACE_TEXT_BYTES) {
        throw new RangeError("Workspace text exceeds the 1 MiB limit");
      }
      await bridge.call("workspace.write", { path: resolved, text });
    }
  };
}
