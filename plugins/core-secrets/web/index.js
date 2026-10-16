// core-secrets: the Settings → Secrets screen as a plugin (step S1b of docs/plugins-ui-editions.md).
// Essential built-in (bundle self-forming-core) contributing settings.sections key "secrets"
// in the "secrets" slot (#secrets-panel, where index.html used to have the markup). The screen
// itself (markup, initSecretsSettings) is secrets-settings.js: DOM and bridge calls only, no
// library import. app.js mounts the same nodes as the bundled fallback (mountBundled) and wires
// them (initSecretsSettings), so Secrets appears even when composition fails. The native
// SecretStore/SecretBroker stay in the host: this plugin has no Kotlin half.
import { section, initSecretsSettings, SECRETS_SLOT, SECRETS_PANEL_ID } from "./secrets-settings.js";
import { mountBundledPanel } from "../../../provider-panels.js";

// Equals settings-sections.js SETTINGS_SECTIONS (declared statically, like core-servers' kinds).
const SETTINGS_SECTIONS = "settings.sections";
export const SECTION_KEY = "secrets";

export { section, initSecretsSettings, SECRETS_SLOT, SECRETS_PANEL_ID };

/** Bundled fallback: the Secrets nodes into #secrets-panel unless already attached. */
export const mountBundled = (doc = document) => mountBundledPanel(section, doc);

export function create() {
  return {
    setup(ctx) {
      ctx.contribute(SETTINGS_SECTIONS, SECTION_KEY, section, 50);
    }
  };
}
