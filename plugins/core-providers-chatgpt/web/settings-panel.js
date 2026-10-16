// core-providers-chatgpt: the ChatGPT Settings panel (step S1a of docs/plugins-ui-editions.md).
// Contributed by this plugin as a settings.sections entry in the provider slot (#provider-panels,
// under "This chat uses"); app.js mounts the same nodes as the bundled fallback. The markup and
// IDs are the ones index.html used to ship: app.js, chat-controls.js and the auth flows look
// them up by ID, so keep them (move, don't rename).
import { providerPanelSection } from "../../../provider-panels.js";

export const markup = `
<div id="chatgpt-account" class="account-panel" hidden>
  <div class="account-actions"><button id="chatgpt-login" class="login-button" type="button" aria-label="Log in with ChatGPT">Continue with ChatGPT</button><button id="chatgpt-logout" class="quiet-button" type="button" hidden>Sign out</button><button id="chatgpt-switch" class="quiet-button" type="button" hidden>Use another account</button><button id="chatgpt-cancel" class="quiet-button" type="button" hidden>Cancel sign-in</button></div>
  <p id="auth-status" class="settings-note" role="status">Connect your ChatGPT account to use its available models.</p>
  <a id="chatgpt-open" class="auth-link" target="_blank" rel="noopener noreferrer" hidden>Open the sign-in page</a>
</div>
<div id="chatgpt-settings" class="key-settings" hidden><label>Model<select id="chatgpt-model" disabled><option value="">Sign in to see your models</option></select></label><button id="refresh-models" class="quiet-button" type="button" hidden>Refresh models</button><p id="chatgpt-note" class="settings-note"></p></div>
`;

export const section = providerPanelSection({ mode: "chatgpt", title: "ChatGPT", markup });
