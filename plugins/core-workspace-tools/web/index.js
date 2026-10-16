// core-workspace-tools: workspace_read / workspace_write / workspace_list (docs/plugins.md
// §9a A2). Essential built-in agent row; the permanent extension name is
// "self-forming-workspace". Consumed by core-agent-plugins.js.

export const row = Object.freeze({
  extension: "self-forming-workspace", order: 0,
  // Every host has a workspace: the native one, or the in-memory demo workspace.
  unavailable: () => undefined,
  tools: () => ["workspace_read", "workspace_write", "workspace_list"],
  load: () => import("./workspace-tools.js"),
  create: (builders, host) => host.workspace ? builders.workspaceTools(host.workspace) : null
});
