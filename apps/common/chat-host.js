// apps/common/chat-host.js
// The page's side of the chat (step C7, docs/plugins-providers-agent-core.md §B2 "How chat
// becomes a plugin"). The chat itself is the essential built-in core-chat
// (plugins/core-chat/web/chat.js); it runs on agent.sessions@1 and gets from this host only
// what is page-owned and not part of a session: the credential controllers, the reloading
// state and the app-revision hooks (Settings → App editing, the activation chain). app.js
// creates the host before composition and registers it (setPageChatHost) so plugin-builtins.js
// can hand it to core-chat; app.js mounts the bundled core-chat copy on the same host when
// composition fails or core-chat did not mount. Only the first mount wins (claim).
// No imports: plain page state.

let pageHost;

/** The page's chat host (set by app.js), or undefined (tests, forks without a chat). */
export function pageChatHost() {
  return pageHost;
}
/** Registers the page's chat host; plugin-builtins.js gives it to core-chat. */
export function setPageChatHost(host) {
  pageHost = host;
  return host;
}

/**
 * hooks (all optional):
 * - reloading(): true while an app update activates or reloadNow runs (no new chat operation).
 * - auth(), claudeAuth(): the page's ChatGPT/Claude credential controllers (or undefined).
 * - begun: Promise resolved once the page's sessions began (app.js start() after
 *   sessions.begun); the chat restores the sign-ins then, as app.js did.
 * - afterRender(snapshot): runs after every chat render (Settings → Plugins update, queued app
 *   revisions: the activation chain stays in app.js).
 * - revisionControls(): refreshes Settings → App editing buttons.
 * - applyQueued(session): applies a queued app revision after a resumed reply.
 * The chat attaches its page API once mounted: render(snapshot), busy(), signingIn(),
 * saveDraft(session), openUrl(kind, url).
 */
export function createChatHost(hooks = {}) {
  let chat = null;
  let mountedBy;
  const noop = () => {};
  return Object.freeze({
    reloading: hooks.reloading ?? (() => false),
    auth: hooks.auth ?? (() => void 0),
    claudeAuth: hooks.claudeAuth ?? (() => void 0),
    begun: hooks.begun ?? Promise.resolve(),
    afterRender: hooks.afterRender ?? noop,
    revisionControls: hooks.revisionControls ?? noop,
    applyQueued: hooks.applyQueued ?? (async () => {}),
    /** First caller mounts the chat ("core-chat" or "bundled"); false once mounted. */
    claim(by) {
      if (mountedBy) return false;
      mountedBy = String(by || "page");
      return true;
    },
    /** A claim whose mount failed before wiring anything (the bundled copy may try again). */
    release(by) {
      if (mountedBy === by && !chat) mountedBy = void 0;
    },
    /** Who mounted the chat: "core-chat", "bundled", or undefined. */
    get mountedBy() {
      return mountedBy;
    },
    attach(api) {
      chat = api ?? null;
    },
    /** The mounted chat's page API, or null before mount. */
    get chat() {
      return chat;
    }
  });
}
