// core-providers-claude: the Claude Code Settings panel (step S1a of docs/plugins-ui-editions.md).
// Contributed by this plugin as a settings.sections entry in the provider slot (#provider-panels,
// under "This chat uses"); app.js mounts the same nodes as the bundled fallback. The markup and
// IDs are the ones index.html used to ship: app.js, chat-controls.js and the auth flows look
// them up by ID, so keep them (move, don't rename).
import { providerPanelSection } from "../../../provider-panels.js";

export const markup = `
<div id="claude-account" class="account-panel" hidden>
  <div class="account-actions"><button id="claude-login" class="login-button" type="button">Continue with Claude Code</button><button id="claude-logout" class="quiet-button" type="button" hidden>Sign out of Claude</button><button id="claude-cancel" class="quiet-button" type="button" hidden>Cancel Claude sign-in</button></div>
  <p id="claude-auth-status" class="settings-note" role="status">Connect your Claude account through Claude Code sign-in.</p>
  <a id="claude-open" class="auth-link" target="_blank" rel="noopener noreferrer" hidden>Open the Claude sign-in page</a>
  <form id="claude-code-form" class="key-settings" autocomplete="off" hidden>
    <label for="claude-code">Code from Claude<input id="claude-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the code from your browser" /></label>
    <button id="claude-code-submit" class="login-button" type="submit">Finish sign-in</button>
  </form>
</div>
<div id="claude-settings" class="key-settings" hidden><label for="claude-model">Model<select id="claude-model" disabled></select></label></div>
`;

export const section = providerPanelSection({ mode: "claude", title: "Claude Code", markup });
