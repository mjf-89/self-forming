// Application guidance is rendered by pi-durable before every model request. Selection is conversation state,
// separate from the agent's short, task-specific instructions, and follows a fork's historical cutoff.
import { defineDoc, defineExtension, section } from "./library/pi-durable.js";

export const MAIN_PROMPT_SECTIONS = Object.freeze(["device", "app", "selfRebuild", "subagents", "servers", "agentsGuide"]);
export const PROMPT_SECTIONS = Object.freeze([...MAIN_PROMPT_SECTIONS, "transcript"]);
// Keep established context option names; native pi-durable section keys are lowercase tags.
const SECTION_KEYS = { selfRebuild: "self-rebuild", agentsGuide: "agents-guide" };

export const PromptSelectionDoc = defineDoc({
  kind: "self-forming.prompt-sections",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  // null means this conversation has not adopted section selection yet. In particular, old helpers already
  // carry their complete selected prompt in agent.instructions; never silently add the main agent's context.
  initial: () => ({ sections: null, transcript: "" })
});

/** Selected section names and optional captured parent context; call in the same transaction as child creation. */
async function configurePrompt(tx, conversationId, { sections = MAIN_PROMPT_SECTIONS, transcript = "" } = {}) {
  if (!Array.isArray(sections) || sections.some(name => !PROMPT_SECTIONS.includes(name)))
    throw new Error(`Unknown context sections. Use: ${PROMPT_SECTIONS.join(", ")}.`);
  if (typeof transcript !== "string") throw new Error("Prompt transcript must be text.");
  const selected = await tx.doc(PromptSelectionDoc, conversationId);
  selected.sections = [...new Set(sections)];
  selected.transcript = selected.sections.includes("transcript") ? transcript : "";
}

