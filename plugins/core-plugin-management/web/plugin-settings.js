// Settings → Plugins: every plugin, in three groups.
// 1. "This conversation" (#plugin-list): plugins whose agent tools the CURRENT
//    conversation may use. A checkbox edits only that conversation (pi.agent
//    extensions.remove) and applies from its next model request (A1, unchanged).
// 2. "Built-in" (#plugin-builtin): the page runtime's own plugins (core-*), with what
//    they contribute (tools, prompt sections, skills, labelled kinds), the services they
//    provide/need and their state. No switch. A core plugin whose runtime copy failed,
//    stopped or could not be built says "Failed: ... (using built-in copy)": the
//    session runs on the bundled copy (agent-extensions.js core fallback; for model
//    providers agent-providers.js list().fallbacks, e.g. after create() failed).
// 3. "Installed" (#plugin-installed): packages from the host's plugins.list, with
//    app-wide Disable/Enable/Roll back (plugins.disable/enable/rollback). Disabling a
//    plugin that pending durable tasks wait for asks first (docs/plugins.md §9a).
//    Mutations are never retried automatically; the list is re-read afterwards.
//    Built-ins are grouped by bundle (plugin-bundles.js, docs/plugins.md §9b2): one
//    collapsed row per bundle ("<label> · N · all active"), expanding to the member
//    rows, opened automatically while a member is not active. Plugins in no bundle
//    are listed individually.
// "Reload now" (docs/plugins-providers-agent-core.md §F.3): shown under the status line
// only when a page reload is pending and the optional reloadNow() was supplied
// (save-close-reload, owned by the caller). Disabled while locked().
// Rendering is signature-diffed: app.js may call update() on every chat snapshot.
// Data: runtime.list()/contributions() (connect), agentExtensions.describe through
// session.plugins(), bridge plugins.list (only with host capability "plugins").
// The list is read when connected, when Settings opens and after an action; there
// is no polling.
import { CORE_AGENT_PLUGINS } from "../../../core-agent-plugins.js";
import { groupByBundle, bundleSummary } from "../../../plugin-bundles.js";

const STATE_LABELS = { active: "Active", installed: "Installed", failed: "Failed", blocked: "Blocked", stopped: "Stopped", "restart-required": "Restart required", "reload-required": "Reload required", disabled: "Disabled", starting: "Starting", unknown: "Unknown" };
const PROBLEMS = new Set(["failed", "blocked", "stopped", "restart-required", "reload-required", "disabled"]);
const BUILTIN_NAMES = Object.freeze({
  "core-execution": "Command execution",
  "core-agent": "Agent sessions",
  "core-providers-offline": "Offline demo",
  "core-providers-openai": "OpenAI API",
  "core-providers-chatgpt": "ChatGPT",
  "core-providers-claude": "Claude",
  "look-public": "Look: light",
  ...Object.fromEntries(CORE_AGENT_PLUGINS.map((row) => [row.id, row.name]))
});
const AGENT_EXTENSIONS = "agent.extensions";
const AGENT_SKILLS = "agent.skills";
// Contribution kinds of optional built-in bundles that read by label: a built-in whose id
// starts with prefix is named title(label); its contributions read "one|many: labels".
const LABELLED = Object.freeze([
]);
const message = (error) => error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error);
const label = (state) => STATE_LABELS[state] ?? String(state ?? "Unknown");
const contract = ({ id, version }) => `${id}@${version}`;
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const labelledById = (id) => LABELLED.find((kind) => typeof id === "string" && id.startsWith(kind.prefix));

/** Plain name of a built-in runtime plugin id (labelled kinds: title(<label>)). */
export function builtinName(id, contributionLabel) {
  if (BUILTIN_NAMES[id]) return BUILTIN_NAMES[id];
  const labelled = labelledById(id);
  if (labelled) {
    const key = id.slice(labelled.prefix.length);
    return labelled.title(contributionLabel || key.charAt(0).toUpperCase() + key.slice(1));
  }
  return id;
}

