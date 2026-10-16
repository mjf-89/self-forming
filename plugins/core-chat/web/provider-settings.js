// plugins/core-chat/web/provider-settings.js (was apps/common/provider-settings.js)
// Settings for contributed model providers (step P4 of docs/plugins-providers-agent-core.md).
// The built-in modes (the static #mode options of index.html: offline, chatgpt, claude,
// openai) keep their own panels and IDs (contributed by their plugins since S1a,
// provider-panels.js); this module never touches them. For every other
// provider row of the open session (session.providers(), agent.sessions@1) it:
// - adds a #mode option "<label>" (data-contributed). An option whose row goes away while
//   it is selected becomes the "(not available)" option chat.js modeOption keeps (P3);
// - fills the generic panel #provider-panel: a Model select (#provider-model) from the
//   row's live models() (its catalog() until they load, or when they fail), a status line
//   (#provider-status, role=status) and a Connect button (#provider-connect), shown only
//   when the row exposes connect().
// chat.js asks it for the selected model, thinking efforts, whether saved work can resume
// (ready) and the composer model label (modelLabel). Rendering is signature-diffed:
// update() runs on every chat snapshot. Owned by core-chat since C7 (chat.js wires it).
const message = (error) => error instanceof Error ? error.message : String(error);
const rawId = (mode) => String(mode).startsWith("provider:") ? String(mode).slice("provider:".length) : String(mode);

