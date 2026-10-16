// core-workspace-tools implementation (moved verbatim from apps/common/native-tools.js, X2):
// workspace_read/write/list. Loaded lazily by the row (index.js load()).
import { Type } from "../../../library/pi-ai.js";
import { defineTool } from "../../../library/pi-durable.js";
/** workspace_read/write/list over a workspace {read, write, list} (formerly built in session.js). */
function workspaceTools(workspace) {
  return [
    defineTool({
      name: "workspace_read",
      description: "Read a UTF-8 text file in the private workspace.",
      parameters: Type.Object({ path: Type.String() }),
      replay: "safe",
      async execute({ path }) {
        return { output: [{ type: "text", text: await workspace.read(path) }] };
      }
    }),
    defineTool({
      name: "workspace_write",
      description: "Write a UTF-8 text file in the private workspace, replacing existing contents.",
      parameters: Type.Object({ path: Type.String(), text: Type.String() }),
      replay: "unsafe",
      executionMode: "sequential",
      async execute({ path, text }) {
        await workspace.write(path, text);
        return { output: [{ type: "text", text: `Saved ${path}` }] };
      }
    }),
    defineTool({
      name: "workspace_list",
      description: "List files in a directory of the private workspace.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      replay: "safe",
      async execute({ path }) {
        return { output: [{ type: "text", text: JSON.stringify(await workspace.list(path)) }] };
      }
    })
  ];
}
export { workspaceTools };