/** Text of the pre-disable warning, or "" when nothing is known to wait. */
export function pendingWarning(name, work) {
  if (!work || work.error !== undefined) return `Pending work for ${name} could not be checked${work?.error ? `: ${work.error}` : ""}.`;
  const count = work.tasks ?? 0;
  const where = (work.conversations?.length ?? 0) > 1 ? ` in ${work.conversations.length} conversations` : "";
  if (count > 0) return `${work.partial ? "At least " : ""}${plural(count, "pending task waits", "pending tasks wait")} for ${name}${where}. They resume when it is enabled again.`;
  return work.partial ? `Pending work for ${name} could not be fully checked.` : "";
}

/**
 * Whether the page should reload to apply plugin changes: the runtime says so
 * (reloadRequired()/reloadPending(), or a record in state "reload-required" or with
 * reloadPending: true, e.g. a pending core replacement), an installed web plugin waits
 * for the next page load, or an action on this page answered "after the app reloads".
 */
export function reloadPending({ runtime, installedRows = [], actionReload = false } = {}) {
  if (actionReload) return true;
  try {
    const reported = runtime?.reloadRequired?.() ?? runtime?.reloadPending?.();
    if (reported) return true;
    if ((runtime?.list?.() ?? []).some((record) => record?.state === "reload-required" || record?.reloadPending === true)) return true;
  } catch { /* diagnostics only */ }
  return installedRows.some((row) => row.state === "reload-required" || (row.state === "installed" && row.web === true));
}

