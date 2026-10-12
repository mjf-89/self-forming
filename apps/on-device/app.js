// apps/on-device/app.js
import { createNativeBridge } from "./native-host.js";
import { createChatGPTAuth, createClaudeAuth } from "./native-host.js";
import { openAppSession, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, getThinkingEfforts } from "./session.js";
import { createAuthHost } from "./auth-host.js";
import { openNativeExecutionEnv } from "./native-host.js";
import { createAppRevisions, createSessionCloser } from "./app-revisions.js";
import { initSettings } from "./settings.js";
import { initExecutionSettings, executionOwner } from "./execution-settings.js";
import { createChatRenderer } from "./chat-renderer.js";
import { initChatControls } from "./chat-controls.js";
import { initAttachmentComposer } from "./attachment-composer.js";
import { initSecretsSettings } from "./secrets-settings.js";
import { initConversations } from "./conversations.js";
initSettings();
initConversations({ getSession: () => session, showError });
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found;
}
var messages = element("messages");
var mainScroll = element("main-scroll");
var agentSettings = element("agent-settings");
var welcome = element("welcome");
var status = element("status");
var error = element("error");
var prompt = element("prompt");
var send = element("send");
var stop = element("stop");
var mode = element("mode");
var key = element("api-key");
var model = element("model");
var resume = element("resume");
var login = element("chatgpt-login");
var logout = element("chatgpt-logout");
var switchAccount = element("chatgpt-switch");
var cancelLogin = element("chatgpt-cancel");
var openLogin = element("chatgpt-open");
var accountStatus = element("auth-status");
var chatGPTModel = element("chatgpt-model");
var refreshModels = element("refresh-models");
var claudeLogin = element("claude-login");
var claudeLogout = element("claude-logout");
var claudeCancel = element("claude-cancel");
var claudeOpen = element("claude-open");
var claudeStatus = element("claude-auth-status");
var claudeCode = element("claude-code");
var claudeCodeForm = element("claude-code-form");
var claudeModel = element("claude-model");
var thinkingEffort = element("thinking-effort");
claudeModel.replaceChildren(...CLAUDE_MODELS.map((item) => new Option(item.name, item.id)));
claudeModel.value = DEFAULT_CLAUDE_MODEL;
var native = "PiNative" in globalThis;
var auth;
var claudeAuth;
var claudeAuthReady = false;
var claudeLoginOperation = false;
var claudeLoginCancelled = false;
var claudeLoginWindow = null;
var authReady = false;
var loginWindow = null;
var loginOperation = false;
var modelLoad = 0;
var modelsLoading = false;
var session;
var operation = false;
var foreground = true;
var appReloading = false;
var revisions;
var keepAliveSent = false;
var applyingQueued = false;
var chatRenderer = createChatRenderer({ messages, scroll: mainScroll });
var chatControls = initChatControls({ getSnapshot: () => session?.snapshot });
var attachmentPickerConversationId;
var pendingAttachmentSelection;
var attachmentImport = false;
var attachmentComposer = initAttachmentComposer({
  onPick() {
    if (!foreground || !session || operation || appReloading || session.snapshot.owned) return false;
    attachmentPickerConversationId = session.snapshot.conversation.id;
    return true;
  },
  onFiles(files) {
    if (!files.length) return;
    pendingAttachmentSelection = {
      files,
      conversationId: attachmentPickerConversationId ?? session?.snapshot.conversation.id ?? renderedConversationId
    };
    attachmentPickerConversationId = void 0;
    void importSelectedAttachments();
  },
  onRemove: (id) => removeDraftAttachment(id),
  onError: showError
});
var renderedConversationId;
var draftTimer;
var thinkingPreferencesKey = "self-forming.thinking.v1";
var thinkingPreferences = /* @__PURE__ */ new Map();
try {
  const saved = JSON.parse(localStorage.getItem(thinkingPreferencesKey) ?? "{}");
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [id, effort] of Object.entries(saved).slice(0, 100))
      if (id.length <= 300 && typeof effort === "string" && effort.length <= 20) thinkingPreferences.set(id, effort);
  }
} catch {
}
function selectedModel() {
  return mode.value === "chatgpt" ? chatGPTModel.value : mode.value === "claude" ? claudeModel.value : mode.value === "openai" ? model.value.trim() : "";
}
function thinkingKey() {
  return JSON.stringify([mode.value, selectedModel()]);
}
function updateThinking() {
  const needsSignIn = mode.value === "chatgpt" ? !auth?.snapshot.signedIn : mode.value === "claude" ? !claudeAuth?.snapshot.signedIn : false;
  const efforts = needsSignIn ? [] : getThinkingEfforts({ mode: mode.value, modelId: selectedModel() });
  const signature = JSON.stringify(efforts);
  if (thinkingEffort.dataset.options !== signature) {
    const names = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
    const defaultEffort = efforts.includes("off") ? "off" : efforts[0];
    const defaultLabel = defaultEffort ? `Default (${names[defaultEffort] ?? defaultEffort})` : "Default";
    thinkingEffort.replaceChildren(new Option(defaultLabel, ""), ...efforts.map((value) => new Option(names[value] ?? value, value)));
    thinkingEffort.dataset.options = signature;
  }
  const id = thinkingKey();
  const current = session?.snapshot;
  const saved = thinkingPreferences.has(id) ? thinkingPreferences.get(id) : current?.mode === mode.value && current?.modelId === selectedModel() ? current.thinkingEffort : "";
  thinkingEffort.value = efforts.includes(saved) ? saved : "";
  element("thinking-settings").hidden = !efforts.length || Boolean(current?.owned);
  thinkingEffort.disabled = !session || !foreground || Boolean(current?.busy) || operation || appReloading;
  element("thinking-note").textContent = current?.paused ? "Resuming keeps the thinking setting saved with that reply." : "";
}
async function importSelectedAttachments() {
  if (!pendingAttachmentSelection || !foreground || !session || operation || appReloading || session.snapshot.owned) return;
  const selected = pendingAttachmentSelection;
  pendingAttachmentSelection = void 0;
  const current = session;
  if (selected.conversationId !== current.snapshot.conversation.id) {
    showError(new Error("The conversation changed. Choose the files again in the intended conversation."));
    return;
  }
  operation = true;
  attachmentImport = true;
  error.hidden = true;
  render(current.snapshot);
  try {
    await current.addAttachments(selected.files, selected.conversationId);
  } catch (cause) {
    showError(cause);
  } finally {
    attachmentImport = false;
    if (session === current) {
      operation = false;
      render(current.snapshot);
    }
  }
}
async function removeDraftAttachment(id) {
  if (!foreground || !session || operation || appReloading || session.snapshot.busy) return;
  const current = session;
  operation = true;
  render(current.snapshot);
  try {
    await current.removeAttachment(id);
  } catch (cause) {
    showError(cause);
  } finally {
    if (session === current) {
      operation = false;
      render(current.snapshot);
    }
  }
}
function saveDraft(current = session) {
  clearTimeout(draftTimer);
  return current ? current.setDraft(prompt.value) : Promise.resolve();
}
function saveDraftSoon() {
  clearTimeout(draftTimer);
  const current = session;
  draftTimer = setTimeout(() => {
    if (session === current) void saveDraft(current).catch(showError);
  }, 250);
}
const sessionCloser = createSessionCloser(saveDraft);
function showError(cause) {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
}
function settings() {
  const thinking = thinkingEffort.value && getThinkingEfforts({ mode: mode.value, modelId: selectedModel() }).includes(thinkingEffort.value) ? { thinkingEffort: thinkingEffort.value } : {};
  if (mode.value === "chatgpt") return { mode: "chatgpt", modelId: chatGPTModel.value || void 0, ...thinking };
  if (mode.value === "claude") return { mode: "claude", modelId: claudeModel.value || DEFAULT_CLAUDE_MODEL, ...thinking };
  return mode.value === "openai" ? { mode: "openai", apiKey: key.value, modelId: model.value, ...thinking } : { mode: "offline" };
}
function updateMode() {
  const online = mode.value === "openai";
  const chatgpt = mode.value === "chatgpt";
  const claude = mode.value === "claude";
  element("chatgpt-account").hidden = !chatgpt;
  element("claude-account").hidden = !claude;
  element("openai-settings").hidden = !online;
  element("mode-description").textContent = "";
  renderAuth();
  chatControls.update();
}
function renderAuth() {
  const signedIn = auth?.snapshot.signedIn ?? false;
  element("chatgpt-settings").hidden = mode.value !== "chatgpt" || !signedIn;
  const busy = loginOperation || claudeLoginOperation || (auth?.snapshot.busy ?? false);
  const running = Boolean(session?.snapshot.busy && !session.snapshot.paused) || operation || appReloading;
  revisions?.controls();
  login.hidden = signedIn;
  login.disabled = busy || running || !auth;
  logout.hidden = !signedIn && !auth?.snapshot.message?.startsWith("Saved ChatGPT");
  logout.disabled = busy || running;
  switchAccount.hidden = !signedIn;
  switchAccount.disabled = busy || running;
  cancelLogin.hidden = !loginOperation;
  accountStatus.textContent = loginOperation ? "Finish signing in in your browser, then return here." : signedIn ? `Connected${auth?.snapshot.email ? ` \xB7 ${auth.snapshot.email}` : " to ChatGPT"}` : auth?.snapshot.message || "Connect your ChatGPT account to use its available models.";
  refreshModels.hidden = !signedIn;
  refreshModels.disabled = busy || running || modelsLoading;
  chatGPTModel.disabled = running || modelsLoading || !signedIn || !chatGPTModel.options.length || !chatGPTModel.value;
  const recovery = element("resume-panel").querySelector("p");
  if (recovery && session?.snapshot.paused) {
    const providers = session.snapshot.recoveryProviders ?? [session.snapshot.mode];
    const names = providers.map(provider => ({ openai: "OpenAI API key", chatgpt: "ChatGPT", claude: "Claude Code" })[provider]).filter(Boolean);
    recovery.textContent = `Saved work is waiting for ${names.join(" and ") || "model credentials"}. Open Settings to connect the account, or enter the API key and choose Resume. Work continues with its saved model.`;
  }
  const claudeSignedIn = claudeAuth?.snapshot.signedIn ?? false;
  element("claude-settings").hidden = mode.value !== "claude" || !claudeSignedIn;
  const claudeBusy = claudeLoginOperation || loginOperation || Boolean(claudeAuth?.snapshot.busy);
  claudeLogin.hidden = claudeSignedIn;
  claudeLogin.disabled = claudeBusy || running || !claudeAuth;
  claudeLogout.hidden = !claudeSignedIn && !claudeAuth?.snapshot.message?.startsWith("Saved Claude");
  claudeLogout.disabled = claudeBusy || running;
  claudeCancel.hidden = !claudeLoginOperation;
  claudeStatus.textContent = claudeAuth?.snapshot.message || (claudeSignedIn ? "Connected to Claude Code" : "Connect your Claude account through Claude Code sign-in.");
  const awaitingCode = Boolean(claudeAuth?.snapshot.awaitingCode && claudeLoginOperation);
  claudeCodeForm.hidden = !awaitingCode;
  claudeCode.disabled = !awaitingCode;
  element("claude-code-submit").disabled = !awaitingCode;
  if (!awaitingCode) claudeCode.value = "";
  claudeModel.disabled = !claudeSignedIn || running || !claudeModel.options.length;
  updateThinking();
}
async function loadModels() {
  if (!auth?.snapshot.signedIn) return;
  const current = ++modelLoad;
  const selected = session?.snapshot.mode === "chatgpt" ? session.snapshot.modelId : chatGPTModel.value;
  const note = element("chatgpt-note");
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  note.textContent = "Loading the models available to your ChatGPT account\u2026";
  modelsLoading = true;
  chatGPTModel.disabled = true;
  renderAuth();
  try {
    const models = await auth.listModels();
    if (current !== modelLoad || !auth.snapshot.signedIn) return;
    chatGPTModel.replaceChildren(...models.map((item) => new Option(item.name, item.id)));
    if (models.some((item) => item.id === selected)) chatGPTModel.value = selected;
    note.textContent = models.length ? "" : "No models were returned for this account. Check access in ChatGPT, then refresh.";
  } catch (cause) {
    if (current === modelLoad && auth.snapshot.signedIn) {
      chatGPTModel.replaceChildren(new Option("Could not load models", ""));
      note.textContent = `${cause instanceof Error && cause.message ? cause.message : "Available ChatGPT models could not be loaded."} Use Refresh models to retry.`;
    }
  } finally {
    if (current === modelLoad) {
      modelsLoading = false;
      renderAuth();
      chatControls.update();
    }
  }
}
async function signIn(newAccount = false) {
  if (!auth || loginOperation || claudeLoginOperation || operation || session?.snapshot.busy && !session.snapshot.paused) return;
  error.hidden = true;
  loginOperation = true;
  if (!native) {
    loginWindow = window.open("about:blank", "_blank");
    if (loginWindow) loginWindow.opener = null;
  }
  renderAuth();
  let signedIn = false;
  try {
    if (!authReady) {
      await auth.restore();
      authReady = true;
    }
    await auth.login({ newAccount });
    signedIn = true;
    if (!session?.snapshot.paused || session.snapshot.mode === "chatgpt") mode.value = "chatgpt";
    await loadModels();
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "AbortError")) showError(cause);
  } finally {
    loginOperation = false;
    loginWindow?.close();
    loginWindow = null;
    openLogin.hidden = true;
    openLogin.removeAttribute("href");
    updateMode();
  }
  if (signedIn) await resumeRecoveredReply();
}
async function signInClaude() {
  if (!claudeAuth || claudeLoginOperation || loginOperation || operation || session?.snapshot.busy && !session.snapshot.paused) return;
  error.hidden = true;
  claudeLoginOperation = true;
  claudeLoginCancelled = false;
  claudeCode.value = "";
  if (!native) {
    claudeLoginWindow = window.open("about:blank", "_blank");
    if (claudeLoginWindow) claudeLoginWindow.opener = null;
  }
  renderAuth();
  let signedIn = false;
  try {
    if (!claudeAuthReady) {
      await claudeAuth.restore();
      claudeAuthReady = true;
    }
    if (claudeLoginCancelled) throw new DOMException("Claude sign-in cancelled.", "AbortError");
    await claudeAuth.login();
    signedIn = true;
    if (!session?.snapshot.paused || session.snapshot.mode === "claude") mode.value = "claude";
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "AbortError")) showError(cause);
  } finally {
    claudeLoginOperation = false;
    claudeCode.value = "";
    claudeLoginWindow?.close();
    claudeLoginWindow = null;
    claudeOpen.hidden = true;
    claudeOpen.removeAttribute("href");
    updateMode();
  }
  if (signedIn) await resumeRecoveredReply();
}
function render(snapshot) {
  const conversationChanged = snapshot.conversation && snapshot.conversation.id !== renderedConversationId;
  if (conversationChanged) {
    renderedConversationId = snapshot.conversation.id;
    prompt.value = snapshot.conversation.draft ?? "";
    error.hidden = true;
    chatRenderer.render([]);
  }
  const locked = !session || !foreground || operation || appReloading;
  const steering = Boolean(session) && snapshot.busy;
  prompt.disabled = locked;
  send.disabled = locked;
  prompt.placeholder = steering ? "Steer the agent while it works\u2026" : "Transform yourself into\u2026";
  send.setAttribute("aria-label", steering ? "Steer the running reply" : "Send message");
  const titleEl = element("chat-title");
  titleEl.textContent = snapshot.title || "Self Forming";
  if (snapshot.owned) {
    const suffix = document.createElement("span");
    suffix.className = "chat-title-kind";
    suffix.style.cssText = "color:var(--muted);font-weight:400";
    suffix.textContent = ` \u00b7 ${snapshot.kind === "task" ? "task" : "subagent"}`;
    titleEl.append(suffix);
  }
  mode.disabled = !session || !foreground || snapshot.busy && !snapshot.paused || operation || appReloading;
  const anyRunning = Boolean(snapshot.anyBusy);
  // Keep the conversation alive in the background while a reply runs (host shows a notification with Stop).
  if (anyRunning !== keepAliveSent && globalThis.__piHostInfo?.capabilities?.backgroundReplies) {
    keepAliveSent = anyRunning;
    void globalThis.__piBridge?.call("host.keepAlive", { busy: anyRunning }).catch(() => {});
  }
  stop.hidden = !snapshot.busy;
  stop.disabled = !session || !foreground;
  resume.disabled = !session || !foreground || operation;
  element("resume-panel").hidden = !snapshot.paused;
  element("status-dot").classList.toggle("working", snapshot.busy && !snapshot.paused);
  const failed = snapshot.messages.at(-1)?.role === "assistant" && snapshot.messages.at(-1)?.error;
  status.textContent = !foreground ? "Paused in background" : attachmentImport ? "Adding files\u2026" : snapshot.paused ? "Waiting for credentials" : snapshot.busy ? "Working\u2026" : snapshot.anyBusy ? "Ready \u00b7 other conversations working" : failed ? "Reply failed" : "Ready";
  welcome.hidden = snapshot.messages.length > 0;
  if (snapshot.error) showError(snapshot.error);
  renderAuth();
  chatRenderer.render(snapshot.messages);
  let truncatedNote = document.getElementById("messages-truncated");
  const noteText = snapshot.loadingHistory ? "Loading earlier messages\u2026" : "Showing the latest messages";
  const showNote = Boolean((snapshot.loadingHistory || snapshot.truncated) && snapshot.messages.length);
  if (showNote || truncatedNote && !truncatedNote.hidden) {
    // The note sits above the messages: keep the messages where they are when it appears, changes or goes away.
    const messagesTop = messages.getBoundingClientRect().top;
    if (showNote) {
      if (!truncatedNote) {
        truncatedNote = document.createElement("p");
        truncatedNote.id = "messages-truncated";
        truncatedNote.style.cssText = "margin:0 0 12px;text-align:center;font-size:12px;color:var(--muted)";
        messages.before(truncatedNote);
      }
      if (truncatedNote.textContent !== noteText) truncatedNote.textContent = noteText;
      truncatedNote.hidden = false;
    } else truncatedNote.hidden = true;
    const shift = messages.getBoundingClientRect().top - messagesTop;
    if (!conversationChanged && mainScroll.scrollTop > 0 && Math.abs(shift) >= 1) mainScroll.scrollTo({ top: mainScroll.scrollTop + shift, behavior: "instant" });
  }
  chatControls.update(snapshot);
  attachmentComposer.update(snapshot.conversation?.attachments ?? [], { disabled: locked || Boolean(snapshot.owned), busy: attachmentImport });
  if (pendingAttachmentSelection && !locked) queueMicrotask(() => {
    void importSelectedAttachments();
  });
  if (!applyingQueued && revisions && foreground && !operation && !appReloading) {
    applyingQueued = true;
    const queuedBefore = revisions.pending();
    Promise.resolve(revisions.applyQueued(session)).catch(showError).finally(() => {
      applyingQueued = false;
      // A revision queued while this check was in flight would otherwise wait for the next render.
      if (!queuedBefore && revisions?.pending() && session) render(session.snapshot);
    });
  }
  if (conversationChanged) requestAnimationFrame(() => mainScroll.scrollTo({ top: mainScroll.scrollHeight, behavior: "instant" }));
}
async function sendMessage(text) {
  if (!foreground || !session || operation || appReloading || !text.trim() && !session.snapshot.conversation.attachments?.length) return;
  const current = session;
  error.hidden = true;
  operation = true;
  render(session.snapshot);
  const config = settings();
  key.value = "";
  const before = new Set(current.snapshot.messages.map((message) => message.id));
  const unsubscribe = current.subscribe((snapshot) => {
    if (session === current && prompt.value === text && snapshot.messages.some((message) => message.role === "user" && !before.has(message.id))) {
      prompt.value = "";
      chatControls.resizePrompt();
      void current.setDraft("").catch(showError);
    }
  });
  mainScroll.scrollTo({ top: mainScroll.scrollHeight, behavior: "instant" });
  try {
    await saveDraft(current);
    await current.send(text, config);
    // Admitted (a new reply or a queued steer): clear the box unless the user already typed something else.
    if (session === current && prompt.value === text) {
      prompt.value = "";
      chatControls.resizePrompt();
      void current.setDraft("").catch(showError);
    }
  } catch (cause) {
    if (session === current) {
      prompt.value = text;
      void saveDraft(current).catch(showError);
      showError(cause);
    }
  } finally {
    unsubscribe();
    config.apiKey = void 0;
    if (session === current) {
      operation = false;
      render(current.snapshot);
    }
  }
}
async function resumeReply(config = settings()) {
  if (!foreground || !session || operation || appReloading || !session.snapshot.paused) return;
  const current = session;
  error.hidden = true;
  key.value = "";
  operation = true;
  render(session.snapshot);
  try {
    await current.resume(config);
  } catch (cause) {
    if (session === current) showError(cause);
  } finally {
    config.apiKey = void 0;
    if (session === current) {
      operation = false;
      render(current.snapshot);
    }
  }
  await revisions?.applyQueued(current);
}
async function resumeRecoveredReply() {
  if (!native || !foreground || !session?.snapshot.paused || operation || loginOperation || claudeLoginOperation) return;
  if (session.snapshot.mode === "offline") await resumeReply({ mode: "offline" });
  else if (session.snapshot.mode === "chatgpt" && authReady && auth?.snapshot.signedIn)
    await resumeReply({ mode: "chatgpt" });
  else if (session.snapshot.mode === "claude" && claudeAuthReady && claudeAuth?.snapshot.signedIn)
    await resumeReply({ mode: "claude" });
}
element("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage(prompt.value);
});
// Enter inserts a new line (mobile chat convention); Ctrl/Cmd+Enter sends from a hardware keyboard.
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    void sendMessage(prompt.value);
  }
});
mode.addEventListener("change", updateMode);
for (const control of [model, chatGPTModel, claudeModel]) control.addEventListener("change", updateThinking);
model.addEventListener("input", updateThinking);
thinkingEffort.addEventListener("change", () => {
  const effort = thinkingEffort.value;
  if (effort && !getThinkingEfforts({ mode: mode.value, modelId: selectedModel() }).includes(effort)) return;
  thinkingPreferences.set(thinkingKey(), effort);
  try {
    localStorage.setItem(thinkingPreferencesKey, JSON.stringify(Object.fromEntries(thinkingPreferences)));
  } catch {
    element("thinking-note").textContent = "This choice is available now, but could not be saved for next time.";
  }
});
login.addEventListener("click", () => {
  void signIn();
});
switchAccount.addEventListener("click", () => {
  void signIn(true);
});
cancelLogin.addEventListener("click", () => {
  auth?.cancel();
});
refreshModels.addEventListener("click", () => {
  void loadModels();
});
logout.addEventListener("click", () => {
  if (!auth || operation) return;
  error.hidden = true;
  void auth.logout().then(({ revoked }) => {
    modelLoad++;
    modelsLoading = false;
    chatGPTModel.replaceChildren(new Option("Sign in to see your models", ""));
    if (!revoked) showError(new Error("Signed out on this device. Remote revocation could not be confirmed; you can disconnect Self Forming in ChatGPT Settings."));
    renderAuth();
  }).catch(showError);
});
claudeLogin.addEventListener("click", () => {
  void signInClaude();
});
claudeCancel.addEventListener("click", () => {
  claudeLoginCancelled = true;
  claudeCode.value = "";
  claudeAuth?.cancel();
});
claudeCodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = claudeCode.value.trim();
  if (!code || !claudeAuth?.snapshot.awaitingCode) return;
  claudeCode.value = "";
  if (!claudeAuth.submitCode(code)) claudeStatus.textContent = "Start signing in again to enter a new code.";
});
claudeLogout.addEventListener("click", () => {
  if (!claudeAuth || operation || claudeLoginOperation) return;
  error.hidden = true;
  void claudeAuth.logout().then(() => renderAuth()).catch(showError);
});
prompt.addEventListener("input", saveDraftSoon);
stop.addEventListener("click", () => {
  if (!foreground || !session) return;
  const current = session;
  stop.disabled = true;
  void current.stop().catch((cause) => {
    if (session === current) showError(cause);
  }).finally(() => {
    if (session === current) stop.disabled = false;
  });
});
resume.addEventListener("click", () => {
  void resumeReply();
});
const toolchainNote = document.getElementById("toolchain-note");
let toolchainWatch = 0;
/** Shows the Android SDK License line under the welcome text only while the build tools are not installed. */
async function watchToolchain(opened) {
  const mine = ++toolchainWatch;
  if (!toolchainNote || !opened.toolchain) return;
  while (session === opened && mine === toolchainWatch) {
    const installed = await opened.toolchain.installed().catch(() => void 0);
    if (session !== opened || mine !== toolchainWatch) return;
    toolchainNote.hidden = installed !== false;
    if (installed !== false) return;
    await new Promise((resolve) => setTimeout(resolve, 20e3));
  }
}
async function start() {
  try {
    const bridge = native ? createNativeBridge() : void 0;
    let lifecycleSeen = false;
    let reconcile = () => {
    };
    bridge?.subscribe((event) => {
      if (event.event !== "host.lifecycle") return;
      lifecycleSeen = true;
      foreground = event.foreground;
      reconcile();
    });
    bridge?.subscribe((event) => {
      if (event.event !== "agent.stopped") return;
      const current = session;
      if (!current?.snapshot.busy) return;
      void current.stop().then(() => {
        if (session === current) status.textContent = "Stopped.";
      }).catch((cause) => {
        if (session === current) showError(cause);
      });
    });
    const hostInfo = bridge ? await bridge.call("host.info") : void 0;
    globalThis.__piHostInfo = hostInfo;
    globalThis.__piBridge = bridge;
    initSecretsSettings(bridge);
    const persistentExecution = hostInfo?.capabilities?.backgroundExecution === true;
    const owner = persistentExecution ? executionOwner() : void 0;
    if (bridge && persistentExecution) initExecutionSettings(bridge);
    if (!lifecycleSeen) foreground = hostInfo?.foreground !== false;
    let host;
    try {
      host = createAuthHost(bridge);
      auth = createChatGPTAuth({ host, onOpenUrl: native ? void 0 : (url) => {
        openLogin.href = url;
        openLogin.hidden = false;
        if (loginWindow) loginWindow.location.replace(url);
      } });
      auth.subscribe(renderAuth);
      claudeAuth = createClaudeAuth({ host, onOpenUrl: (url) => {
        claudeOpen.href = url;
        claudeOpen.hidden = false;
        if (claudeLoginWindow) claudeLoginWindow.location.replace(url);
      } });
      claudeAuth.subscribe(renderAuth);
    } catch {
    }
    element("storage-label").textContent = native ? "Saved on this device" : "Local development";
    element("storage-note").textContent = native ? "Conversations and files stay on this device. Interrupted work is saved for when you reopen. Keep the app open while it works." : "Local development only \xB7 Conversations and files disappear when this page reloads.";
    let transition = Promise.resolve();
    let firstOpen = true;
    if (bridge && hostInfo?.capabilities?.editableApp) revisions = createAppRevisions({
      bridge,
      getSession: () => session,
      unavailable: () => !foreground || operation || loginOperation || claudeLoginOperation || Boolean(auth?.snapshot.busy) || Boolean(claudeAuth?.snapshot.busy),
      setApplying(value) {
        appReloading = value;
        if (session) render(session.snapshot);
      },
      async closeSession(current) {
        if (session !== current) throw new Error("The conversation changed before the app update.");
        session = void 0;
        revisions?.sessionClosed();
        const closing = sessionCloser.close(current, transition);
        transition = closing.settled;
        await closing.result;
      },
      reopen: () => reconcile(),
      reportError: showError
    });
    // A queued revision may wait on state that changes without a new render: retry it until it activates.
    if (revisions) setInterval(() => {
      if (revisions.pending() && session && !applyingQueued) render(session.snapshot);
    }, 1500);
    reconcile = () => {
      if (!foreground && session) {
        const previous = session;
        session = void 0;
        revisions?.sessionClosed();
        operation = false;
        const closing = sessionCloser.close(previous, transition);
        transition = closing.settled;
        void closing.result.catch(showError);
        render({ ...previous.snapshot, paused: previous.snapshot.busy });
      }
      transition = transition.then(async () => {
        if (!foreground || session || appReloading) return;
        sessionCloser.assertCanOpen();
        const env = bridge && hostInfo?.capabilities?.executionEnv ? await openNativeExecutionEnv(bridge, void 0, { owner }) : void 0;
        const opened = await openAppSession({
          bridge,
          env,
          chatgpt: auth,
          claude: claudeAuth,
          fetch: host?.fetch,
          ...bridge && hostInfo?.capabilities?.apkInstall === true ? { apkInstaller: { call: (method, params) => bridge.call(method, params) } } : {},
          ...revisions ? { appRevision: {
            info: revisions.info,
            stage: revisions.stage,
            onStaged: (revision) => revisions?.queue(opened, revision)
          } } : {}
        });
        if (!foreground) {
          await opened.close();
          return;
        }
        session = opened;
        renderedConversationId = void 0;
        if (firstOpen || opened.snapshot.paused) mode.value = opened.snapshot.mode;
        firstOpen = false;
        if (opened.snapshot.mode === "openai") model.value = opened.snapshot.modelId;
        if (opened.snapshot.mode === "chatgpt") chatGPTModel.value = opened.snapshot.modelId;
        if (opened.snapshot.mode === "claude") claudeModel.value = opened.snapshot.modelId;
        updateMode();
        opened.subscribe((snapshot) => {
          if (session === opened) render(snapshot);
        });
        void revisions?.sessionOpened(opened);
        void watchToolchain(opened);
        if (bridge && env) element("native-settings").hidden = false;
        void resumeRecoveredReply();
      }).catch((cause) => {
        if (foreground) {
          status.textContent = "Could not open your conversation";
          showError(cause);
        }
      });
    };
    reconcile();
    await transition;
    if (!foreground) status.textContent = "Work paused while the app is in the background";
    if (auth) {
      void auth.restore().then(async () => {
        authReady = true;
        if (auth?.snapshot.signedIn) await loadModels();
        renderAuth();
        await resumeRecoveredReply();
      }).catch(() => {
        accountStatus.textContent = "Sign in with the Android app or the local development app.";
      });
    }
    if (claudeAuth) {
      void claudeAuth.restore().then(async () => {
        claudeAuthReady = true;
        renderAuth();
        await resumeRecoveredReply();
      }).catch(() => {
        claudeStatus.textContent = "Sign in with the updated Android app or the local development app.";
      });
    }
  } catch (cause) {
    status.textContent = "Could not open your conversation";
    showError(cause);
  }
}
void start();
