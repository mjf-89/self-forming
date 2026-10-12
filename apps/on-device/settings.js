// apps/on-device/settings.js
// Settings dialog: the agent settings panel lives inside it, opened from the header's settings button.
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
}
export {
  initSettings
};