export function initPluginSettings({ agentExtensions, agentProviders, getSession, locked = () => false, showError = () => {}, reloadNow: initialReloadNow } = {}) {
  const $ = (id) => document.getElementById(id);
  const section = $("plugin-settings");
  const list = $("plugin-list");
  const note = $("plugin-status");
  if (!section || !list) return { update() {}, connect() {}, refresh: async () => {} };
  const groups = {
    conversation: $("plugin-group-conversation"),
    builtin: $("plugin-group-builtin"), builtinList: $("plugin-builtin"), builtinCount: $("plugin-builtin-count"),
    installed: $("plugin-group-installed"), installedList: $("plugin-installed")
  };
  const pending = new Map(); // pluginId -> {conversationId, enabled}
  let signature = "";
  let runtime = null, bridge = null, capable = false, bootInventory = [];
  let inventory = null, inventoryError = "", reading = null, readAgain = false;
  let busy = null; // {id, action}: one app-wide plugin action at a time
  let confirming = null; // {id, text}
  let actionText = "";
  let unsubscribeRuntime = () => {};
  let scheduled = false;
  let reloadNow = typeof initialReloadNow === "function" ? initialReloadNow : null;
  let actionReload = false; // a successful action on this page applies after a reload
  let reloading = false, reloadError = "";
  const bundleChoice = new Map(); // bundle id -> open state the user chose against the default

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function reasonLine(text, detail, role) {
    const line = element("p", "plugin-reason");
    if (role) line.setAttribute("role", role);
    line.append(element("strong", "", text), detail ? `: ${detail}` : "");
    return line;
  }
  function problem(row) {
    if (row.errors?.length) return { label: row.toggle ? "Partly failed" : "Failed", text: row.errors.join(" · ") };
    if (STATE_LABELS[row.state] && PROBLEMS.has(row.state)) return { label: STATE_LABELS[row.state], text: row.reason ?? "" };
    return undefined;
  }

  // 1. This conversation (A1 rows, unchanged behaviour).
  function renderConversationRow(row, conversationId, disabled) {
    const item = element("div", "plugin-item");
    const rowLabel = element("label", "plugin-row");
    const input = element("input");
    input.type = "checkbox";
    input.id = `plugin-toggle-${row.id}`;
    const waiting = pending.get(row.id);
    const optimistic = waiting?.conversationId === conversationId ? waiting.enabled : undefined;
    // Essential rows only land here without a Built-in group: fixed, checked, disabled.
    input.checked = row.essential ? true : row.toggle && (optimistic ?? row.enabled);
    input.disabled = disabled || row.essential === true || !row.toggle || waiting !== undefined;
    input.addEventListener("change", () => { void toggle(row.id, input.checked); });
    const count = row.tools?.length ?? 0, sections = row.sections?.length ?? 0, skills = row.skills?.length ?? 0;
    const meta = row.essential ? "built-in" : !row.toggle ? label(row.state).toLowerCase()
      : !count && sections ? plural(sections, "prompt section", "prompt sections")
      : !count && skills ? plural(skills, "skill", "skills") : plural(count, "tool", "tools");
    rowLabel.append(input, element("span", "plugin-name", row.name || row.id), element("span", "plugin-meta", meta));
    item.append(rowLabel);
    const issue = problem(row);
    if (issue) item.append(reasonLine(issue.label, issue.text));
    return item;
  }

  // Contribution summary of one runtime record: tools, prompt sections, skills, labelled kinds, other kinds, failures.
  function contributed(record, labels) {
    const tools = [], sections = [], skills = [], other = [], failures = [];
    const labelled = new Map(LABELLED.map((kind) => [kind, []]));
    for (const entry of record?.contributions ?? []) {
      const kind = LABELLED.find((item) => item.kind === entry.kind);
      if (entry.kind === AGENT_EXTENSIONS) {
        if (entry.state === "failed") failures.push(entry.reason ?? "Agent tools were refused");
        else { tools.push(...entry.tools ?? []); sections.push(...entry.sections ?? []); }
      } else if (entry.kind === AGENT_SKILLS) {
        if (entry.state === "failed") failures.push(`skill ${entry.name ?? entry.key}: ${entry.reason ?? "refused"}`);
        else skills.push(entry.name ?? entry.key);
      } else if (kind) labelled.get(kind).push(labels.get(kind.kind)?.get(entry.key) ?? entry.key);
      else if (entry.kind === "styles") continue; // a plugin's own stylesheet (T2) is not a feature worth a line
      else if (entry.kind === "agent.providers") other.push(`model provider: ${entry.key}`);
      else other.push(`${entry.kind} ${entry.key}`);
    }
    return { tools, sections, skills, labelled, other, failures };
  }
  function detailParts(stateText, record, summary) {
    const parts = stateText ? [stateText] : [];
    if (summary.tools.length) parts.push(`${summary.tools.length === 1 ? "tool" : "tools"}: ${summary.tools.join(", ")}`);
    if (summary.sections.length) parts.push(`${summary.sections.length === 1 ? "prompt section" : "prompt sections"}: ${summary.sections.join(", ")}`);
    if (summary.skills.length) parts.push(`${summary.skills.length === 1 ? "skill" : "skills"}: ${summary.skills.join(", ")}`);
    for (const [kind, items] of summary.labelled) if (items.length) parts.push(`${items.length === 1 ? kind.one : kind.many}: ${items.join(", ")}`);
    parts.push(...summary.other);
    if (record?.provides?.length) parts.push(`provides ${record.provides.map(contract).join(", ")}`);
    if (record?.requires?.length) parts.push(`needs ${record.requires.map(contract).join(", ")}`);
    return parts;
  }
  // kind -> (contribution key -> label), for the labelled kinds.
  function contributionLabels() {
    const labels = new Map();
    for (const kind of LABELLED) {
      const byKey = new Map();
      try { for (const entry of runtime?.contributions?.(kind.kind) ?? []) if (entry.value?.label) byKey.set(entry.key, entry.value.label); }
      catch { /* labels are cosmetic */ }
      labels.set(kind.kind, byKey);
    }
    return labels;
  }
  function installedIds() {
    return new Set([...(inventory ?? []).map((item) => item.id), ...bootInventory.map((item) => item.id)]);
  }

  // 2. Built-in: runtime records that are not installed packages.
  function builtinRows(sessionRows) {
    if (!runtime) {
      // Before (or without) composition: only what the session knows (failed essentials).
      return sessionRows.filter((row) => row.essential).map((row) => ({
        id: row.id, name: builtinName(row.id), state: row.errors?.length ? "failed" : row.state,
        reason: row.errors?.length ? row.errors.join(" · ") : row.reason, ...(row.fallback ? { fallback: row.fallback } : {}), details: []
      }));
    }
    const external = installedIds();
    const labels = contributionLabels();
    const errorsById = new Map(sessionRows.filter((row) => row.essential && row.errors?.length).map((row) => [row.id, row.errors]));
    let fallbacks = new Map();
    try { fallbacks = new Map((agentExtensions?.list?.().fallbacks ?? []).map((item) => [item.pluginId, item.reason])); }
    catch { /* diagnostics only */ }
    try { for (const item of agentProviders?.list?.().fallbacks ?? []) if (!fallbacks.has(item.pluginId)) fallbacks.set(item.pluginId, item.reason); }
    catch { /* diagnostics only */ }
    return runtime.list().filter((record) => !external.has(record.id)).map((record) => {
      const summary = contributed(record, labels);
      const failures = [...summary.failures, ...errorsById.get(record.id) ?? []].filter((text, index, all) => all.indexOf(text) === index);
      const labelled = labelledById(record.id);
      const ownLabel = labelled ? labels.get(labelled.kind)?.get(record.id.slice(labelled.prefix.length)) : undefined;
      const active = record.state === "active";
      return {
        id: record.id, name: builtinName(record.id, ownLabel), state: record.state,
        ...(record.reason ? { reason: record.reason } : {}),
        ...(active && failures.length ? { partly: failures.join(" · ") } : {}),
        ...(fallbacks.get(record.id) ? { fallback: fallbacks.get(record.id) } : {}),
        details: detailParts(active ? "Active" : "", record, summary)
      };
    });
  }
  const notActive = (row) => row.state !== "active" || Boolean(row.partly) || Boolean(row.fallback);
  // One collapsed row per bundle; expanded by default while a member is not active.
  function renderBundle({ bundle, rows: members }) {
    const troubled = members.filter(notActive).length;
    const details = element("details", "plugin-bundle");
    details.id = `plugin-bundle-${bundle.id}`;
    const automatic = troubled > 0;
    details.open = bundleChoice.get(bundle.id) ?? automatic;
    details.addEventListener("toggle", () => {
      if (details.open === automatic) bundleChoice.delete(bundle.id);
      else bundleChoice.set(bundle.id, details.open);
    });
    const summary = element("summary", "plugin-row plugin-bundle-summary");
    summary.id = `plugin-bundle-${bundle.id}-summary`;
    summary.append(element("span", "plugin-name", bundle.label), element("span", "plugin-meta", bundleSummary(members.length, troubled)));
    const body = element("div", "plugin-list plugin-bundle-list");
    body.id = `plugin-bundle-${bundle.id}-list`;
    body.setAttribute("role", "group");
    body.setAttribute("aria-label", `Plugins in ${bundle.label}`);
    body.replaceChildren(...members.map(renderBuiltinRow));
    details.append(summary, body);
    return details;
  }
  function renderReload(show) {
    let box = $("plugin-reload");
    if (!show) { if (box) box.hidden = true; return; }
    if (!box) {
      box = element("div", "plugin-actions plugin-reload");
      box.id = "plugin-reload";
      box.append(button("plugin-reload-now", "Reload now", "Reload the app now to apply plugin changes", () => { void reloadPage(); }, false));
      section.append(box);
    }
    box.hidden = false;
    const control = $("plugin-reload-now");
    if (control) control.disabled = reloading || locked();
  }
  async function reloadPage() {
    if (!reloadNow || reloading || locked()) return;
    reloading = true;
    reloadError = "";
    render();
    try { await reloadNow(); }
    catch (cause) { reloadError = `Could not reload: ${message(cause)}`; }
    finally { reloading = false; render(); }
  }
  function renderBuiltinRow(row) {
    const item = element("div", "plugin-item");
    const head = element("div", "plugin-row");
    head.append(element("span", "plugin-name", row.name), element("span", "plugin-meta", "built-in"));
    item.append(head);
    if (row.details.length) item.append(element("p", "plugin-detail", row.details.join(" · ")));
    // The session keeps working on the bundled copy; say so instead of a bare state.
    if (row.fallback) item.append(reasonLine("Failed", `${row.fallback} (using built-in copy)`));
    else if (row.state !== "active") item.append(reasonLine(label(row.state), row.reason));
    else if (row.partly) item.append(reasonLine("Partly failed", row.partly));
    return item;
  }

  // 3. Installed packages (host inventory + this page's runtime state).
  function installedRows() {
    if (!inventory) return [];
    const byId = new Map((runtime?.list() ?? []).map((record) => [record.id, record]));
    const boot = new Map(bootInventory.map((item) => [item.id, item]));
    const labels = contributionLabels();
    return inventory.map((item) => {
      const record = byId.get(item.id);
      const loaded = boot.get(item.id);
      let state, reason;
      if (item.enabled === false) { state = "disabled"; reason = item.reason; }
      else if (PROBLEMS.has(item.state)) { state = item.state; reason = item.reason; }
      else if (record && record.state !== "active") { state = record.state; reason = record.reason; }
      else if (!record && loaded?.state === "failed") { state = "failed"; reason = loaded.reason; }
      // Enabled or installed after this page composed: its web facet is not loaded yet.
      else if (!record && item.web) { state = "installed"; reason = "Loads after the app reloads"; }
      else { state = record ? "active" : item.state ?? "unknown"; reason = item.reason; }
      const summary = contributed(state === "active" ? record : undefined, labels);
      const rollback = !("hasPrevious" in item) && !("previous" in item) ? true : item.hasPrevious === true || (typeof item.previous === "string" && item.previous !== "");
      return {
        id: item.id, name: typeof item.name === "string" && item.name ? item.name.slice(0, 80) : item.id,
        version: item.version ?? "", hash: typeof item.hash === "string" ? item.hash.slice(0, 8) : "",
        enabled: item.enabled !== false, state, ...(reason ? { reason } : {}), rollback, web: Boolean(item.web),
        ...(state === "active" && summary.failures.length ? { partly: summary.failures.join(" · ") } : {}),
        details: detailParts(state === "active" ? "Active" : "", item, summary)
      };
    });
  }
  function button(id, text, aria, onClick, disabled) {
    const node = element("button", "quiet-button", text);
    node.type = "button";
    node.id = id;
    node.setAttribute("aria-label", aria);
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }
  function renderInstalledRow(row, disabled) {
    const item = element("div", "plugin-item");
    const head = element("div", "plugin-row");
    const meta = element("span", "plugin-meta", row.version);
    if (row.hash) meta.append(" ", element("code", "plugin-hash", row.hash));
    head.append(element("span", "plugin-name", row.name), meta);
    item.append(head);
    if (row.details.length) item.append(element("p", "plugin-detail", row.details.join(" · ")));
    if (row.state !== "active") item.append(reasonLine(label(row.state), row.reason));
    else if (row.partly) item.append(reasonLine("Partly failed", row.partly));
    const actions = element("div", "plugin-actions");
    const blocked = disabled || busy !== null || (confirming !== null && confirming.id !== row.id);
    if (confirming?.id === row.id) {
      item.append(reasonLine("Pending work", confirming.text, "alert"));
      actions.append(
        button(`plugin-confirm-${row.id}`, "Disable anyway", `Disable ${row.name} anyway`, () => { confirming = null; void mutate(row, "disable"); }, disabled || busy !== null),
        button(`plugin-cancel-${row.id}`, "Cancel", `Keep ${row.name} enabled`, () => { confirming = null; actionText = ""; render(); }, false)
      );
    } else {
      actions.append(row.enabled
        ? button(`plugin-disable-${row.id}`, "Disable", `Disable ${row.name}`, () => { void disable(row); }, blocked)
        : button(`plugin-enable-${row.id}`, "Enable", `Enable ${row.name}`, () => { void mutate(row, "enable"); }, blocked));
      if (row.rollback) actions.append(button(`plugin-rollback-${row.id}`, "Roll back", `Roll back ${row.name} to its previous revision`, () => { void mutate(row, "rollback"); }, blocked));
    }
    item.append(actions);
    return item;
  }

  function render() {
    const session = getSession?.();
    const snapshot = session?.snapshot;
    const conversationId = snapshot?.conversation?.id;
    const sessionRows = session?.plugins?.() ?? [];
    const owned = Boolean(snapshot?.owned);
    const disabled = !session || owned || locked();
    const status = agentExtensions?.status?.() ?? {};
    const builtins = groups.builtinList ? builtinRows(sessionRows) : [];
    const installed = groups.installedList ? installedRows() : [];
    const showInstalled = Boolean(groups.installedList) && capable && (inventory !== null || inventoryError !== "");
    const listedHere = showInstalled ? new Set(installed.map((row) => row.id)) : new Set();
    // Essential rows live in Built-in when that group exists; failed packages without
    // tools live in Installed when it is shown.
    const rows = sessionRows.filter((row) => !(row.essential && groups.builtinList) && !(row.toggle !== true && listedHere.has(row.id)));
    const waitingForReload = (() => { try { return (runtime?.list?.() ?? []).filter((record) => record?.reloadPending === true).map((record) => record.id); } catch { return []; } })();
    const text = [owned && rows.some((row) => row.toggle) ? "Subagents use their owner's plugins."
      : status.unavailable ? "Plugins could not be loaded."
      : status.late ? "Plugins are still loading." : "",
      waitingForReload.length ? `Applies after the app reloads: ${waitingForReload.join(", ")}.` : ""].filter(Boolean).join(" ");
    const actionsLocked = locked();
    const showReload = Boolean(reloadNow) && (reloading || reloadPending({ runtime, installedRows: installed, actionReload }));
    const next = JSON.stringify([conversationId, disabled, actionsLocked, text, rows, [...pending], builtins, installed, showInstalled, inventoryError, busy, confirming, actionText, showReload, reloading, reloadError]);
    if (next === signature) return;
    signature = next;
    const focused = document.activeElement?.id;
    list.replaceChildren(...rows.map((row) => renderConversationRow(row, conversationId, disabled)));
    if (groups.conversation) groups.conversation.hidden = !rows.length;
    if (groups.builtinList) {
      groups.builtinList.replaceChildren(...groupByBundle(builtins).map((entry) => entry.bundle ? renderBundle(entry) : renderBuiltinRow(entry.row)));
      if (groups.builtin) groups.builtin.hidden = !builtins.length;
      const troubled = builtins.filter(notActive).length;
      if (groups.builtinCount) groups.builtinCount.textContent = troubled ? `${builtins.length} · ${troubled} not active` : String(builtins.length);
    }
    if (groups.installedList) {
      const children = installed.map((row) => renderInstalledRow(row, actionsLocked));
      if (inventoryError) children.push(reasonLine("Unavailable", inventoryError, "alert"));
      else if (showInstalled && !installed.length) children.push(element("p", "plugin-detail", "None installed."));
      groups.installedList.replaceChildren(...children);
      if (groups.installed) groups.installed.hidden = !showInstalled;
    }
    section.hidden = !rows.length && !builtins.length && !showInstalled && !text && !actionText && !showReload && !reloadError;
    if (note) note.textContent = [actionText, reloadError, text].filter(Boolean).join(" ");
    renderReload(showReload);
    if (focused?.startsWith("plugin-")) $(focused)?.focus?.();
  }
  function update() { render(); }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }

  async function toggle(pluginId, enabled) {
    if (getSession()?.plugins?.().some((row) => row.id === pluginId && row.essential)) return;
    const session = getSession();
    const conversationId = session?.snapshot?.conversation?.id;
    if (!session || conversationId === undefined || pending.has(pluginId)) return;
    pending.set(pluginId, { conversationId, enabled });
    render();
    try {
      await session.setPluginEnabled(pluginId, enabled, conversationId);
    } catch (cause) {
      showError(cause);
    } finally {
      pending.delete(pluginId);
      render();
    }
  }

  // Host inventory. A read is safe to repeat; overlapping requests coalesce.
  function refresh() {
    if (!bridge || !capable) return Promise.resolve();
    if (reading) { readAgain = true; return reading; }
    reading = (async () => {
      do {
        readAgain = false;
        try {
          const response = await bridge.call("plugins.list", {});
          if (response?.api !== 1 || !Array.isArray(response.plugins)) throw new Error(`Unsupported plugins.list response (api ${response?.api})`);
          inventory = response.plugins.filter((item) => typeof item?.id === "string" && item.id);
          inventoryError = "";
        } catch (cause) {
          inventoryError = `Installed plugins could not be listed: ${message(cause)}`;
        }
        render();
      } while (readAgain);
    })().finally(() => { reading = null; });
    return reading;
  }

  // The plugin's contributed (non-essential) extension names on this page.
  function extensionNames(pluginId) {
    try { return [...new Set((agentExtensions?.list?.().accepted ?? []).filter((item) => item.pluginId === pluginId && !item.essential).map((item) => item.name))]; }
    catch { return []; }
  }
  async function pendingWork(pluginId) {
    const names = extensionNames(pluginId);
    if (!names.length) return { tasks: 0, conversations: [] }; // no durable agent work can wait for it
    const session = getSession?.();
    if (typeof session?.pendingWorkFor !== "function") return { error: "no conversation is open" };
    try { return await session.pendingWorkFor(names); }
    catch (cause) { return { error: message(cause) }; }
  }
  async function disable(row) {
    if (busy || locked()) return;
    busy = { id: row.id, action: "check" };
    actionText = "";
    render();
    const work = await pendingWork(row.id);
    busy = null;
    const warning = pendingWarning(row.name, work);
    if (warning) {
      confirming = { id: row.id, text: warning };
      render();
      $(`plugin-cancel-${row.id}`)?.focus?.();
      return;
    }
    await mutate(row, "disable");
  }
  const DONE = { disable: "disabled", enable: "enabled", rollback: "rolled back" };
  const VERB = { disable: "disable", enable: "enable", rollback: "roll back" };
  async function mutate(row, action) {
    if (busy || locked() || !bridge) return;
    busy = { id: row.id, action };
    confirming = null;
    actionText = "";
    render();
    try {
      // Exactly one call; an unknown outcome is shown, never replayed.
      const result = await bridge.call(`plugins.${action}`, { id: row.id });
      const revision = action === "rollback" && typeof result?.hash === "string" ? ` to ${result.hash.slice(0, 8)}` : "";
      const when = result?.restartRequired === true ? "Takes effect after the app restarts." : "Takes effect after the app reloads.";
      if (result?.restartRequired !== true) actionReload = true;
      actionText = `${row.name} ${DONE[action]}${revision}. ${when}`;
    } catch (cause) {
      actionText = `Could not ${VERB[action]} ${row.name}: ${message(cause)}`;
    } finally {
      busy = null;
    }
    render();
    await refresh();
  }

  /**
   * Called by app.js once the page composition settled (or failed):
   * runtime (may be absent), installed = plugin-bootstrap's {available, plugins},
   * bridge + hostInfo for the host inventory (only with capability "plugins").
   */
  function connect({ runtime: nextRuntime, installed, bridge: nextBridge, hostInfo, reloadNow: nextReloadNow } = {}) {
    unsubscribeRuntime();
    if (typeof nextReloadNow === "function") reloadNow = nextReloadNow;
    runtime = nextRuntime && typeof nextRuntime.list === "function" ? nextRuntime : null;
    unsubscribeRuntime = runtime?.subscribe?.(schedule) ?? (() => {});
    bootInventory = Array.isArray(installed?.plugins) ? installed.plugins.filter((item) => typeof item?.id === "string") : [];
    bridge = nextBridge && typeof nextBridge.call === "function" ? nextBridge : null;
    capable = Boolean(bridge) && hostInfo?.capabilities?.plugins === true;
    render();
    return refresh();
  }

  agentExtensions?.subscribe?.(update);
  agentProviders?.subscribe?.(update);
  // Re-read the inventory whenever Settings or this section opens.
  $("chat-settings")?.addEventListener?.("click", () => { void refresh(); });
  section.addEventListener?.("toggle", () => { if (section.open) void refresh(); });
  render();
  return { update, connect, refresh };
}
