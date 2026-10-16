// core-secrets: the Settings → Secrets screen (step S1b of docs/plugins-ui-editions.md; was
// apps/common/secrets-settings.js). The markup below is the one index.html used to ship (same
// IDs: #secrets-unavailable, #secrets-settings, #secrets-error, #secrets-lock(-text),
// #secrets-unlock, #secrets-list, #secrets-form, #secrets-name, #secrets-value,
// #secrets-new-toggles, #secrets-save): move, don't rename. Its nodes are built once per
// document (provider-panels.js slotPanelSection): app.js puts the bundled copy into
// #secrets-panel and wires it (initSecretsSettings) whether or not composition works; this
// plugin's settings.sections entry (slot "secrets") moves the same nodes into its section.
// Security: the page never receives stored values (secrets.list gives names, scopes and
// flags only); values typed here go straight to secrets.set and the inputs are cleared;
// nothing here logs. The keystore, scope injection and broker stay in the native host
// (SecretStore.kt, SecretBroker.kt).
import { slotPanelSection } from "../../../provider-panels.js";

export const SECRETS_SLOT = "secrets";
export const SECRETS_PANEL_ID = "secrets-panel";
export const markup = `
<p id="secrets-unavailable" class="settings-note" hidden>Secrets need the latest app update.</p>
<details id="secrets-settings" class="native-settings" hidden>
  <summary>Secrets</summary>
  <p id="secrets-error" class="settings-note secrets-error" role="alert" hidden></p>
  <p id="secrets-lock" class="settings-note secrets-lock" hidden><span id="secrets-lock-text"></span> <button id="secrets-unlock" class="secrets-action" type="button" hidden>Unlock</button></p>
  <div id="secrets-list" class="secrets-list"></div>
  <form id="secrets-form" class="secrets-form" autocomplete="off">
    <label class="secrets-field">Name<input id="secrets-name" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" pattern="^[A-Z_][A-Z0-9_]*$" required placeholder="API_TOKEN" /></label>
    <label class="secrets-field">Value<input id="secrets-value" type="password" autocomplete="off" spellcheck="false" required /></label>
    <div id="secrets-new-toggles" class="secrets-toggles"></div>
    <div class="secrets-actions"><button id="secrets-save" class="secrets-action" type="submit">Save</button></div>
  </form>
</details>
`;
export const section = slotPanelSection({ slot: SECRETS_SLOT, slotId: SECRETS_PANEL_ID, title: "Secrets", markup });

