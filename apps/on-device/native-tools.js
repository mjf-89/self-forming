// apps/on-device/native-tools.js
import { Type } from "./library/pi-ai.js";
import { defineExtension, defineTool } from "./library/pi-durable.js";
import { createBashTool, createReadTool, createWriteTool, createEditTool } from "./library/pi-durable/tools.js";
function nativeTools(appRevision, staged, injectSecrets, backgroundExecution = false, apkInstaller) {
  const bash = createBashTool({ prepare: async (execution) => {
    if (injectSecrets) execution.env = { ...execution.env, PI_SECRET_SCOPE: "agent" };
  } });
  if (backgroundExecution) bash.description += " Background processes can outlive a Bash call and remain running while the app is in the background. Start servers with stdin redirected from /dev/null and stdout/stderr to a log file; save the PID and verify with a separate command. Each call has a fresh shell: cd and exports do not carry to the next call. Cancellation stops that call's processes; Settings or the notification can stop the whole environment. Android process death or force-stop ends running processes; inspect before restarting.";
  const update = appRevision ? defineTool({
    name: "app_update",
    description: "Inspect the editable app source location (info), or stage the edited plain JavaScript, HTML and CSS for activation once this tool result is saved (apply). Edit and check the source with read/write/edit/bash first. Call apply by itself as the final step. It saves a revision and ends this tool round; unfinished conversations and subagents resume after reload. It does not claim the new app has loaded successfully. No compiler or npm is required. Upstream Pi library modules stay fixed.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("info"), Type.Literal("apply")]) }),
    replay: "unsafe",
    executionMode: "sequential",
    async execute({ action }, api, context) {
      context.abortSignal?.throwIfAborted();
      if (action === "info") {
        const info = await appRevision.info();
        context.abortSignal?.throwIfAborted();
        if (typeof info.sourcePath !== "string" || !info.sourcePath) throw new Error("The host returned no editable app source path.");
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      }
      staged?.(void 0);
      const result = await appRevision.stage();
      context.abortSignal?.throwIfAborted();
      if (typeof result.revision !== "string" || !result.revision || result.revision.length > 160)
        throw new Error("The host returned an invalid staged app revision.");
      staged?.(result.revision, { taskId: api.taskId, conversationId: api.conversationId, callId: api.callId });
      return {
        content: [{ type: "text", text: `App revision ${result.revision} is staged. It will be activated once this result is saved. Unfinished conversations and subagents resume after reload. Startup success has not been confirmed yet. If the app is interrupted before reloading, use Edit this app \u2192 Apply edits again.` }],
        details: { action: "apply", revision: result.revision, staged: true },
        control: { terminate: true }
      };
    }
  }) : void 0;
  return defineExtension({ name: "self-forming-native", tools: [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    bash,
    ...update ? [update] : [],
    ...apkInstaller ? [installApkTool(apkInstaller)] : []
  ] });
}
function installApkTool(installer) {
  return defineTool({
    name: "app_install_apk",
    description: "Install an APK update for this installed app, e.g. after rebuilding it with the self-rebuild skill. path is the APK's workspace path, absolute or relative to the workspace. Other packages are refused. Android asks the user to confirm the update (and, the first time, to allow this app to install unknown apps; then try again). The APK must be signed with the same key as the installed app. After the install the app restarts and this conversation is saved: finish your reply before calling it, and verify the new version afterwards.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }),
    replay: "unsafe",
    executionMode: "sequential",
    async execute({ path }, _api, context) {
      context.abortSignal?.throwIfAborted();
      const result = await installer.call("apk.install", { path });
      context.abortSignal?.throwIfAborted();
      return { content: [{ type: "text", text: String(result?.text ?? "") }] };
    }
  });
}
export {
  nativeTools
};
