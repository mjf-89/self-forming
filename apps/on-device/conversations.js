// Conversation tree. Plain DOM, no framework.

const BACK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const FORK_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 8"/></svg>';
const ARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/></svg>';
const UNARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M12 17v-6m-3 3 3-3 3 3"/></svg>';
const TREE_ICON = '<svg viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M4 7h18M4 13h14M4 19h12"/></svg>';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((child) => child !== undefined && child !== null));
  return node;
}

function initConversations({ getSession, showError: reportError }) {
  // Errors appear in the open screen (the chat's own error area is hidden while these screens show).
  const errorLines = [];
  const showError = (cause) => {
    const text = cause instanceof Error ? cause.message : String(cause);
    if (mode === "closed") return reportError(cause);
    for (const line of errorLines) { line.textContent = text; line.hidden = false; clearTimeout(line.timer); line.timer = setTimeout(() => { line.hidden = true; }, 6000); }
  };
  const $ = (id) => document.getElementById(id);
  const chatScreen = $("chat-screen");
  const footer = $("app-footer");

  // Conversations button, at the left of the header (a familiar drawer menu).
  const treeButton = el("button", { id: "chat-tree", class: "chat-icon-button", type: "button", "aria-label": "Conversations", title: "Conversations", html: TREE_ICON });
  const header = chatScreen.querySelector(".topbar");
  header.insertBefore(treeButton, header.firstChild);

  // Tree screen.
  const newButton = el("button", { id: "tree-new", class: "app-icon-button", type: "button", "aria-label": "New conversation", title: "New conversation", html: PLUS });
  const backButton = el("button", { id: "tree-back", class: "app-icon-button", type: "button", "aria-label": "Back to conversation", title: "Back to conversation", html: BACK });
  const treeList = el("div", { id: "tree-list", class: "conv-list", role: "tree", "aria-label": "Conversations" });
  const scrim = el("div", { id: "tree-scrim", hidden: true, "aria-hidden": "true" });
  const treeScreen = el("aside", { id: "tree-screen", "aria-label": "Conversations", hidden: true },
    el("header", { class: "conv-header" }, backButton, el("h2", {}, "Conversations"), newButton),
    el("p", { class: "conv-error", role: "alert", hidden: true }),
    el("div", { class: "conv-scroll" }, treeList));

  errorLines.push(treeScreen.querySelector(".conv-error"));
  document.body.append(scrim, treeScreen);
  scrim.addEventListener("click", () => closeAll());

  let mode = "closed"; // closed | tree
  let timer;
  let loading = false;

  // The chat stays visible behind a dimmed scrim; the drawer slides in from the left.
  function setChrome() {
    const open = mode !== "closed";
    treeScreen.hidden = !open;
    scrim.hidden = !open;
    document.body.classList.toggle("conv-active", open);
    setBackHandler(open);
  }
  // Android back (button or edge swipe) closes the drawer instead of leaving the app.
  let backEnabled = false;
  function setBackHandler(enabled) {
    if (enabled === backEnabled) return;
    backEnabled = enabled;
    const bridge = globalThis.__piBridge;
    if (bridge && globalThis.__piHostInfo?.capabilities?.backHandler) void bridge.call("host.back", { enabled }).catch(() => {});
  }
  let backSubscribed = false;
  function subscribeBack() {
    const bridge = globalThis.__piBridge;
    if (backSubscribed || !bridge) return;
    backSubscribed = true;
    bridge.subscribe((event) => {
      if (event.event === "env.output" && event.id === "host-back" && mode !== "closed") closeAll();
    });
  }

  function ready() {
    const session = getSession();
    if (!session) throw new Error("Still opening the conversation, try again in a moment.");
    return session;
  }

  async function refresh() {
    if (loading || mode !== "tree" || !getSession()) return;
    loading = true;
    try {
      const nodes = await getSession()?.tree();
      if (!nodes) return;
      if (mode === "tree" && !editing) renderTree(nodes);
    } catch (cause) { showError(cause); }
    finally { loading = false; }
  }

  function depthOf(node, byId) {
    let depth = 0, current = node;
    const seen = new Set();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
      depth++;
    }
    return depth;
  }

  const store = {
    get: (key) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } },
    set: (key, value) => { try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ } },
  };
  const FINISHED_KEY = "conv.showFinished", ARCHIVED_KEY = "conv.showArchived";
  let showFinished = store.get(FINISHED_KEY);
  let showArchived = store.get(ARCHIVED_KEY);
  let lastNodes = [];
  let editing = false;

  // Long press on a chat row: rename it in place (Enter or leaving the field saves, Escape cancels).
  function startRename(node, row, label) {
    if (editing) return;
    editing = true;
    const input = el("input", { class: "conv-rename", type: "text", value: node.title || "", maxlength: "80", "aria-label": "Chat name", enterkeyhint: "done" });
    const main = label.parentElement;
    main.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      try {
        if (save && name && name !== node.title) await ready().renameConversation(node.id, name);
      } catch (cause) { showError(cause); }
      editing = false;
      if (mode === "tree") await refresh(); else input.replaceWith(main);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void finish(false); }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  function onLongPress(target, callback) {
    let timer, startX = 0, startY = 0, fired = false;
    const cancel = () => clearTimeout(timer);
    target.addEventListener("pointerdown", (event) => {
      fired = false;
      startX = event.clientX; startY = event.clientY;
      cancel();
      timer = setTimeout(() => { fired = true; callback(); }, 550);
    });
    target.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) target.addEventListener(type, cancel);
    target.addEventListener("contextmenu", (event) => event.preventDefault());
    // Swallow the click that follows a long press so the chat is not opened.
    target.addEventListener("click", (event) => { if (fired) { fired = false; event.stopImmediatePropagation(); event.preventDefault(); } }, true);
  }

  async function archiveToggle(node) {
    try {
      if (node.archived) await ready().unarchiveConversation(node.id);
      else await ready().archiveConversation(node.id);
      await refresh();
    } catch (cause) { showError(cause); }
  }

  function renderTree(allNodes) {
    lastNodes = allNodes;
    const byAll = new Map(allNodes.map((node) => [node.id, node]));
    const finishedCount = allNodes.filter((node) => node.finished).length;
    const archivedCount = allNodes.filter((node) => node.archived).length;
    // Hide archived chats with their subtrees, and finished tasks.
    const hidden = (node) => {
      const seen = new Set();
      for (let current = node; current && !seen.has(current.id); current = byAll.get(current.parentId)) {
        seen.add(current.id);
        if (current.archived && !showArchived) return true;
        if (current.finished && !showFinished) return true;
      }
      return false;
    };
    const nodes = allNodes.filter((node) => !hidden(node));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const currentId = getSession()?.snapshot?.conversation?.id;
    const rows = nodes.map((node) => {
      const isCurrent = node.selected || (!nodes.some((n) => n.selected) && node.id === currentId);
      // Minimal row: the title (bold when viewed) and a dot only while something runs.
      const label = el("span", { class: "conv-title" }, node.title || "Untitled");
      const meta = node.busy ? [el("span", { class: "conv-dot busy", title: "Working", "aria-label": "working" })] : [];
      const depth = depthOf(node, byId);
      const open = el("button", { class: "conv-main", type: "button", role: "treeitem", "aria-level": String(depth + 1), "aria-current": isCurrent ? "true" : undefined }, label, ...meta);
      const row = el("div", { class: "conv-row", style: `padding-left:${depth * 16}px` }, open);
      open.addEventListener("click", () => void switchTo(node.id));
      if (!["task", "subagent"].includes(node.kind)) onLongPress(open, () => startRename(node, row, label));
      if (!node.archived && ["main", "thread", "fork"].includes(node.kind)) {
        const fork = el("button", { class: "conv-icon-action", type: "button", "aria-label": `Fork “${node.title || "Untitled"}”`, title: "Fork", html: FORK_ICON });
        fork.addEventListener("click", () => void forkFrom(node, isCurrent));
        row.append(fork);
      }
      if (!node.parentId && node.kind !== "main" && node.kind !== "task" && node.kind !== "subagent") {
        const action = el("button", { class: "conv-icon-action", type: "button", "aria-label": `${node.archived ? "Unarchive" : "Archive"} “${node.title || "Untitled"}”`, title: node.archived ? "Unarchive" : "Archive", html: node.archived ? UNARCHIVE_ICON : ARCHIVE_ICON });
        action.addEventListener("click", () => void archiveToggle(node));
        row.append(action);
      }
      return row;
    });
    if (!rows.length) rows.push(el("p", { class: "conv-empty" }, "No conversations yet."));
    const toggles = [];
    const toggle = (text, on, key, set) => {
      const button = el("button", { class: "conv-text conv-toggle", type: "button", "aria-pressed": String(on) }, text);
      button.addEventListener("click", () => { set(!on); store.set(key, !on); renderTree(lastNodes); });
      toggles.push(button);
    };
    if (finishedCount > 0) toggle(`${showFinished ? "Hide finished" : "Finished"} (${finishedCount})`, showFinished, FINISHED_KEY, (v) => { showFinished = v; });
    if (archivedCount > 0) toggle(`${showArchived ? "Hide archived" : "Archived"} (${archivedCount})`, showArchived, ARCHIVED_KEY, (v) => { showArchived = v; });
    if (toggles.length) rows.push(el("div", { class: "conv-toggles" }, ...toggles));
    treeList.replaceChildren(...rows);
  }

  async function forkFrom(node, isCurrent) {
    try {
      const s = ready();
      if (!isCurrent && s.snapshot?.conversation?.id !== node.id) await s.switchConversation(node.id);
      await s.forkThread();
      closeAll();
    } catch (cause) { showError(cause); }
  }

  async function switchTo(id) {
    try {
      await ready().switchConversation(id);
      closeAll();
    } catch (cause) { showError(cause); }
  }

  function openTree() {
    subscribeBack();
    mode = "tree";
    setChrome();
    clearInterval(timer);
    timer = setInterval(() => void refresh(), 2000);
    void refresh();
  }

  function closeAll() {
    clearInterval(timer);
    mode = "closed";
    setChrome();
    treeButton.focus({ preventScroll: true });
  }

  treeButton.addEventListener("click", openTree);
  backButton.addEventListener("click", closeAll);
  newButton.addEventListener("click", async () => {
    try { await ready().newThread(); closeAll(); } catch (cause) { showError(cause); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (mode === "tree") closeAll();
  });

  return { open: openTree, close: closeAll };
}

export { initConversations };