var TOGGLES = [
  ["agent", "My commands", (s) => s.scopes?.agent],
  ["servers", "Servers", (s) => s.scopes?.servers],
  ["redact", "Hide in output", (s) => s.redact],
  ["biometric", "Require fingerprint", (s) => s.biometric],
  ["askEveryTime", "Ask every time", (s) => s.askEveryTime]
];
var NEW_DEFAULTS = { agent: false, servers: false, redact: true, biometric: false, askEveryTime: false };
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}
function toggleRow(key, label, checked, onChange) {
  const input = el("input", { type: "checkbox", checked: Boolean(checked) });
  input.dataset.key = key;
  if (key === "biometric") input.addEventListener("change", () => syncAsk(input.closest(".secrets-toggles") ?? input.parentElement?.parentElement));
  if (onChange) input.addEventListener("change", () => onChange(input));
  return el("label", { class: "secrets-toggle" }, input, label);
}
function syncAsk(root) {
  const biometric = root?.querySelector("input[data-key=biometric]");
  const ask = root?.querySelector("input[data-key=askEveryTime]");
  if (!biometric || !ask) return;
  if (!biometric.checked) ask.checked = false;
  ask.disabled = !biometric.checked;
}
function payloadFrom(root) {
  const v = {};
  for (const input of root.querySelectorAll("input[data-key]")) v[input.dataset.key] = input.checked;
  return { scopes: { agent: v.agent, servers: v.servers }, redact: v.redact, biometric: v.biometric, askEveryTime: Boolean(v.biometric && v.askEveryTime) };
}
function initSecretsSettings(bridge) {
  const section = document.getElementById("secrets-settings");
  const unavailable = document.getElementById("secrets-unavailable");
  if (!section) return;
  if (globalThis.__piHostInfo?.capabilities?.secrets !== true || !bridge) {
    section.hidden = true;
    if (unavailable) {
      // The browser edition has no encrypted key store: not something an update fixes.
      if (globalThis.__piHostInfo?.platform === "browser") unavailable.textContent = "Secrets are available only in the Android app (they need its encrypted key store).";
      unavailable.hidden = false;
    }
    return;
  }
  if (section.dataset.ready) return;
  section.dataset.ready = "1";
  unavailable.hidden = true;
  section.hidden = false;
  const list = document.getElementById("secrets-list");
  const errorBox = document.getElementById("secrets-error");
  const lock = document.getElementById("secrets-lock");
  const lockText = document.getElementById("secrets-lock-text");
  const unlock = document.getElementById("secrets-unlock");
  const form = document.getElementById("secrets-form");
  const nameInput = document.getElementById("secrets-name");
  const valueInput = document.getElementById("secrets-value");
  const newToggles = document.getElementById("secrets-new-toggles");
  for (const [key, label] of TOGGLES) newToggles.append(toggleRow(key, label, NEW_DEFAULTS[key]));
  syncAsk(newToggles);
  let busy = false;
  const showError = (e) => {
    errorBox.textContent = e ? e.message || String(e) : "";
    errorBox.hidden = !e;
  };
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function render(state) {
    const secrets = state?.secrets ?? [];
    list.replaceChildren(...secrets.map(renderItem));
    const needsLock = secrets.some((s) => s.biometric);
    lock.hidden = !needsLock;
    if (needsLock) {
      const open = Number(state.unlockedUntil) > Date.now();
      lockText.textContent = open ? `Fingerprint secrets: unlocked until ${time(state.unlockedUntil)}` : "Fingerprint secrets: locked";
      unlock.hidden = open;
    }
  }
  function renderItem(secret) {
    const item = el("div", { class: "secrets-item" });
    const toggles = el("div", { class: "secrets-toggles" });
    for (const [key, label, get] of TOGGLES) {
      toggles.append(toggleRow(key, label, get(secret), async () => {
        await run(() => bridge.call("secrets.set", { name: secret.name, ...payloadFrom(toggles) }));
      }));
    }
    syncAsk(toggles);
    const actions = el("div", { class: "secrets-actions" });
    const replace = el("button", { class: "secrets-action", type: "button" }, "Replace value");
    const del = el("button", { class: "secrets-action", type: "button" }, "Delete");
    const slot = el("div");
    replace.addEventListener("click", () => {
      if (slot.firstChild) {
        slot.replaceChildren();
        return;
      }
      const field = el("input", { type: "password", autocomplete: "off", spellcheck: false, required: true, "aria-label": `New value for ${secret.name}` });
      const save = el("button", { class: "secrets-action", type: "button" }, "Save");
      save.addEventListener("click", async () => {
        if (!field.value) return;
        const body = { name: secret.name, value: field.value, ...payloadFrom(toggles) };
        field.value = "";
        try {
          await run(() => bridge.call("secrets.set", body));
        } finally {
          body.value = "";
        }
        slot.replaceChildren();
      });
      slot.append(el("div", { class: "secrets-replace" }, "New value", field, save));
      field.focus();
    });
    del.addEventListener("click", async () => {
      if (!confirm(`Delete ${secret.name}? Commands started later will not get it.`)) return;
      await run(async () => {
        await bridge.call("secrets.delete", { name: secret.name });
        return bridge.call("secrets.list", {});
      });
    });
    actions.append(replace, del);
    item.append(el("div", { class: "secrets-name" }, secret.name), toggles, actions, slot);
    return item;
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    showError(null);
    try {
      let state;
      try {
        state = await fn();
      } catch (e) {
        if (e?.code !== "LOCKED" && !/Unlock with your fingerprint/.test(String(e?.message))) throw e;
        await bridge.call("secrets.unlock", {});
        state = await fn();
      }
      render(state?.secrets ? state : await bridge.call("secrets.list", {}));
    } catch (e) {
      showError(e);
      try {
        render(await bridge.call("secrets.list", {}));
      } catch {
      }
    } finally {
      busy = false;
    }
  }
  const refresh = () => run(() => bridge.call("secrets.list", {}));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !valueInput.value) {
      showError(new Error("Name must use A-Z, 0-9 and _, and a value is required."));
      return;
    }
    const body = { name, value: valueInput.value, ...payloadFrom(newToggles) };
    valueInput.value = "";
    try {
      await run(() => bridge.call("secrets.set", body));
      if (errorBox.hidden) {
        nameInput.value = "";
        for (const input of newToggles.querySelectorAll("input[data-key]")) input.checked = NEW_DEFAULTS[input.dataset.key];
      }
      syncAsk(newToggles);
    } finally {
      body.value = "";
      valueInput.value = "";
    }
  });
  unlock.addEventListener("click", () => run(async () => {
    await bridge.call("secrets.unlock", {});
    return bridge.call("secrets.list", {});
  }));
  section.addEventListener("toggle", () => {
    if (section.open) void refresh();
  });
  document.getElementById("chat-settings")?.addEventListener("click", () => {
    if (section.open) void refresh();
  });
  void refresh();
}
export {
  initSecretsSettings
};