export function initProviderSettings({ getSession, onChange = () => {}, onUpdate = () => {}, onConnected = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const select = $("mode");
  const panel = $("provider-panel");
  if (!select || !panel) {
    return { sync() {}, restore() {}, update() {}, row: () => void 0, selectedModel: () => "", thinkingEfforts: () => void 0, ready: () => false, modelLabel: () => void 0 };
  }
  // Built-in modes: the options index.html ships (P3/P4 options carry a data marker).
  const builtins = new Set([...select.options].filter((option) => !option.dataset.provider && !option.dataset.contributed).map((option) => option.value));
  const model = document.createElement("select");
  model.id = "provider-model";
  const label = document.createElement("label");
  label.htmlFor = "provider-model";
  label.append("Model", model);
  const connect = document.createElement("button");
  connect.id = "provider-connect";
  connect.className = "quiet-button";
  connect.type = "button";
  connect.hidden = true;
  connect.textContent = "Connect";
  const status = document.createElement("p");
  status.id = "provider-status";
  status.className = "settings-note";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.replaceChildren(label, connect, status);

  let session = null;
  let rows = new Map(); // mode -> providers() entry, contributed modes only
  const loads = new Map(); // mode -> {list, loading, error}
  let shown = null; // contributed mode whose panel is shown
  let choice = null; // the chat's stored choice (restore)
  let locked = false;
  let connecting = null, connectError = "";
  let subscribed = null, unsubscribe = () => {};
  let signature = "";

  const catalogOf = (entry) => {
    try {
      const list = entry.catalog?.();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const optionFor = (mode) => [...select.options].find((option) => option.value === mode);
  function follow(mode, entry) {
    if (subscribed === mode) return;
    unsubscribe();
    unsubscribe = () => {};
    subscribed = mode;
    if (!mode || typeof entry?.subscribe !== "function") return;
    try {
      const off = entry.subscribe(() => queueMicrotask(() => {
        if (subscribed !== mode) return;
        const before = rows.get(mode)?.status?.ready;
        sync();
        // Readiness changed (signed in, server up): the live model list may differ now.
        if (rows.get(mode)?.status?.ready !== before) loads.delete(mode);
        signature = "";
        onUpdate();
      }));
      if (typeof off === "function") unsubscribe = off;
    } catch {
    }
  }
  /** Reads providers() of the open session and keeps the contributed #mode options in step. */
  function sync() {
    const current = getSession?.();
    if (current !== session) {
      session = current ?? null;
      loads.clear();
      follow(null);
      signature = "";
    }
    if (!current) return rows;
    let list;
    try {
      list = current.providers?.() ?? [];
    } catch {
      return rows;
    }
    rows = new Map(list.filter((entry) => entry && typeof entry.mode === "string" && !builtins.has(entry.mode)).map((entry) => [entry.mode, entry]));
    for (const [mode, entry] of rows) {
      let option = optionFor(mode);
      if (!option) {
        option = new Option(entry.label, mode);
        select.add(option);
      }
      if (option.textContent !== entry.label) option.textContent = entry.label;
      if (option.disabled) option.disabled = false;
      if (option.dataset.provider) delete option.dataset.provider;
      if (!option.dataset.contributed) option.dataset.contributed = "true";
    }
    for (const option of [...select.options]) {
      if (!option.dataset.contributed || rows.has(option.value)) continue;
      if (option.value !== select.value) {
        option.remove();
        continue;
      }
      // Selected while its provider went away: the P3 "(not available)" option.
      delete option.dataset.contributed;
      option.dataset.provider = "unavailable";
      option.textContent = `${option.textContent} (not available)`;
      option.disabled = true;
    }
    return rows;
  }
  async function load(mode, entry) {
    const state = { list: catalogOf(entry), loading: typeof entry.models === "function", error: "" };
    loads.set(mode, state);
    if (!state.loading) return;
    try {
      const list = await entry.models();
      if (loads.get(mode) === state && Array.isArray(list)) state.list = list;
    } catch (cause) {
      if (loads.get(mode) === state) state.error = message(cause);
    } finally {
      if (loads.get(mode) === state) {
        state.loading = false;
        signature = "";
        onUpdate();
      }
    }
  }
  const wantedModel = (mode) => choice?.mode === mode && typeof choice.modelId === "string" ? choice.modelId : "";
  function statusText(mode, entry, state) {
    const parts = [];
    const now = entry.status;
    if (connecting === mode) parts.push(`Connecting to ${entry.label}\u2026`);
    else if (connectError) parts.push(connectError);
    else if (now?.message) parts.push(String(now.message));
    else if (now && now.ready === false) parts.push(`${entry.label} is not connected.`);
    if (state.loading) parts.push("Loading models\u2026");
    else if (state.error) parts.push(state.error);
    return parts.join(" ");
  }
  function render(mode, entry) {
    const state = loads.get(mode) ?? { list: catalogOf(entry), loading: false, error: "" };
    const models = state.list.filter((item) => item && typeof item.id === "string").map((item) => [item.id, String(item.name || item.id)]);
    const fallback = models.find(([id]) => id === entry.defaultModelId)?.[1];
    const options = [["", fallback ? `Default (${fallback})` : "Default"], ...models];
    const wanted = wantedModel(mode);
    if (!options.some(([id]) => id === wanted)) options.push([wanted, wanted]);
    const text = statusText(mode, entry, state);
    const showConnect = typeof entry.connect === "function" && entry.status?.ready !== true;
    const next = JSON.stringify([mode, options, wanted, text, locked, connecting, showConnect, state.loading, entry.label]);
    if (next === signature) return;
    signature = next;
    model.replaceChildren(...options.map(([id, name]) => new Option(name, id)));
    model.value = wanted;
    model.disabled = locked || state.loading && !models.length;
    connect.hidden = !showConnect;
    connect.disabled = locked || connecting !== null;
    connect.setAttribute("aria-label", `Connect ${entry.label}`);
    status.textContent = text;
  }
  /** mode: the #mode value; locked: model controls are locked (no session, busy, background). */
  function update({ mode = select.value, locked: nextLocked = locked } = {}) {
    sync();
    locked = Boolean(nextLocked);
    const entry = rows.get(mode);
    if (shown !== (entry ? mode : null)) {
      shown = entry ? mode : null;
      connectError = "";
      signature = "";
    }
    follow(shown, entry);
    panel.hidden = !entry;
    if (!entry) return;
    if (!loads.has(mode)) void load(mode, entry);
    render(mode, entry);
  }
  function restore(next) {
    choice = next ? { mode: next.mode, modelId: next.modelId ?? "", thinkingEffort: next.thinkingEffort ?? "" } : null;
    signature = "";
    if (shown && rows.has(shown)) render(shown, rows.get(shown));
  }
  model.addEventListener("change", () => {
    if (!shown) return;
    choice = { ...choice?.mode === shown ? choice : { mode: shown, thinkingEffort: "" }, modelId: model.value };
    onChange(shown);
  });
  connect.addEventListener("click", async () => {
    const mode = shown, entry = rows.get(mode);
    if (!entry || typeof entry.connect !== "function" || connecting !== null || locked) return;
    connecting = mode;
    connectError = "";
    signature = "";
    render(mode, entry);
    let connected = false;
    try {
      await entry.connect();
      connected = true;
    } catch (cause) {
      connectError = `Could not connect: ${message(cause)}`;
    } finally {
      connecting = null;
      loads.delete(mode);
      signature = "";
      onUpdate();
    }
    if (connected) onConnected(mode);
  });

  return {
    sync,
    restore,
    update,
    /** The providers() entry of a contributed mode (undefined for built-in and missing modes). */
    row: (mode) => rows.get(mode),
    /** Model id for a save: the panel's choice while it shows that mode, else the stored one. */
    selectedModel: (mode = select.value) => builtins.has(mode) ? "" : shown === mode ? model.value : wantedModel(mode),
    /** Thinking efforts of a contributed mode; undefined for built-in and missing modes. */
    thinkingEfforts(mode, modelId) {
      const entry = rows.get(mode);
      if (!entry) return void 0;
      try {
        const efforts = entry.thinkingEfforts?.(modelId);
        return Array.isArray(efforts) ? efforts : [];
      } catch {
        return [];
      }
    },
    /** Saved work of a contributed mode can resume without user input. */
    ready(mode) {
      const entry = sync().get(mode);
      if (!entry || entry.auth === "transient-key") return false;
      return entry.status ? entry.status.ready === true : entry.auth === "none";
    },
    /** Composer label: the row's model name; undefined for built-in modes (chat-controls keeps them). */
    modelLabel(mode, modelId) {
      if (!mode || builtins.has(mode)) return void 0;
      const entry = rows.get(mode);
      if (!entry) return modelId || optionFor(mode)?.textContent || rawId(mode);
      const id = (modelId ?? (shown === mode ? model.value : wantedModel(mode))) || entry.defaultModelId || "";
      const list = loads.get(mode)?.list ?? catalogOf(entry);
      return String(list.find((item) => item?.id === id)?.name || id || entry.label);
    }
  };
}
