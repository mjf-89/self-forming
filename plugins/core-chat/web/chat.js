// plugins/core-chat/web/chat.js
// The chat (step C7, docs/plugins-providers-agent-core.md §B2): moved from app.js. It runs on
// agent.sessions@1 (sessions: current(), onSession, subscribe, foreground; every session call
// goes through sessions.current()) and owns the chat screen (render, composer listeners,
// drafts, attachments, stop/resume) and the model part of Settings (#mode, the built-in
// provider panels' sign-in wiring, the contributed providers through provider-settings.js and
// sessions.providers(), thinking). page is the page's chat host (apps/common/chat-host.js):
// credential controllers, reloading state, app-revision hooks.
// Mounted once per page: by core-chat's setup, or by app.js with the bundled copy when
// composition fails or core-chat did not mount (page.claim). DOM IDs, storage, drafts and
// labels are those app.js used. session.js is imported lazily (no library at evaluation).
import { createChatRenderer } from "./chat-renderer.js";
import { initChatControls } from "./chat-controls.js";
import { initAttachmentComposer } from "./attachment-composer.js";
import { initProviderSettings } from "./provider-settings.js";

/**
 * Mounts the chat on sessions (agent.sessions@1) with the page host; by: "core-chat" or
 * "bundled". Resolves true once wired, false when another copy already mounted.
 */
export async function mountChat({ sessions, page, by = "bundled" } = {}) {
  if (!sessions || typeof sessions.current !== "function" || typeof sessions.onSession !== "function" || typeof sessions.subscribe !== "function") throw new TypeError("mountChat needs the agent.sessions@1 facade");
  if (typeof page?.claim !== "function") throw new TypeError("mountChat needs the page chat host (chat-host.js)");
  if (!page.claim(by)) return false;
  let engine;
  try {
    engine = await import("../../../session.js");
  } catch (cause) {
    page.release(by);
    throw cause;
  }
  wireChat({ sessions, page, engine });
  return true;
}

