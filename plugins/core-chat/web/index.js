// core-chat: the chat screen and the model part of Settings as a plugin (step C7 of
// docs/plugins-providers-agent-core.md, §B2 "How chat becomes a plugin"). Essential built-in
// (bundle self-forming-core, reload "page") that requires agent.sessions@1 and reaches the
// model providers only through it (sessions.current().providers(), providerLabel()). It owns
// chat.js (render, composer listeners, drafts, attachments, stop/resume, #mode, sign-in
// wiring of the provider panels, thinking), chat-renderer.js, chat-controls.js,
// attachment-composer.js and provider-settings.js.
// create({page}) gets the page's chat host (apps/common/chat-host.js) from plugin-builtins.js;
// setup mounts the chat on the agent.sessions@1 service. app.js mounts this module's mountChat
// (the bundled copy) when composition fails or core-chat did not mount; only the first mount
// wins. Page-owned: stopping the plugin never unmounts the chat or touches a reply or draft.
// No library import at evaluation (chat.js imports session.js lazily).
import { mountChat } from "./chat.js";
export { mountChat };
const AGENT_SESSIONS_SERVICE = "agent.sessions";

export function create({ page } = {}) {
  return {
    async setup(ctx) {
      const sessions = ctx.get(AGENT_SESSIONS_SERVICE, 1);
      if (!sessions || !page) return; // no page chat (tests, forks): nothing to mount
      await mountChat({ sessions, page, by: "core-chat" });
    }
  };
}

export { createBrowserActivity } from './browser-activity.js';
