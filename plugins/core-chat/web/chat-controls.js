// plugins/core-chat/web/chat-controls.js (was apps/common/chat-controls.js)
// Built-in modes keep their own label logic; any other mode (a contributed provider, or one
// whose plugin is missing) is named by modelLabel(mode, modelId) from provider-settings.js.
const BUILTIN_MODES = new Set(["offline", "chatgpt", "claude", "openai"]);
function initChatControls({ getSnapshot, modelLabel = () => void 0 }) {
  const $ = (id) => document.getElementById(id);
  const prompt = $("prompt"), scroll = $("main-scroll");
  const menus = [
    { button: $("composer-shortcuts"), panel: $("composer-shortcuts-menu") }
  ];
  function closeMenus(restoreFocus = false) {
    for (const { button, panel } of menus) {
      const wasOpen = !panel.hidden;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus && wasOpen) button.focus({ preventScroll: true });
    }
  }
  for (const { button, panel } of menus) {
    button.addEventListener("click", () => {
      const open = panel.hidden;
      closeMenus();
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) panel.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    });
    panel.addEventListener("click", (event) => {
      if (event.target.closest("button")) closeMenus();
    });
  }
  document.addEventListener("click", (event) => {
    if (!menus.some(({ button, panel }) => button.contains(event.target) || panel.contains(event.target))) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menus.some(({ panel }) => !panel.hidden)) {
      event.preventDefault();
      event.stopPropagation();
      closeMenus(true);
    }
  }, true);
  for (const [shortcut, target] of [
    ["composer-model", "chat-settings"]
  ]) {
    const button = $(shortcut), original = $(target);
    const sync = () => {
      button.disabled = original.disabled;
    };
    sync();
    new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ["disabled"] });
    button.addEventListener("click", () => {
      closeMenus();
      original.click();
      if (shortcut === "composer-model") {
        const mode = $("mode").value;
        const control = mode === "chatgpt" ? $("chatgpt-model") : mode === "claude" ? $("claude-model") : mode === "openai" ? $("model") : $("provider-panel")?.hidden === false && $("provider-model") ? $("provider-model") : $("mode");
        if (!control.disabled) control.focus({ preventScroll: true });
      }
    });
  }
  function resizePrompt() {
    if ($("chat-screen").hidden) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const cssMaximum = parseFloat(getComputedStyle(prompt).maxHeight);
    const maximum = Math.max(44, Math.min(144, viewportHeight * 0.24, Number.isFinite(cssMaximum) ? cssMaximum : 144));
    prompt.style.height = "44px";
    const contentHeight = prompt.scrollHeight;
    prompt.style.height = `${Math.min(maximum, Math.max(44, contentHeight))}px`;
    prompt.style.overflowY = contentHeight > maximum ? "auto" : "hidden";
  }
  prompt.addEventListener("input", resizePrompt);
  window.addEventListener("resize", resizePrompt);
  window.visualViewport?.addEventListener("resize", resizePrompt);
  new MutationObserver(() => {
    if (!$("chat-screen").hidden) requestAnimationFrame(resizePrompt);
    else closeMenus();
  }).observe($("chat-screen"), { attributes: true, attributeFilter: ["hidden"] });
  function updateJump() {
    $("jump-latest").hidden = !$("messages").children.length || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
  }
  scroll.addEventListener("scroll", updateJump, { passive: true });
  new ResizeObserver(updateJump).observe(scroll);
  new MutationObserver(() => requestAnimationFrame(updateJump)).observe($("messages"), { childList: true, subtree: true, characterData: true });
  $("jump-latest").addEventListener("click", () => {
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
    updateJump();
  });
  function update(snapshot = getSnapshot()) {
    const mode = snapshot?.busy ? snapshot.mode : $("mode").value;
    const label = mode && !BUILTIN_MODES.has(mode) ? modelLabel(mode, snapshot?.busy ? snapshot.modelId : void 0) || (snapshot?.busy && snapshot.modelId) || mode
      : mode === "offline" ? "Offline demo" : snapshot?.busy ? snapshot.modelId : mode === "chatgpt" ? $("chatgpt-model").selectedOptions[0]?.textContent || "ChatGPT" : mode === "claude" ? $("claude-model").selectedOptions[0]?.textContent || "Claude Code" : $("model").value.trim() || "OpenAI";
    $("composer-model-label").textContent = label;
    $("composer-model").title = `Model: ${label}. Open settings`;
    $("composer-model").setAttribute("aria-label", `Model: ${label}. Open settings`);
    resizePrompt();
    updateJump();
  }
  for (const id of ["mode", "model", "chatgpt-model", "claude-model"]) $(id).addEventListener("change", () => update());
  return { update, resizePrompt };
}
export {
  initChatControls
};
