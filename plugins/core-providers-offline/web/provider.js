// Built-in model provider row "offline" (the scripted demo).
// Static part from step P1a of docs/plugins-providers-agent-core.md: mode, provider ids,
// labels, default model, catalog, thinking efforts and the subagent "fast" choice.
// Session-bound part from step P1b: create(host) builds the faux provider with api
// "self-forming-offline" and its scripted steps (moved verbatim from session.js). It is
// not credential-gated, so it returns a complete pi-ai `provider` that the session
// engine (session-providers.js) installs as is.
//
// Permanent: mode "offline", provider id "faux", model "faux-1" (docs §C).
// No library import: the faux helpers come from the engine (host.ai), the message
// helpers from session.js (host.messages).
const MODEL_ID = "faux-1";

export const providerRow = Object.freeze({
  mode: "offline",
  providerIds: Object.freeze(["faux"]),
  label: "Offline demo",          // #mode option text (index.html)
  requestLabel: "Offline demo",   // not used for requests: the demo never reaches the network
  waitingLabel: "Offline demo",
  auth: "none",
  order: 0,
  // Accepted as faux/faux-1 by subagents, but not listed by the models action (today's behaviour).
  listed: false,
  defaultModelId: MODEL_ID,
  // modelSettings() always stores this model id for the mode, whatever was asked for.
  fixedModelId: MODEL_ID,
  catalog: () => [{ id: MODEL_ID, name: "Offline demo" }],
  // No catalog model: the offline mode has no thinking control and no bundled pi-ai model.
  catalogModel: () => void 0,
  thinkingEfforts: () => [],
  // No preference: the engine's generic choice picks faux-1 (the only model).
  fastModel: () => void 0,
  /**
   * host: {ai: {fauxProvider, fauxAssistantMessage, fauxToolCall}, env (the native
   * execution env or undefined), demoTokensPerSecond, messages: {textOf,
   * attachedUserPresentation}}. The scripted steps depend on the tool names (write/read
   * with a native env, workspace_* otherwise).
   */
  create(host) {
    const { fauxProvider, fauxAssistantMessage, fauxToolCall } = host.ai;
    const { textOf, attachedUserPresentation } = host.messages;
    const nativeEnvironment = host.env;
    const demo = fauxProvider({
      api: "self-forming-offline",
      tokensPerSecond: host.demoTokensPerSecond ?? 100,
      tokenSize: { min: 4, max: 4 }
    });
    const offlineStep = (transcript) => {
      demo.appendResponses([offlineStep]);
      let userIndex = -1;
      for (let i = transcript.messages.length - 1; i >= 0; i--) {
        if (transcript.messages[i]?.role === "user") {
          userIndex = i;
          break;
        }
      }
      const user = transcript.messages[userIndex];
      const attached = user ? attachedUserPresentation(user) : void 0;
      const text = attached ? [attached.text, `Attached files: ${attached.attachments.map((item) => item.name).join(", ")}.`].filter(Boolean).join("\n\n") : user ? textOf(user) : "Hello from Self Forming";
      const results = transcript.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
      const failed = results.find((result) => result.isError);
      if (failed) return fauxAssistantMessage(`The offline demo could not complete its file check: ${textOf(failed)}`);
      if (!results.some((result) => result.toolName === (nativeEnvironment ? "write" : "workspace_write"))) {
        return fauxAssistantMessage(fauxToolCall(
          nativeEnvironment ? "write" : "workspace_write",
          nativeEnvironment ? { path: "demo-note.txt", content: text } : { path: "demo-note.txt", text }
        ), { stopReason: "toolUse" });
      }
      const read = results.find((result) => result.toolName === (nativeEnvironment ? "read" : "workspace_read"));
      if (!read) return fauxAssistantMessage(fauxToolCall(nativeEnvironment ? "read" : "workspace_read", { path: "demo-note.txt" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(`I saved your message to demo-note.txt and read it back:

${textOf(read)}

This is a scripted offline demo. The agent loop, file tools and conversation storage are real.`);
    };
    demo.setResponses([offlineStep]);
    return { provider: demo.provider };
  }
});
