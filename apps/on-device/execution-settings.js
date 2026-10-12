// apps/on-device/execution-settings.js
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
