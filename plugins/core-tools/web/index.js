// core-tools: read, write, edit and bash/javascript (docs/plugins.md §9a A2). Essential
// built-in agent row (implementation: tools.js, X2); merged into the ONE permanent extension "self-forming-native"
// (order 10, before core-self-update and core-plugin-management). Consumed by
// core-agent-plugins.js. No library import at module evaluation.

export const row = Object.freeze({
  extension: "self-forming-native", order: 10,
  unavailable: (caps) => caps.executionEnv ? undefined : "This host has no execution environment for file and shell tools.",
  tools: (_caps, hostInfo) => fileAndShellToolNames(hostInfo),
  load: () => import("./tools.js"),
  create: (builders, host) => host.env ? builders.fileAndShellTools({
    hostInfo: host.hostInfo,
    env: host.env,
    injectSecrets: host.hostInfo?.capabilities?.secrets === true,
    backgroundExecution: host.env.backgroundExecution
  }) : null
});

// Static tool-name declaration (no library import; the builders are in tools.js, loaded lazily).
// Browser edition (E1): the declaration covers both shells the page offers; each session creates
// only the one of its execution environment (env.shell: Linux -> bash, JavaScript -> javascript).
function fileAndShellToolNames(hostInfo) {
  const browser = hostInfo?.platform === "browser";
  if (!browser) return ["read", "write", "edit", "bash"];
  return ["read", "write", "edit", ...hostInfo?.capabilities?.linuxShell ? ["bash"] : [], "javascript"];
}
