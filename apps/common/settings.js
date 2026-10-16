// apps/common/settings.js
import { createSettingsSections } from "./settings-sections.js";
import { builtinPlugin } from "./builtin-plugins.js";
function initSettings() {
  const $ = (id) => document.getElementById(id);
  const settings = $("settings-dialog"), panel = $("agent-settings");
  $("settings-content").append(panel);
  panel.open = true;
  panel.addEventListener("toggle", () => {
    if (settings.open && !panel.open) panel.open = true;
  });
  function openSettings() {
    panel.open = true;
    if (!settings.open) settings.showModal();
  }
  $("chat-settings").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", () => settings.close());
  // Providers (N1): the bundled (empty, hidden) panel goes into #providers-panel now; core-plugin-management's section
  // (slot "providers") fills it with one selector per service that has several providers once composed.
  try { if ($("providers-panel")) builtinPlugin("core-plugin-management")?.entry.mountBundledProviders(document); } catch (cause) { console.error("Providers panel unavailable", cause); }
  // Contributed sections (S1): app.js connects the plugin runtime once composed.
  // Built-in provider panels (S1a) go to the "provider" slot under #mode; core-secrets (S1b)
  // to the "secrets" slot (#secrets-panel); core-plugin-management and core-execution (S1c) to
  // "plugins" (#plugins-panel) and "execution" (#execution-panel).
  // Provider options (slot "provider:<service>@<version>", under that service's selector in Settings → Providers).
  const resolveSlot = (name) => builtinPlugin("core-plugin-management")?.entry.providerSlot?.(name, document) ?? null;
  return { sections: createSettingsSections({ container: $("settings-content"), resolveSlot, slots: { provider: () => $("provider-panels"), secrets: () => $("secrets-panel"), plugins: () => $("plugins-panel"), execution: () => $("execution-panel"), providers: () => $("providers-panel") } }) };
}
export {
  initSettings
};
