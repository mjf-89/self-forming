// plugins/core-conversations/web/conversations.js (was apps/common/conversations.js)
var BACK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
var PLUS = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
var FORK_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 8"/></svg>';
var ARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/></svg>';
var UNARCHIVE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M12 17v-6m-3 3 3-3 3 3"/></svg>';
var TREE_ICON = '<svg viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M4 7h18M4 13h14M4 19h12"/></svg>';
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === void 0 || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((child) => child !== void 0 && child !== null));
  return node;
}
// The drawer's nodes (the header button, the scrim and the aside), built once per document and
// put in place: app.js does it at load (mountBundled), so the header looks the same before the
// drawer is wired; initConversations reuses them.
const built = new WeakMap();
const wired = new WeakMap();
function drawerNodes(document) {
  let nodes = built.get(document);
  if (nodes) return nodes;
  const $ = (id) => document.getElementById(id);
  const chatScreen = $("chat-screen");
  const treeButton = el("button", { id: "chat-tree", class: "chat-icon-button", type: "button", "aria-label": "Conversations", title: "Conversations", html: TREE_ICON });
  const header = chatScreen.querySelector(".topbar");
  header.insertBefore(treeButton, header.firstChild);
  const newButton = el("button", { id: "tree-new", class: "app-icon-button", type: "button", "aria-label": "New conversation", title: "New conversation", html: PLUS });
  const backButton = el("button", { id: "tree-back", class: "app-icon-button", type: "button", "aria-label": "Back to conversation", title: "Back to conversation", html: BACK });
  const treeList = el("div", { id: "tree-list", class: "conv-list", role: "tree", "aria-label": "Conversations" });
  const scrim = el("div", { id: "tree-scrim", hidden: true, "aria-hidden": "true" });
  const treeScreen = el(
    "aside",
    { id: "tree-screen", "aria-label": "Conversations", hidden: true },
    el("header", { class: "conv-header" }, backButton, el("h2", {}, "Conversations"), newButton),
    el("p", { class: "conv-error", role: "alert", hidden: true }),
    el("div", { class: "conv-scroll" }, treeList)
  );
  document.body.append(scrim, treeScreen);
  nodes = { treeButton, newButton, backButton, treeList, scrim, treeScreen };
  built.set(document, nodes);
  return nodes;
}
/** The drawer's nodes at load (bundled copy, no listeners yet); idempotent. */
function mountBundled(doc = document) {
  drawerNodes(doc);
}
/** Who wired the drawer on this document ("core-conversations", "bundled"), or undefined. */
function conversationsMountedBy(doc = document) {
  return wired.get(doc)?.by;
}
function initConversations({ getSession, onSession, showError: reportError = showPageError, by = "bundled" }) {
  // Wired once per page: core-conversations' setup or app.js's bundled copy, whichever comes first.
  if (wired.has(document)) return wired.get(document).api;
  const errorLines = [];
  const showError = (cause) => {
    const text = cause instanceof Error ? cause.message : String(cause);
    if (mode === "closed") return reportError(cause);
    for (const line of errorLines) {
      line.textContent = text;
      line.hidden = false;
      clearTimeout(line.timer);
      line.timer = setTimeout(() => {
        line.hidden = true;
      }, 6e3);
    }
  };
  const { treeButton, newButton, backButton, treeList, scrim, treeScreen } = drawerNodes(document);
  errorLines.push(treeScreen.querySelector(".conv-error"));
  scrim.addEventListener("click", () => closeAll());
  let mode = "closed";
  let timer;
  // Drawer index (docs/plugins-ui-editions.md): with a session that offers watchTree the list is pushed
  // by the session (no rescans); the 2 s timer then only checks which session is current (no storage).
  // Sessions without it keep the old tree() polling.
  let watched;
  let unwatch;
  let pendingNodes;
  function watch(session) {
    if (watched === session) return;
    unwatchTree();
    if (!session || typeof session.watchTree !== "function") return;
    watched = session;
    try {
      unwatch = session.watchTree((nodes, error) => {
        if (watched !== session || mode !== "tree") return;
        if (!nodes) {
          if (error) showError(error);
          return;
        }
        if (editing) pendingNodes = nodes;
        else renderTree(nodes);
      });
    } catch (cause) {
      watched = void 0;
      showError(cause);
    }
  }
  function unwatchTree() {
    const stop = unwatch;
    unwatch = void 0;
    watched = void 0;
    pendingNodes = void 0;
    try { stop?.(); } catch {}
  }
  function tick(force = false) {
    const session = getSession();
    if (mode !== "tree") return;
    if (session && typeof session.watchTree === "function") {
      if (watched !== session) watch(session);
      else if (force && !editing) {
        const nodes = pendingNodes ?? lastNodes;
        pendingNodes = void 0;
        renderTree(nodes);
      }
      return;
    }
    if (watched) unwatchTree();
    void refresh(force);
  }
  if (typeof onSession === "function") {
    try {
      onSession(() => {
        if (mode === "tree") tick();
      });
    } catch {
    }
  }
  // One refresh at a time per session. A call that never settles (e.g. caught while the session was
  // being closed for background/foreground) must not freeze the list: it is abandoned after a while
  // or when the session changes, and its late result is ignored.
  const REFRESH_STALE_MS = 15e3;
  let refreshing;
  let refreshSeq = 0;
  let renderedSeq = 0;
  function setChrome() {
    const open = mode !== "closed";
    treeScreen.hidden = !open;
    scrim.hidden = !open;
    document.body.classList.toggle("conv-active", open);
    setBackHandler(open);
  }
  let backEnabled = false;
  function setBackHandler(enabled) {
    if (enabled === backEnabled) return;
    backEnabled = enabled;
    const bridge = globalThis.__piBridge;
    if (bridge && globalThis.__piHostInfo?.capabilities?.backHandler) void bridge.call("host.back", { enabled }).catch(() => {
    });
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
  async function refresh(force = false) {
    const session = getSession();
    if (mode !== "tree" || !session) return;
    if (!force && refreshing && refreshing.session === session && Date.now() - refreshing.started < REFRESH_STALE_MS) return;
    const call = { id: ++refreshSeq, session, started: Date.now() };
    refreshing = call;
    // Render any finished result that is newer than what is on screen, even if a later refresh has
    // started meanwhile: a slow tree() must still update the list instead of being discarded.
    const usable = () => getSession() === session && call.id > renderedSeq;
    try {
      const nodes = await session.tree();
      if (!nodes || !usable()) return;
      if (mode === "tree" && !editing) {
        renderedSeq = call.id;
        renderTree(nodes);
      }
    } catch (cause) {
      if (usable()) showError(cause);
    } finally {
      if (refreshing === call) refreshing = void 0;
    }
  }
  function depthOf(node, byId) {
    let depth = 0, current = node;
    const seen = /* @__PURE__ */ new Set();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
      depth++;
    }
    return depth;
  }
  const store = {
    get: (key) => {
      try {
        return localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value ? "1" : "0");
      } catch {
      }
    }
  };
  const ARCHIVED_KEY = "conv.showArchived";
  let showArchived = store.get(ARCHIVED_KEY);
  let lastNodes = [];
  let editing = false;
  // closeAll drops an unfinished rename (the hidden input may never blur); a stale finish must not clear a newer one.
  let renameId = 0;
  function startRename(node, row, label) {
    if (editing) return;
    editing = true;
    const mine = ++renameId;
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
      } catch (cause) {
        showError(cause);
      }
      if (renameId === mine) editing = false;
      if (mode === "tree") tick(true);
      else input.replaceWith(main);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  }
  function onLongPress(target, callback) {
    let timer2, startX = 0, startY = 0, fired = false;
    const cancel = () => clearTimeout(timer2);
    target.addEventListener("pointerdown", (event) => {
      fired = false;
      startX = event.clientX;
      startY = event.clientY;
      cancel();
      timer2 = setTimeout(() => {
        fired = true;
        callback();
      }, 550);
    });
    target.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) target.addEventListener(type, cancel);
    target.addEventListener("contextmenu", (event) => event.preventDefault());
    target.addEventListener("click", (event) => {
      if (fired) {
        fired = false;
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    }, true);
  }
  async function archiveToggle(node) {
    try {
      if (node.archived) await ready().unarchiveConversation(node.id);
      else await ready().archiveConversation(node.id);
      tick(true);
    } catch (cause) {
      showError(cause);
    }
  }
  function renderTree(allNodes) {
    lastNodes = allNodes;
    const byAll = new Map(allNodes.map((node) => [node.id, node]));
    const archivedCount = allNodes.filter((node) => node.archived).length;
    const hidden = (node) => {
      const seen = /* @__PURE__ */ new Set();
      for (let current = node; current && !seen.has(current.id); current = byAll.get(current.parentId)) {
        seen.add(current.id);
        if (current.archived && !showArchived) return true;
      }
      return false;
    };
    const nodes = allNodes.filter((node) => !hidden(node));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const currentId = getSession()?.snapshot?.conversation?.id;
    const rows = nodes.map((node) => {
      const isCurrent = node.selected || !nodes.some((n) => n.selected) && node.id === currentId;
      const label = el("span", { class: "conv-title" }, node.title || "Untitled");
      const meta = node.busy ? [el("span", { class: "conv-dot busy", title: "Working", "aria-label": "working" })] : [];
      const depth = depthOf(node, byId);
      const open = el("button", { class: "conv-main", type: "button", role: "treeitem", "aria-level": String(depth + 1), "aria-current": isCurrent ? "true" : void 0 }, label, ...meta);
      const row = el("div", { class: "conv-row", style: `padding-left:${depth * 16}px` }, open);
      open.addEventListener("click", () => void switchTo(node.id));
      if (!["task", "subagent"].includes(node.kind)) onLongPress(open, () => startRename(node, row, label));
      if (!node.archived && ["main", "thread", "fork"].includes(node.kind)) {
        const fork = el("button", { class: "conv-icon-action", type: "button", "aria-label": `Fork \u201C${node.title || "Untitled"}\u201D`, title: "Fork", html: FORK_ICON });
        fork.addEventListener("click", () => void forkFrom(node, isCurrent));
        row.append(fork);
      }
      // Threads, forks and spawned subagents (never main or one-shot run helpers). Archiving a row hides it and everything
      // below it under the Archived toggle (the count is of archived rows only); a subagent that is working refuses, shown inline.
      if (["thread", "fork", "subagent"].includes(node.kind)) {
        const action = el("button", { class: "conv-icon-action", type: "button", "aria-label": `${node.archived ? "Unarchive" : "Archive"} \u201C${node.title || "Untitled"}\u201D`, title: node.archived ? "Unarchive" : "Archive", html: node.archived ? UNARCHIVE_ICON : ARCHIVE_ICON });
        action.addEventListener("click", () => void archiveToggle(node));
        row.append(action);
      }
      return row;
    });
    if (!rows.length) rows.push(el("p", { class: "conv-empty" }, "No conversations yet."));
    const toggles = [];
    const toggle = (text, on, key, set) => {
      const button = el("button", { class: "conv-text conv-toggle", type: "button", "aria-pressed": String(on) }, text);
      button.addEventListener("click", () => {
        set(!on);
        store.set(key, !on);
        renderTree(lastNodes);
      });
      toggles.push(button);
    };
    if (archivedCount > 0) toggle(`${showArchived ? "Hide archived" : "Archived"} (${archivedCount})`, showArchived, ARCHIVED_KEY, (v) => {
      showArchived = v;
    });
    if (toggles.length) rows.push(el("div", { class: "conv-toggles" }, ...toggles));
    treeList.replaceChildren(...rows);
  }
  async function forkFrom(node, isCurrent) {
    try {
      const s = ready();
      if (!isCurrent && s.snapshot?.conversation?.id !== node.id) await s.switchConversation(node.id);
      await s.forkThread();
      closeAll();
    } catch (cause) {
      showError(cause);
    }
  }
  async function switchTo(id) {
    try {
      await ready().switchConversation(id);
      closeAll();
    } catch (cause) {
      showError(cause);
    }
  }
  function openTree() {
    subscribeBack();
    mode = "tree";
    setChrome();
    clearInterval(timer);
    timer = setInterval(() => tick(), 2e3);
    tick(true);
  }
  function closeAll() {
    clearInterval(timer);
    editing = false;
    renameId++;
    unwatchTree();
    mode = "closed";
    setChrome();
    treeButton.focus({ preventScroll: true });
  }
  treeButton.addEventListener("click", openTree);
  backButton.addEventListener("click", closeAll);
  newButton.addEventListener("click", async () => {
    try {
      await ready().newThread();
      closeAll();
    } catch (cause) {
      showError(cause);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (mode === "tree") closeAll();
  });
  const api = { open: openTree, close: closeAll };
  wired.set(document, { by, api });
  return api;
}
// The chat's error line (#error), as app.js showError: used while the drawer is closed.
function showPageError(cause) {
  const error = document.getElementById("error");
  if (!error) return;
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
}
export {
  conversationsMountedBy,
  initConversations,
  mountBundled
};