function wireChat({ sessions, page, engine }) {
  const { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, getThinkingEfforts } = engine;
  function element(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing interface element: ${id}`);
    return found;
  }
  var messages = element("messages");
  var mainScroll = element("main-scroll");
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
  // The page's credential controllers (created in app.js start(), before any mount).
  var auth = page.auth();
  var claudeAuth = page.claudeAuth();
  var claudeAuthReady = false;
  var claudeLoginOperation = false;
  var claudeLoginCancelled = false;
  var claudeLoginWindow = null;
  var authReady = false;
  var loginWindow = null;
  var loginOperation = false;
  var modelLoad = 0;
  var modelsLoading = false;
  var operation = false;
  var appReloading = () => page.reloading();
  var chatRenderer = createChatRenderer({ messages, scroll: mainScroll });
  var chatControls = initChatControls({ getSnapshot: () => sessions.current()?.snapshot, modelLabel: (value, modelId) => providerSettings?.modelLabel(value, modelId) });
  // Contributed model providers (P4): #mode options and the generic #provider-panel.
  var providerSettings = initProviderSettings({
    getSession: () => sessions.current(),
    onChange() {
      saveModelSettings();
      chatControls.update();
    },
    onUpdate() {
      renderAuth();
      chatControls.update();
    },
    onConnected: () => void resumeRecoveredReply()
  });
  var attachmentPickerConversationId;
  var pendingAttachmentSelection;
  var attachmentImport = false;
  var attachmentComposer = initAttachmentComposer({
    onPick() {
      if (!sessions.foreground || !sessions.current() || operation || appReloading() || sessions.current().snapshot.owned) return false;
      attachmentPickerConversationId = sessions.current().snapshot.conversation.id;
      return true;
    },
    onFiles(files) {
      if (!files.length) return;
      pendingAttachmentSelection = {
        files,
        conversationId: attachmentPickerConversationId ?? sessions.current()?.snapshot.conversation.id ?? renderedConversationId
      };
      attachmentPickerConversationId = void 0;
      void importSelectedAttachments();
    },
    onRemove: (id) => removeDraftAttachment(id),
    onError: showError
  });
  var renderedConversationId;
  var draftTimer;
  var renderedModelSettings;
  function selectModelOption(control, id, defaultLabel) {
    if (![...control.options].some((option) => option.value === id)) control.add(new Option(id || defaultLabel, id));
    control.value = id;
  }
  // The names the open session knows for a mode or "provider:<id>" (agent.sessions@1
  // providerLabel, C7): its current rows, else rows seen earlier on this page.
  function providerLabel(key) {
    try {
      return sessions.current()?.providerLabel?.(key);
    } catch {
      return void 0;
    }
  }
  // A stored mode without a #mode option (P3: its provider plugin is missing) keeps its
  // own option, "<label or raw id> (not available)", instead of silently showing another.
  function modeOption(choice) {
    for (const option of [...mode.options]) if (option.dataset.provider && option.value !== choice.mode) option.remove();
    if ([...mode.options].some((option) => option.value === choice.mode)) return;
    const raw = choice.mode.startsWith("provider:") ? choice.mode.slice("provider:".length) : choice.mode;
    const label = choice.label ?? providerLabel(choice.mode)?.label ?? raw;
    const option = new Option(choice.available === false ? `${label} (not available)` : label, choice.mode);
    option.dataset.provider = choice.available === false ? "unavailable" : "contributed";
    option.disabled = choice.available === false;
    mode.add(option);
  }
  // Recovery text: a provider's waitingLabel, else the raw mode or provider id.
  function waitingName(key) {
    const names = providerLabel(key);
    if (names) return names.waitingLabel ?? names.label;
    return ({ openai: "OpenAI API key", chatgpt: "ChatGPT", claude: "Claude Code" })[key] ?? (key.startsWith("provider:") ? key.slice("provider:".length) : key);
  }
  function restoreModelSettings(snapshot = sessions.current()?.snapshot, force = false) {
    const choice = snapshot?.modelSettings;
    if (!choice) return;
    providerSettings.sync();
    const signature = JSON.stringify([snapshot.conversation.id, choice]);
    if (!force && signature === renderedModelSettings) return;
    renderedModelSettings = signature;
    modeOption(choice);
    mode.value = choice.mode;
    model.value = choice.mode === "openai" ? choice.modelId : DEFAULT_OPENAI_MODEL;
    selectModelOption(chatGPTModel, choice.mode === "chatgpt" ? choice.modelId : "", "Account default");
    selectModelOption(claudeModel, choice.mode === "claude" ? choice.modelId : DEFAULT_CLAUDE_MODEL, "Default");
    providerSettings.restore(choice);
  }
  function saveModelSettings() {
    const current = sessions.current();
    if (!current || current.snapshot.owned) return;
    const id = current.snapshot.conversation.id;
    const choice = { mode: mode.value, modelId: selectedModel(), thinkingEffort: thinkingEffort.value };
    void current.setModelSettings(choice, id).catch((cause) => {
      if (sessions.current() === current && current.snapshot.conversation.id === id) {
        restoreModelSettings(current.snapshot, true);
        updateMode();
        showError(cause);
      }
    });
  }
  function selectedModel() {
    return mode.value === "chatgpt" ? chatGPTModel.value : mode.value === "claude" ? claudeModel.value : mode.value === "openai" ? model.value.trim() : providerSettings.selectedModel(mode.value);
  }
  function updateThinking() {
    const needsSignIn = mode.value === "chatgpt" ? !auth?.snapshot.signedIn : mode.value === "claude" ? !claudeAuth?.snapshot.signedIn : false;
    // Contributed modes: the row's efforts (P4); built-in and missing modes: the static table.
    const efforts = needsSignIn ? [] : providerSettings.thinkingEfforts(mode.value, selectedModel()) ?? getThinkingEfforts({ mode: mode.value, modelId: selectedModel() });
    const signature = JSON.stringify(efforts);
    if (thinkingEffort.dataset.options !== signature) {
      const names = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
      const defaultEffort = efforts.includes("off") ? "off" : efforts[0];
      const defaultLabel = defaultEffort ? `Default (${names[defaultEffort] ?? defaultEffort})` : "Default";
      thinkingEffort.replaceChildren(new Option(defaultLabel, ""), ...efforts.map((value) => new Option(names[value] ?? value, value)));
      thinkingEffort.dataset.options = signature;
    }
    const snapshot = sessions.current()?.snapshot;
    const saved = snapshot?.modelSettings?.thinkingEffort;
    thinkingEffort.value = efforts.includes(saved) ? saved : "";
    element("thinking-settings").hidden = !efforts.length || Boolean(snapshot?.owned);
    thinkingEffort.disabled = !sessions.current() || !sessions.foreground || Boolean(snapshot?.busy) || operation || appReloading();
    element("thinking-note").textContent = snapshot?.paused ? "Resuming keeps the thinking setting saved with that reply." : "";
  }
  async function importSelectedAttachments() {
    if (!pendingAttachmentSelection || !sessions.foreground || !sessions.current() || operation || appReloading() || sessions.current().snapshot.owned) return;
    const selected = pendingAttachmentSelection;
    pendingAttachmentSelection = void 0;
    const current = sessions.current();
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
      if (sessions.current() === current) {
        operation = false;
        render(current.snapshot);
      }
    }
  }
  async function removeDraftAttachment(id) {
    if (!sessions.foreground || !sessions.current() || operation || appReloading() || sessions.current().snapshot.busy) return;
    const current = sessions.current();
    operation = true;
    render(current.snapshot);
    try {
      await current.removeAttachment(id);
    } catch (cause) {
      showError(cause);
    } finally {
      if (sessions.current() === current) {
        operation = false;
        render(current.snapshot);
      }
    }
  }
  function saveDraft(current = sessions.current()) {
    clearTimeout(draftTimer);
    return current ? current.setDraft(prompt.value) : Promise.resolve();
  }
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    const current = sessions.current();
    draftTimer = setTimeout(() => {
      if (sessions.current() === current) void saveDraft(current).catch(showError);
    }, 250);
  }
  function showError(cause) {
    error.textContent = cause instanceof Error ? cause.message : String(cause);
    error.hidden = false;
  }
  function settings() {
    return { ...sessions.current()?.snapshot.modelSettings ?? { mode: "offline" }, apiKey: key.value };
  }
  function updateMode() {
    const online = mode.value === "openai";
    const chatgpt = mode.value === "chatgpt";
    const claude = mode.value === "claude";
    element("chatgpt-account").hidden = !chatgpt;
    element("claude-account").hidden = !claude;
    element("openai-settings").hidden = !online;
    element("mode-description").textContent = "";
    // #provider-panel (contributed modes) follows in renderAuth, with the model lock.
    renderAuth();
    chatControls.update();
  }
  function renderAuth() {
    const signedIn = auth?.snapshot.signedIn ?? false;
    element("chatgpt-settings").hidden = mode.value !== "chatgpt" || !signedIn;
    const busy = loginOperation || claudeLoginOperation || (auth?.snapshot.busy ?? false);
    const running = Boolean(sessions.current()?.snapshot.busy && !sessions.current().snapshot.paused) || operation || appReloading();
    const modelLocked = !sessions.current() || !sessions.foreground || Boolean(sessions.current().snapshot.owned) || running;
    mode.disabled = modelLocked;
    model.disabled = modelLocked;
    providerSettings.update({ mode: mode.value, locked: modelLocked });
    page.revisionControls();
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
    chatGPTModel.disabled = modelLocked || modelsLoading || !signedIn || !chatGPTModel.options.length;
    const recovery = element("resume-panel").querySelector("p");
    const current = sessions.current();
    if (recovery && current?.snapshot.paused) {
      const providers = current.snapshot.recoveryProviders ?? [current.snapshot.mode];
      const names = providers.map(waitingName).filter(Boolean);
      // "provider:<id>": saved work of a provider no plugin offers now (held by mode otherwise).
      const missing = providers.length > 0 && providers.every((provider) => provider.startsWith("provider:"));
      recovery.textContent = missing
        ? `Saved work is waiting for ${names.join(" and ")}, which is not available. Enable its plugin to continue. Work continues with its saved model.`
        : `Saved work is waiting for ${names.join(" and ") || "model credentials"}. Open Settings to connect the account, or enter the API key and choose Resume. Work continues with its saved model.`;
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
    claudeModel.disabled = !claudeSignedIn || modelLocked || !claudeModel.options.length;
    updateThinking();
  }
  async function loadModels() {
    if (!auth?.snapshot.signedIn) return;
    const current = ++modelLoad;
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
      chatGPTModel.replaceChildren(new Option("Account default", ""), ...models.map((item) => new Option(item.name, item.id)));
      // The selected chat may have changed while the account request was in flight.
      // Keep a saved unavailable ID visible; never silently choose another model.
      restoreModelSettings(sessions.current()?.snapshot, true);
      note.textContent = models.length ? "" : "No models were returned for this account. Check access in ChatGPT, then refresh.";
    } catch (cause) {
      if (current === modelLoad && auth.snapshot.signedIn) {
        restoreModelSettings(sessions.current()?.snapshot, true);
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
    if (!auth || loginOperation || claudeLoginOperation || operation || sessions.current()?.snapshot.busy && !sessions.current().snapshot.paused) return;
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
    if (!claudeAuth || claudeLoginOperation || loginOperation || operation || sessions.current()?.snapshot.busy && !sessions.current().snapshot.paused) return;
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
  // Sign-in pages in the browser edition (auth onOpenUrl, created by app.js, lands here).
  function openUrl(kind, url) {
    if (kind === "chatgpt") {
      openLogin.href = url;
      openLogin.hidden = false;
      if (loginWindow) loginWindow.location.replace(url);
    } else if (kind === "claude") {
      claudeOpen.href = url;
      claudeOpen.hidden = false;
      if (claudeLoginWindow) claudeLoginWindow.location.replace(url);
    }
  }
  // One status line while a reply waits to retry (pi.live.generation.retry, as the session snapshot's
  // retry): upstream's reference UI (coding-agent RetryStatusIndicator: "Retrying (n/max) in Ns…"),
  // with the Stop button next to it; the countdown ticks without a new snapshot.
  function retryText(retry) {
    const seconds = Math.max(0, Math.ceil((retry.at - Date.now()) / 1e3));
    return seconds > 0 ? `Retrying (${retry.attempt}) in ${seconds}s\u2026` : `Retrying (${retry.attempt})\u2026`;
  }
  let retryTimer;
  function followRetry(snapshot) {
    const waiting = Boolean(sessions.foreground && snapshot.busy && snapshot.retry);
    if (!waiting) {
      clearInterval(retryTimer);
      retryTimer = void 0;
      return;
    }
    if (retryTimer) return;
    retryTimer = setInterval(() => {
      const latest = sessions.current()?.snapshot;
      if (!latest?.busy || !latest.retry || !sessions.foreground) {
        clearInterval(retryTimer);
        retryTimer = void 0;
        return;
      }
      status.textContent = retryText(latest.retry);
    }, 1e3);
  }
  function render(snapshot) {
    const conversationChanged = snapshot.conversation && snapshot.conversation.id !== renderedConversationId;
    if (conversationChanged) {
      renderedConversationId = snapshot.conversation.id;
      key.value = "";
      prompt.value = snapshot.conversation.draft ?? "";
      error.hidden = true;
      chatRenderer.render([]);
    }
    restoreModelSettings(snapshot);
    element("chatgpt-account").hidden = mode.value !== "chatgpt";
    element("claude-account").hidden = mode.value !== "claude";
    element("openai-settings").hidden = mode.value !== "openai";
    const locked = !sessions.current() || !sessions.foreground || operation || appReloading();
    const steering = Boolean(sessions.current()) && snapshot.busy;
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
      suffix.textContent = ` \xB7 ${snapshot.kind === "task" ? "task" : "subagent"}`;
      titleEl.append(suffix);
    }
    mode.disabled = !sessions.current() || !sessions.foreground || snapshot.busy && !snapshot.paused || operation || appReloading();
    stop.hidden = !snapshot.busy;
    stop.disabled = !sessions.current() || !sessions.foreground;
    resume.disabled = !sessions.current() || !sessions.foreground || operation;
    element("resume-panel").hidden = !snapshot.paused;
    element("status-dot").classList.toggle("working", snapshot.busy && !snapshot.paused);
    const failed = snapshot.messages.at(-1)?.role === "assistant" && snapshot.messages.at(-1)?.error;
    status.textContent = !sessions.foreground ? "Paused in background" : attachmentImport ? "Adding files\u2026" : snapshot.paused ? "Waiting for credentials" : snapshot.busy && snapshot.retry ? retryText(snapshot.retry) : snapshot.busy ? "Working\u2026" : snapshot.anyBusy ? "Ready \xB7 other conversations working" : failed ? "Reply failed" : "Ready";
    status.title = snapshot.busy && snapshot.retry?.error ? snapshot.retry.error : "";
    followRetry(snapshot);
    welcome.hidden = snapshot.messages.length > 0;
    if (snapshot.error) showError(snapshot.error);
    renderAuth();
    chatRenderer.render(snapshot.messages);
    let truncatedNote = document.getElementById("messages-truncated");
    const noteText = snapshot.loadingHistory ? "Loading earlier messages\u2026" : "Showing the latest messages";
    const showNote = Boolean((snapshot.loadingHistory || snapshot.truncated) && snapshot.messages.length);
    if (showNote || truncatedNote && !truncatedNote.hidden) {
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
    // The page's part (app.js): Settings → Plugins and queued app revisions (activation chain).
    page.afterRender(snapshot);
    if (conversationChanged) requestAnimationFrame(() => mainScroll.scrollTo({ top: mainScroll.scrollHeight, behavior: "instant" }));
  }
  async function sendMessage(text) {
    if (!sessions.foreground || !sessions.current() || operation || appReloading() || !text.trim() && !sessions.current().snapshot.conversation.attachments?.length) return;
    const current = sessions.current();
    error.hidden = true;
    operation = true;
    render(sessions.current().snapshot);
    const config = settings();
    const conversationId = current.snapshot.conversation.id;
    key.value = "";
    const before = new Set(current.snapshot.messages.map((message) => message.id));
    const unsubscribe = current.subscribe((snapshot) => {
      if (sessions.current() === current && snapshot.conversation.id === conversationId && prompt.value === text && snapshot.messages.some((message) => message.role === "user" && !before.has(message.id))) {
        prompt.value = "";
        chatControls.resizePrompt();
        void current.setDraft("").catch(showError);
      }
    });
    mainScroll.scrollTo({ top: mainScroll.scrollHeight, behavior: "instant" });
    try {
      await saveDraft(current);
      await current.send(text, config, conversationId);
      if (sessions.current() === current && current.snapshot.conversation.id === conversationId && prompt.value === text) {
        prompt.value = "";
        chatControls.resizePrompt();
        void current.setDraft("").catch(showError);
      }
    } catch (cause) {
      if (sessions.current() === current && current.snapshot.conversation.id === conversationId) {
        prompt.value = text;
        void saveDraft(current).catch(showError);
        showError(cause);
      }
    } finally {
      unsubscribe();
      config.apiKey = void 0;
      if (sessions.current() === current) {
        operation = false;
        render(current.snapshot);
      }
    }
  }
  async function resumeReply(config = settings()) {
    if (!sessions.foreground || !sessions.current() || operation || appReloading() || !sessions.current().snapshot.paused) return;
    const current = sessions.current();
    error.hidden = true;
    key.value = "";
    operation = true;
    render(sessions.current().snapshot);
    try {
      await current.resume(config);
    } catch (cause) {
      if (sessions.current() === current) showError(cause);
    } finally {
      config.apiKey = void 0;
      if (sessions.current() === current) {
        operation = false;
        render(current.snapshot);
      }
    }
    await page.applyQueued(current);
  }
  async function resumeRecoveredReply() {
    if (!native || !sessions.foreground || !sessions.current()?.snapshot.paused || operation || loginOperation || claudeLoginOperation) return;
    if (sessions.current().snapshot.mode === "offline") await resumeReply({ mode: "offline" });
    else if (sessions.current().snapshot.mode === "chatgpt" && authReady && auth?.snapshot.signedIn)
      await resumeReply({ mode: "chatgpt" });
    else if (sessions.current().snapshot.mode === "claude" && claudeAuthReady && claudeAuth?.snapshot.signedIn)
      await resumeReply({ mode: "claude" });
    else if (providerSettings.ready(sessions.current().snapshot.mode))
      await resumeReply({ mode: sessions.current().snapshot.mode });
  }
  element("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(prompt.value);
  });
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void sendMessage(prompt.value);
    }
  });
  mode.addEventListener("change", () => {
    saveModelSettings();
    updateMode();
  });
  for (const control of [model, chatGPTModel, claudeModel]) control.addEventListener("change", saveModelSettings);
  model.addEventListener("input", saveModelSettings);
  thinkingEffort.addEventListener("change", saveModelSettings);
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
      chatGPTModel.replaceChildren(new Option("Account default", ""));
      restoreModelSettings(sessions.current()?.snapshot, true);
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
    if (!sessions.foreground || !sessions.current()) return;
    const current = sessions.current();
    stop.disabled = true;
    void current.stop().catch((cause) => {
      if (sessions.current() === current) showError(cause);
    }).finally(() => {
      if (sessions.current() === current) stop.disabled = false;
    });
  });
  resume.addEventListener("click", () => {
    void resumeReply();
  });
  auth?.subscribe(renderAuth);
  claudeAuth?.subscribe(renderAuth);

  // agent.sessions@1: a session opened (or reopened after background or an app revision).
  function sessionOpened(opened) {
    renderedConversationId = void 0;
    restoreModelSettings(opened.snapshot, true);
    updateMode();
    void resumeRecoveredReply();
  }
  sessions.onSession((opened, details) => {
    if (opened) {
      sessionOpened(opened);
      return;
    }
    if (details?.reason !== "background") return;
    operation = false;
    const closed = details.previous.snapshot;
    render({ ...closed, paused: closed.busy });
  });
  // The page's view of the chat (app.js: reload refusal, app revisions, closing drafts).
  page.attach(Object.freeze({
    render,
    busy: () => operation,
    signingIn: () => loginOperation || claudeLoginOperation,
    saveDraft,
    openUrl
  }));
  // Mounted after the session opened (the bundled copy after the deadline): catch up.
  if (sessions.current()) sessionOpened(sessions.current());
  // Follows the current session across reopen (called at once while one is open).
  sessions.subscribe((snapshot) => render(snapshot));
  // Sign-ins are restored once the page's sessions began (was app.js start()).
  void Promise.resolve(page.begun).then(() => {
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
  });
}
