// apps/common/app.js
import { createNativeBridge } from "./native-host.js";
import { createAuthHost, createSelectedFetch } from "./auth-host.js";
import { createAppRevisions, createSessionCloser } from "./app-revisions.js";
import { deliverFollowUp, markActivated } from "./app-update-followup.js";
import { initSettings } from "./settings.js";
import { createAgentExtensions, READY_TIMEOUT_MS } from "./agent-extensions.js";
import { createAgentProviders } from "./agent-providers.js";
import { initPluginSettings } from "./builtin/core-plugin-management/web/plugin-settings.js";
import { createAgentSessions, setPageAgentSessions } from "./agent-sessions.js";
import { createChatHost, setPageChatHost } from "./chat-host.js";
import { builtinPlugin } from "./builtin-plugins.js";
import { CORE_PROVIDER_ROWS } from "./core-providers.js";
import { mountBundledProviderPanels } from "./provider-panels.js";
var settingsUi = initSettings();
// Built-in provider panels (S1a): their markup lives in plugins/core-providers-*/web and the
// plugins contribute them as settings.sections; the bundled copies go into #provider-panels
// now, before the element lookups below, so the IDs exist even if composition fails.
mountBundledProviderPanels({ rows: CORE_PROVIDER_ROWS });
// Secrets (S1b): the screen is plugins/core-secrets/web (contributed as settings.sections, slot
// "secrets"); its bundled copy goes into #secrets-panel now and is wired below, so Secrets
// appears even if composition fails.
var coreSecrets = builtinPlugin("core-secrets").entry;
coreSecrets.mountBundled();
// Plugins and Background work (S1c): screens owned by core-plugin-management and core-execution
// (settings.sections, slots "plugins"/"execution"); the bundled copies go into their slots now and
// are wired below, so both exist (Plugins is the way to recover) even if composition fails.
var coreExecution = builtinPlugin("core-execution").entry;
// X4: fetch (core-net-native, net.fetch@1), workspace (core-execution) and Claude sign-in (core-providers-claude) are
// implemented in their plugins; these statically registered copies are the page's bundled
// fallback. native-host.js stays the last resort for each. ChatGPT sign-in (X4b) is core-providers-chatgpt.
var coreNet = builtinPlugin("core-net-native").entry;
var coreClaude = builtinPlugin("core-providers-claude").entry;
var coreChatGPT = builtinPlugin("core-providers-chatgpt").entry;
// X3: the conversation store is opened by core-storage (storage@1); its statically registered copy
// is the page's bundled fallback (session options below).
var coreStorage = builtinPlugin("core-storage").entry;
coreExecution.mountBundled();
builtinPlugin("core-plugin-management").entry.mountBundled();
// Page-owned session lifecycle (agent-sessions.js): foreground state, the open/close
// transition chain, agent.stopped and host.keepAlive. Its facade is agent.sessions@1,
// provided by the essential core-agent built-in (plugin-builtins.js), whose setup opens the
// sessions (step C3d); the bundled core-agent copy does when composition is unavailable.
// The chat (core-chat, C7) keeps the draft: closing saves what its composer holds.
var sessionCloser = createSessionCloser((current) => chatHost.chat?.saveDraft(current) ?? Promise.resolve());
// Sessions whose native execution env opened (Settings shows the native section).
var nativeSessions = new WeakSet();
var sessions = createAgentSessions({
  closer: sessionCloser,
  blocked: () => appReloading,
  reloadRefusal,
  onReloading(value) {
    appReloading = value;
    const current = sessions.current();
    if (current) render(current.snapshot);
  },
  onOpenError(cause) {
    status.textContent = "Could not open your conversation";
    showError(cause);
  },
  onStopped() {
    status.textContent = "Stopped.";
  },
  reportError: (cause) => showError(cause)
});
setPageAgentSessions(sessions);
// The page's part of a session change; the chat (core-chat) follows agent.sessions@1 itself.
sessions.onSession((opened) => {
  if (opened) {
    // After app.info/app.ready: the conversation that applied an update gets its one follow-up input (app-update-followup.js).
    void revisions?.sessionOpened(opened).then((info) => info && sessions.current() === opened ? deliverFollowUp(opened, info.revision) : void 0).catch((cause) => console.error("App update follow-up failed", cause));
    void watchToolchain(opened);
    if (nativeSessions.has(opened)) element("native-settings").hidden = false;
    return;
  }
  revisions?.sessionClosed();
});
// Settings → Plugins "Reload now" (sessions.reloadNow): refused while an app update is
// waiting, sign-in is in progress or a chat operation runs.
function reloadRefusal() {
  if (revisions?.pending()) return "An app update is waiting to be applied. Try again after it reloads the app.";
  if (chatSigningIn() || Boolean(auth?.snapshot.busy) || Boolean(claudeAuth?.snapshot.busy)) return "Finish signing in first.";
  if (chatBusy()) return "Wait for the current action to finish.";
  return void 0;
}
// The conversations drawer (core-conversations, C7b) on agent.sessions@1: its nodes go in place
// now (the header looks the same before composition); core-conversations' setup wires it, or
// app.js wires the bundled copy when it did not (start()).
var coreConversations = builtinPlugin("core-conversations").entry;
coreConversations.mountBundled();
// The chat (core-chat, C7: plugins/core-chat/web/chat.js) on agent.sessions@1. This host gives it
// what is page-owned; app.js mounts the bundled copy when core-chat did not (start()).
var markBegun;
var chatHost = setPageChatHost(createChatHost({
  reloading: () => appReloading,
  auth: () => auth,
  claudeAuth: () => claudeAuth,
  begun: new Promise((resolve) => { markBegun = resolve; }),
  afterRender,
  revisionControls: () => revisions?.controls(),
  applyQueued: (current) => revisions?.applyQueued(current)
}));
var chatBusy = () => Boolean(chatHost.chat?.busy());
var chatSigningIn = () => Boolean(chatHost.chat?.signingIn());
// Page-scoped composition starts once host transport is ready, independently of chat.
let pluginComposition;
// Page-owned: every session (reopened after background or an app revision) attaches
// its registry to it; closing a session never stops plugins.
const agentExtensions = createAgentExtensions({
  onError: (cause, details) => console.error("Plugin agent tools unavailable", details, cause)
});
// Page-owned as well: model provider rows (core-providers-* and plugin providers).
const agentProviders = createAgentProviders({ onError: (cause, details) => console.error("Model provider plugin unavailable", details, cause) });
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found;
}
var agentSettings = element("agent-settings");
var status = element("status");
var error = element("error");
var native = "PiNative" in globalThis;
var auth;
var claudeAuth;
var appReloading = false;
var revisions;
var applyingQueued = false;
var pluginSettings = initPluginSettings({
  agentExtensions,
  agentProviders,
  getSession: () => sessions.current(),
  reloadNow: () => sessions.reloadNow(),
  locked: () => !sessions.foreground || appReloading,
  showError: (cause) => showError(cause)
});
function showError(cause) {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
}
// Renders the chat (core-chat) with a snapshot; without a mounted chat only the page's part runs.
function render(snapshot) {
  if (chatHost.chat) chatHost.chat.render(snapshot);
  else afterRender(snapshot);
}
// After every chat render: Settings → Plugins, then a queued app revision (activation chain,
// AGENTS.md "How activation works"; the finishing re-render and the 1.5 s retry stay here).
function afterRender() {
  pluginSettings.update();
  if (!applyingQueued && revisions && sessions.foreground && !chatBusy() && !appReloading) {
    applyingQueued = true;
    const queuedBefore = revisions.pending();
    Promise.resolve(revisions.applyQueued(sessions.current())).catch(showError).finally(() => {
      applyingQueued = false;
      if (!queuedBefore && revisions?.pending() && sessions.current()) render(sessions.current().snapshot);
    });
  }
}
var toolchainNote = document.getElementById("toolchain-note");
var toolchainWatch = 0;
async function watchToolchain(opened) {
  const mine = ++toolchainWatch;
  if (!toolchainNote) return;
  // toolchain@1 is provided by the optional core-toolchain plugin; without it (a fork, browser,
  // failed composition) the note stays hidden.
  const composition = await Promise.resolve(pluginComposition).catch(() => null);
  const toolchain = composition?.runtime?.service("toolchain", 1);
  if (!toolchain) {
    if (mine === toolchainWatch) toolchainNote.hidden = true;
    return;
  }
  while (sessions.current() === opened && mine === toolchainWatch) {
    const installed = await toolchain.installed().catch(() => void 0);
    if (sessions.current() !== opened || mine !== toolchainWatch) return;
    toolchainNote.hidden = installed !== false;
    if (installed !== false) return;
    await new Promise((resolve) => setTimeout(resolve, 2e4));
  }
}
// E1: the bundled (composition failed) browser environment uses the saved execution@1 choice
// (Settings → Providers), else the default: Linux when the page offers it, else JavaScript.
// The same page shells as the composed providers (one VM), never a second backend.
function bundledBrowserShell(hostInfo) {
  let choice = null;
  try { choice = localStorage.getItem("self-forming.provider.execution@1"); } catch {}
  const linux = builtinPlugin("exec-linux")?.entry, js = builtinPlugin("exec-js")?.entry;
  return choice !== "exec-js" && linux?.offered(hostInfo) ? linux.SHELL_ID : js?.SHELL_ID ?? "javascript";
}
async function start() {
  try {
    const bridge = native ? createNativeBridge() : void 0;
    // host.lifecycle (foreground) and agent.stopped are followed by the session controller.
    if (bridge) sessions.connect({ bridge });
    const hostInfo = bridge ? await bridge.call("host.info") : void 0;
    globalThis.__piHostInfo = hostInfo;
    globalThis.__piBridge = bridge;
    coreSecrets.initSecretsSettings(bridge);
    const persistentExecution = hostInfo?.capabilities?.backgroundExecution === true;
    const owner = persistentExecution ? coreExecution.executionOwner() : void 0;
    if (bridge && persistentExecution) coreExecution.initExecutionSettings(bridge);
    // Initial foreground state from the host, unless a lifecycle event already set it.
    sessions.connect({ hostInfo });
    let host;
    const browserFetch = createSelectedFetch({
      fallback: () => globalThis.__piBrowser?.network?.fetch
    });
    try {
      host = createAuthHost(bridge, hostInfo?.platform === "browser" ? { fetch: browserFetch } : { createFetch: coreNet.createNet({ bridge }).createFetch });
      // Page-owned credential controllers; the chat (core-chat) wires their sign-in and shows
      // the browser sign-in links (openUrl).
      auth = (await coreChatGPT.loadChatGPTAuth())({ host, onOpenUrl: native ? void 0 : (url) => chatHost.chat?.openUrl("chatgpt", url) });
      claudeAuth = (await coreClaude.loadClaudeAuth())({ host, onOpenUrl: (url) => chatHost.chat?.openUrl("claude", url) });
    } catch {
    }
    const inBrowser = hostInfo?.platform === "browser";
    if (inBrowser) globalThis.__piBrowser?.activity?.setMetadata(mode =>
      agentProviders.rows().find(row => row.mode === mode) ?? CORE_PROVIDER_ROWS.find(row => row.mode === mode));
    if (inBrowser && globalThis.__piBrowser?.network?.settingsRuntime) {
      globalThis.__piBrowser.network.configureSettingsProvider(builtinPlugin("core-plugin-management").entry.providersSection);
      void settingsUi.sections.connect({ runtime: globalThis.__piBrowser.network.settingsRuntime });
    }
    element("storage-label").textContent = inBrowser ? "Saved in this browser" : native ? "Saved on this device" : "Local development";
    element("storage-note").textContent = inBrowser ? "Conversations and files stay in this browser on this device. Keep the tab open while it works." : native ? "Conversations and files stay on this device. Interrupted work is saved for when you reopen. Keep the app open while it works." : "Local development only \xB7 Conversations and files disappear when this page reloads.";
    if (bridge && hostInfo?.capabilities?.editableApp) revisions = createAppRevisions({
      bridge,
      getSession: () => sessions.current(),
      unavailable: () => !sessions.foreground || chatBusy() || chatSigningIn() || Boolean(auth?.snapshot.busy) || Boolean(claudeAuth?.snapshot.busy) || sessions.reloading,
      setApplying(value) {
        appReloading = value;
        if (sessions.current()) render(sessions.current().snapshot);
      },
      // Draft saved, then closed on the session controller's transition chain (awaited).
      async closeSession(current) {
        await sessions.closeForReload(current);
      },
      reopen: () => sessions.reconcile(),
      activated: markActivated,
      reportError: showError
    });
    if (revisions) setInterval(() => {
      if (revisions.pending() && sessions.current() && !applyingQueued) render(sessions.current().snapshot);
    }, 1500);
    // core-agent opens the sessions with these options (plugins/core-agent/web/open-sessions.js).
    // Its environment comes from execution@1 (core-execution); execution is the bundled
    // core-execution copy (X1) for when composition did not give the service.
    sessions.connect({ sessionOptions: {
      bridge, hostInfo, owner, revisions, agentExtensions, agentProviders,
      execution: coreExecution.createExecution({ bridge, hostInfo, owner, ...inBrowser ? { shell: bundledBrowserShell(hostInfo) } : {} }),
      chatgpt: auth,
      claude: claudeAuth,
      fetch: inBrowser ? browserFetch : host?.fetch,
      // Browser facade owns same-origin bypass and failed-composition recovery; composed
      // sessions must use that contract too, even if a credential controller failed to open.
      ...inBrowser ? { networkFetch: browserFetch } : {},
      workspace: coreExecution.createWorkspace({ bridge }),
      storage: coreStorage.createStorage({ bridge, hostInfo }),
      onOpened(opened, { env }) {
        if (bridge && env) nativeSessions.add(opened);
      }
    } });
    // Bundled core-agent copy (same rule as the core tools' fallback): used when composition
    // fails, core-agent did not open the sessions, or composition is not ready in time.
    // Bundled core-chat copy (C7), same rule: the chat on agent.sessions@1 when core-chat did
    // not mount it (composition failed, core-chat blocked or failed, or not ready in time).
    const bundledChat = () => {
      if (chatHost.mountedBy) return;
      console.error("core-chat unavailable: using the bundled copy");
      Promise.resolve().then(() => builtinPlugin("core-chat").entry.mountChat({ sessions, page: chatHost, by: "bundled" })).catch((cause) => {
        console.error("Chat unavailable", cause);
        showError(cause);
      });
    };
    // Bundled core-conversations copy (C7b), same rule: the drawer when core-conversations did not wire it.
    const bundledConversations = () => {
      if (coreConversations.conversationsMountedBy()) return;
      console.error("core-conversations unavailable: using the bundled copy");
      try { coreConversations.mountConversations({ sessions, by: "bundled", showError }); }
      catch (cause) { console.error("Conversations unavailable", cause); }
    };
    const bundledAgent = () => {
      bundledChat();
      bundledConversations();
      if (sessions.startedBy) return;
      console.error("core-agent unavailable: using the bundled copy");
      try { builtinPlugin("core-agent").entry.openSessions(sessions, "bundled"); }
      catch (cause) { status.textContent = "Could not open your conversation"; showError(cause); }
    };
    const agentDeadline = setTimeout(bundledAgent, READY_TIMEOUT_MS);
    pluginComposition = import("./plugin-bootstrap.js").then(({ startPluginComposition }) => startPluginComposition({
      bridge, hostInfo, agentExtensions, agentProviders,
      executionOwner: owner,
      onError: (cause, details) => console.error("Plugin unavailable", details, cause)
    })).catch((cause) => { console.error("Plugin composition unavailable", cause); if (inBrowser) { globalThis.__piBrowser?.network?.bind(null); globalThis.__piBrowser?.git?.bind(null); } agentExtensions.unavailable(cause); agentProviders.unavailable(cause); return null; }).then((composition) => {
      // Settings → Plugins: built-ins from the runtime, installed packages from the host.
      try { void settingsUi.sections.connect({ runtime: inBrowser ? globalThis.__piBrowser?.network?.settingsRuntime : composition?.runtime }); } catch (cause) { console.error("Settings sections unavailable", cause); }
      try { void pluginSettings.connect({ runtime: composition?.runtime, installed: composition?.installed, bridge, hostInfo, reloadNow: () => sessions.reloadNow() }).catch((cause) => console.error("Plugin settings unavailable", cause)); }
      catch (cause) { console.error("Plugin settings unavailable", cause); }
      return composition;
    }).finally(() => {
      clearTimeout(agentDeadline);
      globalThis.__sfSplash?.mark("composed"); // browser boot cover (browser-splash.js); nothing on Android
      bundledAgent();
    });
    await sessions.begun;
    if (!sessions.foreground) status.textContent = "Work paused while the app is in the background";
    // The chat restores the ChatGPT/Claude sign-ins now (chat.js, as app.js did here).
    markBegun();
  } catch (cause) {
    status.textContent = "Could not open your conversation";
    showError(cause);
  }
}
void start();
