// core-plugin-management implementation (moved verbatim from apps/common/native-tools.js, X2):
// the `plugins` agent tool. Loaded lazily by the row (index.js load()).
import { Type } from "../../../library/pi-ai.js";
import { defineTool } from "../../../library/pi-durable.js";
function pluginManagementTool(host) {
  return defineTool({
    name: "plugins",
    description: "Manage trusted application plugins: list, install a workspace package, enable, disable, rollback, or call a native method pinned to its revision hash. No plugin approval is required. Changes to loaded native code may require restarting the app; web composition changes take effect on the next page load. Inspect returned state; installation is not proof of activation. Do not automatically retry uncertain mutations after a disconnect. Build Kotlin packages with self-forming/scripts/plugin.sh first; see skills/plugins/SKILL.md.",
    parameters: Type.Object({
      action: Type.Union(["list", "install", "enable", "disable", "rollback", "call"].map((value) => Type.Literal(value))),
      path: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      hash: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    replay: "unsafe",
    executionMode: "sequential",
    async execute({ action, path, id, hash, method, input }, _api, context) {
      context.abortSignal?.throwIfAborted();
      let params = {};
      if (action === "install") {
        if (!path) throw new Error("install requires a workspace package path");
        params = { path };
      } else if (action !== "list") {
        if (!id) throw new Error(`${action} requires a plugin id`);
        params = { id };
        if (action === "call") {
          if (!hash || !method) throw new Error("call requires a revision hash and method; list first");
          params = { id, hash, method, input: input ?? {} };
        }
      }
      const result = await host.call(`plugins.${action}`, params);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    }
  });
}
export { pluginManagementTool };
