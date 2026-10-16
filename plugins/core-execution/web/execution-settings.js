// core-execution: the Settings → Background work screen (step S1c of docs/plugins-ui-editions.md;
// was apps/common/execution-settings.js). The markup is the one index.html used to ship (same IDs:
// #execution-settings, #execution-status, #execution-refresh, #execution-battery, #execution-stop):
// move, don't rename. Its nodes are built once per document (provider-panels.js slotPanelSection):
// app.js puts the bundled copy into #execution-panel and wires it (initExecutionSettings, only when
// the host reports background execution) whether or not composition works; this plugin's
// settings.sections entry (slot "execution") moves the same nodes into its section.
import { slotPanelSection } from "../../../provider-panels.js";

export const EXECUTION_SLOT = "execution";
export const EXECUTION_PANEL_ID = "execution-panel";
export const markup = `
<details id="execution-settings" class="native-settings" hidden>
  <summary>Background work</summary>
  <p id="execution-status" class="settings-note" role="status" aria-live="polite">Reading background work status\u2026</p>
  <div class="app-edit-actions"><button id="execution-refresh" class="quiet-button" type="button">Refresh status</button><button id="execution-battery" class="quiet-button" type="button">Battery settings</button><button id="execution-stop" class="quiet-button" type="button">Stop all commands</button></div>
</details>
`;
export const section = slotPanelSection({ slot: EXECUTION_SLOT, slotId: EXECUTION_PANEL_ID, title: "Background work", markup });
function executionOwner() {
  const key = "self-forming.execution-owner.v1";
  try {
    let owner = localStorage.getItem(key);
    if (!owner || !/^workspace:[0-9a-f-]{36}$/.test(owner)) {
      owner = `workspace:${crypto.randomUUID()}`;
      localStorage.setItem(key, owner);
    }
    return owner;
  } catch {
    return `workspace:${crypto.randomUUID()}`;
  }
}
function initExecutionSettings(bridge) {
  const section = document.getElementById("execution-settings");
  const status = document.getElementById("execution-status");
  const stop = document.getElementById("execution-stop");
  const refresh = document.getElementById("execution-refresh");
  const battery = document.getElementById("execution-battery");
  section.hidden = false;
  let busy = false;
  async function update(stopping = false) {
    if (busy) return;
    busy = true;
    stop.disabled = refresh.disabled = true;
    try {
      const state = await bridge.call(stopping ? "env.service.stop" : "env.service.info");
      const count = Number(state.commands) || 0;
      const background = Number(state.backgroundCommands) || 0;
      status.textContent = count ? `${count} running command${count === 1 ? "" : "s"} \xB7 ${background} continuing in the background.` : "No commands are running.";
      stop.disabled = count === 0;
    } catch (error) {
      status.textContent = error?.message || "Could not check background work.";
      stop.disabled = false;
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => void update());
  stop.addEventListener("click", () => void update(true));
  battery.addEventListener("click", () => {
    void bridge.call("env.service.batterySettings").catch((error) => {
      status.textContent = error.message;
    });
  });
  section.addEventListener("toggle", () => {
    if (section.open) void update();
  });
  document.getElementById("chat-settings").addEventListener("click", () => void update());
  void update();
}
export {
  executionOwner,
  initExecutionSettings
};
