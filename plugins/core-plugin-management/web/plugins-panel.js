// core-plugin-management: the Settings → Plugins screen's markup and slot section (step S1c of
// docs/plugins-ui-editions.md). The markup is the one index.html used to ship (same IDs:
// #plugin-settings, #plugin-group-conversation, #plugin-conversation-title, #plugin-list,
// #plugin-group-builtin, #plugin-builtin-count, #plugin-builtin, #plugin-group-installed,
// #plugin-installed-title, #plugin-installed, #plugin-status): move, don't rename. Kept apart
// from plugin-settings.js (the screen's logic, which imports core-agent-plugins.js and so the
// registry that imports this plugin's index.js): index.js must not import that module.
// Nodes are built once per document (provider-panels.js slotPanelSection): app.js puts the bundled
// copy into #plugins-panel and wires it (initPluginSettings) whether or not composition works,
// so the user can always reach Plugins to recover; the plugin's settings.sections entry (slot
// "plugins") moves the same nodes into its section.
import { slotPanelSection } from "../../../provider-panels.js";

export const PLUGINS_SLOT = "plugins";
export const PLUGINS_PANEL_ID = "plugins-panel";
export const markup = `
<details id="plugin-settings" class="native-settings" hidden>
  <summary>Plugins</summary>
  <section id="plugin-group-conversation" class="plugin-group" aria-labelledby="plugin-conversation-title" hidden>
    <h3 id="plugin-conversation-title" class="plugin-group-title">This conversation</h3>
    <div id="plugin-list" class="plugin-list" role="group" aria-label="Plugins in this conversation"></div>
  </section>
  <details id="plugin-group-builtin" class="plugin-group" hidden>
    <summary class="plugin-group-title">Built-in<span id="plugin-builtin-count" class="plugin-meta"></span></summary>
    <div id="plugin-builtin" class="plugin-list" role="group" aria-label="Built-in plugins"></div>
  </details>
  <section id="plugin-group-installed" class="plugin-group" aria-labelledby="plugin-installed-title" hidden>
    <h3 id="plugin-installed-title" class="plugin-group-title">Installed</h3>
    <div id="plugin-installed" class="plugin-list" role="group" aria-label="Installed plugins"></div>
  </section>
  <p id="plugin-status" class="settings-note" role="status" aria-live="polite"></p>
</details>
`;
export const section = slotPanelSection({ slot: PLUGINS_SLOT, slotId: PLUGINS_PANEL_ID, title: "Plugins", markup });