export function createPromptExtension({ nativeEnvironment, appRevision, apkInstaller, projectGuide = "" } = {}) {
  const available = input => new Set(input.agent.tools.map(tool => tool.name));
  const directory = input => input.env?.cwd ?? input.agent.cwd ?? nativeEnvironment?.cwd;
  const canEdit = tools => tools.has("write") || tools.has("edit") || tools.has("workspace_write");
  const renderers = {
    device(input) {
      const tools = available(input);
      const fileTools = ["read", "write", "edit", "workspace_read", "workspace_write", "workspace_list"].filter(name => tools.has(name));
      const parts = [nativeEnvironment
        ? `You are a helpful assistant running on the user's Android device. Your workspace is ${directory(input)}.`
        : "You are a helpful assistant running on the user's device. Your workspace is private to this app."];
      if (fileTools.length) parts.push(`The available file tools are ${fileTools.join(", ")}. Use them only within your assigned workspace.`);
      if (nativeEnvironment && tools.has("bash")) parts.push(
        "Use bash for commands. Bash runs inside a minimal Ubuntu 24.04 environment with git, curl, ripgrep (rg), jq, coreutils and BusyBox. On ARM64, bundled Box64 runs supported x86-64 Linux programs through PRoot without root. Java, Gradle and the Android SDK are installed only when needed: inspect pi-android status, install with pi-android install --accept-licenses when authorized to build Android apps and accept the SDK license, then verify with pi-android doctor. Downloaded tools and caches persist in /opt/pi-android across app updates. Use ordinary Git and curl commands through bash; there are no separate Git or HTTP tools. The environment has no Node.js, Bun, Python, Docker daemon or SSH client. Git commits need the user's name and email: ask rather than inventing identity.",
        "Commands do not have interactive stdin. Use explicit, noninteractive commands. When the Bash description advertises background execution, explicitly backgrounded servers can continue while the app is hidden."
      );
      else if (!tools.has("bash")) parts.push("No command execution tool is offered to you.");
      parts.push(
        "Use only tools offered in this conversation. Never request secrets in chat or print credentials. User-enabled service secrets may be injected into command environment variables at execution time; use them without echoing values or using shell tracing. Do not inspect .pi-secrets/vault.key or browser credential storage to recover secrets. Avoid env/printenv commands that dump credentials. Existing ChatGPT credentials are for model access, not CLI tools.",
        "Keep work in the workspace. Keep the app open while the agent is replying. Check results before reporting success. Network and write operations may have completed partly after interruption; inspect before retrying."
      );
      return parts.join(" ");
    },
    app(input) {
      const tools = available(input);
      if (!nativeEnvironment || !appRevision || !canEdit(tools)) return;
      const parts = [tools.has("app_update")
        ? "You can modify this app when the user requests it. First call app_update with action info to obtain sourcePath and the host revision rules."
        : "You are helping edit this app. Work only on files assigned by the main agent; ask it for the current editable source path if it was not supplied. The main agent handles applying revisions."];
      parts.push("Use the existing file tools to edit the assigned files directly as browser JavaScript modules, HTML and CSS. Do not add TypeScript, npm dependencies, a build step or a JavaScript framework. The bundled upstream Pi library stays fixed; use its existing browser API.");
      if (tools.has("app_update")) parts.push("Check the changes, then call app_update with action apply by itself as the final step. Apply stages a revision and ends the run so the host can reload after the tool result is committed. Staging is not proof that the changed app boots; the host verifies startup and can restore the prior revision.");
      else parts.push("Check the changes and return what changed, the edited paths and any unverified behavior to the main agent.");
      parts.push(`Before larger changes read ${directory(input)}/self-forming/AGENTS.md (section Self-modification). The plain monospace look is a deliberately neutral starting point: when the user repurposes the app, change its visual identity and design style to fit the new purpose.`);
      if (tools.has("subagent")) parts.push("Act as the orchestrator: offload work to subagents, in parallel where parts are independent (separate files), then merge, check and apply yourself.");
      parts.push(`Copy changes the user wants to keep to ${directory(input)}/self-forming/apps/on-device so rebuilt and descendant apps keep them. Coordinate shared paths with the main agent when working as a helper.`);
      return parts.join(" ");
    },
    selfRebuild(input) {
      const tools = available(input);
      if (!nativeEnvironment || !tools.has("bash")) return;
      const cwd = directory(input);
      const parts = [
        `You can rebuild this whole app, including its native Android (Kotlin) part, on this phone with the Android SDK. Before doing so, read ${cwd}/self-forming/skills/self-rebuild/SKILL.md and follow it within your offered tools.`,
        `The source repository is ${cwd}/self-forming (unpacked from the APK on first launch; its dist/ is refreshed from every installed APK). The signing key is ${cwd}/self-forming/.signing/ (self-forming.p12, alias self-forming, password in the file password; build-apk.sh uses it automatically; never print, commit or send the key or the password).`,
        `The Android build tools install in the background after the first start (log ${cwd}/.self-forming/toolchain.log; check with pi-android status).`
      ];
      if (appRevision && tools.has("app_update")) parts.push("app_update only changes the web layer. The live web app source is the sourcePath that app_update info returns.");
      else parts.push("The source repository and the current editable web app are separate copies; obtain the active edit path from the main agent when needed.");
      parts.push(apkInstaller && tools.has("app_install_apk")
        ? "Install a finished APK with app_install_apk."
        : "Return the finished APK path and verification results to the main agent for installation.");
      return parts.join(" ");
    },
    subagents(input) {
      if (!available(input).has("subagent")) return;
      return "You can delegate work to subagents with the subagent tool, each with the model, tools and context sections the task needs: action run waits for a focused helper and returns its answer (use it for self-contained steps); action spawn starts a named background subagent and its answer arrives later as a new message starting with [subagent NAME answered], so keep talking with the user meanwhile (use it for long independent work: research, builds, edits in separate folders). Pick a cheaper model (model fast, or one from action models) for simple work and a stronger one for hard work; give only the tools and context sections it needs. Give parallel helpers separate files and integrate and verify their work before reporting success.";
    },
    servers(input) {
      if (!available(input).has("manage_server")) return;
      return "To run dev servers or other long-running processes, use manage_server instead of nohup: servers are supervised, restarted when they crash and after app restarts; check them with status and logs.";
    },
    agentsGuide(input) {
      const guide = projectGuide.trim();
      if (!guide) return;
      const tools = available(input);
      const mainOnly = ["subagent", "app_update", "app_install_apk"].filter(name => !tools.has(name));
      return mainOnly.length
        ? `The following project guidelines describe the whole application's workflow. They do not grant capabilities. Operations involving ${mainOnly.join(", ")} belong to the main agent; hand those steps back instead of attempting them. Follow the applicable design and safety guidance using only your offered tools.\n\n${guide}`
        : guide;
    },
    transcript(_input, selected) {
      const text = selected?.transcript?.trim();
      if (text) return `Recent conversation between the user and the main assistant, for context:\n${text}`;
    }
  };
  const PromptExtension = defineExtension({
    name: "self-forming-prompts",
    sections: PROMPT_SECTIONS.map(name => section(SECTION_KEYS[name] ?? name, async (input, context) => {
      const selected = await input.read.snapshot(PromptSelectionDoc, input.conversationId, context);
      const chosen = selected?.sections ?? (input.agent.instructions?.trim() ? [] : MAIN_PROMPT_SECTIONS);
      if (!chosen.includes(name)) return;
      const text = renderers[name](input, selected);
      return typeof text === "string" && text.trim() ? text.trim() : undefined;
    }))
  });
  return { PromptExtension, configurePrompt };
}
