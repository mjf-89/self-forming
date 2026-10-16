// core-providers-openai: the OpenAI API key Settings panel (step S1a of docs/plugins-ui-editions.md).
// Contributed by this plugin as a settings.sections entry in the provider slot (#provider-panels,
// under "This chat uses"); app.js mounts the same nodes as the bundled fallback. The markup and
// IDs are the ones index.html used to ship: app.js, chat-controls.js and the auth flows look
// them up by ID, so keep them (move, don't rename).
import { providerPanelSection } from "../../../provider-panels.js";

export const markup = `
<div id="openai-settings" class="key-settings" hidden>
  <label>API key<input id="api-key" type="password" placeholder="Your OpenAI API key" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
  <label>Model<input id="model" type="text" value="gpt-4.1-mini" autocapitalize="off" spellcheck="false" /></label>
</div>
`;

export const section = providerPanelSection({ mode: "openai", title: "OpenAI API key", markup });
