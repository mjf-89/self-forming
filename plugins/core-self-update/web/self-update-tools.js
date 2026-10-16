// core-self-update implementation (moved verbatim from apps/common/native-tools.js, X2):
// app_update and app_install_apk. Loaded lazily by the row (index.js load()).
import { Type } from "../../../library/pi-ai.js";
import { defineTool } from "../../../library/pi-durable.js";
/** app_update (with an app revision host) and app_install_apk (with an APK installer). */
function selfUpdateTools({ appRevision, staged, apkInstaller } = {}) {
  const update = appRevision ? defineTool({
    name: "app_update",
    description: "Inspect the editable app source location (info), or stage the edited plain JavaScript, HTML and CSS for activation once this tool result is saved (apply). Edit and check the source with read/write/edit/bash first. Call apply by itself, as the last tool call of this step: it saves a revision, ends this turn and the app reloads right away. After the reload you receive a follow-up message in this conversation saying whether the new revision started (or the previous one was restored); then carry on with your work (e.g. the next incremental change). Do not write more after apply. It does not claim the new app has loaded successfully. No compiler or npm is required. Upstream Pi library modules stay fixed.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("info"), Type.Literal("apply")]) }),
    replay: "unsafe",
    executionMode: "sequential",
    async execute({ action }, api, context) {
      context.abortSignal?.throwIfAborted();
      if (action === "info") {
        const info = await appRevision.info();
        context.abortSignal?.throwIfAborted();
        if (typeof info.sourcePath !== "string" || !info.sourcePath) throw new Error("The host returned no editable app source path.");
        return { output: [{ type: "text", text: JSON.stringify(info) }] };
      }
      staged?.(void 0);
      const result = await appRevision.stage();
      context.abortSignal?.throwIfAborted();
      if (typeof result.revision !== "string" || !result.revision || result.revision.length > 160)
        throw new Error("The host returned an invalid staged app revision.");
      staged?.(result.revision, { taskId: api.taskId, conversationId: api.conversationId, callId: api.callId });
      return {
        output: [{ type: "text", text: `App revision ${result.revision} is staged. It will be activated once this result is saved. This turn ends here and the app reloads now; after the reload you get a follow-up message in this conversation (startup OK, or the previous revision was restored), and you can continue working. If the app is interrupted before reloading, use Edit this app \u2192 Apply edits again.` }],
        details: { action: "apply", revision: result.revision, staged: true },
        // The turn ends with nothing in flight, so activation (closeForReload) has no model request to interrupt and the
        // reload is immediate. The conversation continues through the follow-up input of app-update-followup.js.
        control: { terminate: true }
      };
    }
  }) : void 0;
  return [...update ? [update] : [], ...apkInstaller ? [installApkTool(apkInstaller)] : []];
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
      return { output: [{ type: "text", text: String(result?.text ?? "") }] };
    }
  });
}
export { selfUpdateTools };
