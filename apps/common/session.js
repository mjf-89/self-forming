// apps/common/session.js
// Thin assembler: the session is built from session-engine.js (Harness open/close, storage,
// registry, send/stop/resume), which composes session-tail.js (chat rendering and the
// conversation tail), session-threads.js (thread metadata, drafts, attachments),
// session-tree.js (conversation tree) and session-providers.js (model providers).
// The public API of the former single file is unchanged.
export {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  getThinkingEfforts,
  openAppSession
} from "./session-engine.js";
