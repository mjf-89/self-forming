import type { NativeBridge } from "./bridge.ts";
import { MAX_WORKSPACE_TEXT_BYTES } from "./wire.ts";

export interface WorkspaceEntry { name: string; path: string; directory: boolean; size: number }
export interface NativeWorkspace {
  list(path?: string): Promise<WorkspaceEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

function relativePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new TypeError("Workspace paths must be relative paths using forward slashes");
  }
  if (path.split("/").includes("..")) throw new TypeError("Workspace paths cannot contain '..'");
  return path;
}

/** Text workspace tools only. This is deliberately not a complete ExecutionEnv. */
export function createNativeWorkspace(bridge: NativeBridge): NativeWorkspace {
  return {
    async list(path = "") { return bridge.call<WorkspaceEntry[]>("workspace.list", { path: relativePath(path) }); },
    async read(path) {
      const result = await bridge.call<{ text: string }>("workspace.read", { path: relativePath(path) });
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
    },
  };
}
