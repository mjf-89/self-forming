// core-plugin-management: Settings → Providers (N1, redesigned: the selector belongs to the plugin runtime, not to one
// provider). One selector for EVERY service that has more than one provider (selection.services(); today only
// net.fetch@1, so the page shows the one "Network provider" row), labelled from each provider's name/hint, plus the
// runtime's status line (selection.resolve().status, role=status: it always says why a fallback happened). The
// choice is the runtime's general provider selection (selection.choose: persisted per service id@version; net.fetch@1
// keeps its key "self-forming.net.route").
// The section's rows are built with the DOM API into the nodes this file owns; nothing is looked up by id in the
// document (the section is mounted into a wrapper that is attached only afterwards). The node is built once per
// document and lives in #providers-panel (empty and hidden: no selector) when not mounted, like the other S1 slot panels.
// Provider options (e.g. a Tailscale exit node, Tor bridges): a provider keeps its OWN settings.sections entry and
// places it in the slot of its service, `provider:<service>@<version>` (providerSlotName("net.fetch", 1) =
// "provider:net.fetch@1"), which sits right under that service's selector row. Only the SELECTED provider's section
// is shown (selected = the select's value: the saved choice or the default); sections of the other providers stay
// mounted but hidden, so switching back keeps their state. A section's wrapper carries data-plugin = its plugin id.
// The slot element exists as soon as it is asked for (settings.js gives it to settings-sections.js as resolveSlot);
// it is on screen only while its service has a selector row (several providers).
import { slotPanelSection } from "../../../provider-panels.js";

export const PROVIDERS_SLOT = "providers";
export const PROVIDERS_PANEL_ID = "providers-panel";
export const NET_SERVICE = "net.fetch";
export const SLOT_PREFIX = "provider:";
export const providerSlotName = (service, version = 1) => `${SLOT_PREFIX}${service}@${version}`;

const slotsByDoc = new WeakMap(); // document -> Map(slot name -> {div, facade, selected, apply})
function slotEntry(doc, name) {
  let perDoc = slotsByDoc.get(doc);
  if (!perDoc) slotsByDoc.set(doc, perDoc = new Map());
  let entry = perDoc.get(name);
  if (!entry) {
    const div = doc.createElement("div");
    div.className = "provider-slot";
    entry = { div, selected: null };
    entry.apply = () => { for (const child of [...div.children]) if (child?.dataset?.plugin !== undefined) child.hidden = child.dataset.plugin !== entry.selected; };
    // What settings-sections.js sees as the host: appending applies the visibility to the new section.
    entry.facade = { append(...nodes) { div.append(...nodes); entry.apply(); }, get children() { return div.children; } };
    perDoc.set(name, entry);
  }
  return entry;
}
/** settings-sections.js resolveSlot: the slot host of a provider's options, or null for any other slot name. */
export const providerSlot = (name, doc = document) => typeof name === "string" && name.startsWith(SLOT_PREFIX) ? slotEntry(doc, name).facade : null;

export const markup = `
<details id="providers-settings" class="native-settings" hidden>
  <summary>Providers</summary>
</details>
`;
export const section = slotPanelSection({ slot: PROVIDERS_SLOT, slotId: PROVIDERS_PANEL_ID, title: "Providers", markup });

const LABELS = Object.freeze({ "net.fetch@1": "Network provider", "look@1": "Look", "execution@1": "Execution environment" });
// Services whose open session is bound to its provider (E1: environment, tools and prompt); core-agent reopens it in place.
const NOTES = Object.freeze({ "execution@1": "Switching reopens the conversation with the new environment as soon as the agent is idle (no page reload). Servers keep running in Linux." });
/** Element IDs of one row: net.fetch@1 keeps `net-route` / `net-route-status`. */
export function rowIds(service, version) {
  if (service === NET_SERVICE && version === 1) return { select: "net-route", status: "net-route-status" };
  const base = `provider-${service}-${version}`.replace(/[^a-z0-9-]+/gi, "-");
  return { select: `${base}-select`, status: `${base}-status` };
}
export const rowLabel = (service, version) => LABELS[`${service}@${version}`] ?? `${service} provider`;
const optionLabel = (p) => `${p.hint ? `${p.name} — ${p.hint}` : p.name}${p.active ? "" : " (not active)"}`;

/**
 * Binds the section's details node to the runtime's selection ({services, providers, resolve, choose}) and subscribe();
 * returns the unbind function (removes the rows again). Switching applies to new requests.
 */
export function bindProvidersPanel({ node, selection, subscribe, doc = node?.ownerDocument ?? document } = {}) {
  if (!node || typeof selection?.services !== "function") return () => {};
  const rows = new Map(); // "id@version" -> {wrapper, select, line}
  // After unbind, render() must do nothing: a subscribe() that notifies a snapshot of its
  // listeners can still call this render once more, after we unsubscribed (the browser's
  // fallback -> composed hand-over unbinds during such a notification). It used to rebuild a
  // second, orphaned set of rows in the shared node: every provider row showed twice.
  let unbound = false;
  const make = (service, version) => {
    const ids = rowIds(service, version);
    const wrapper = doc.createElement("div");
    const label = doc.createElement("label"), select = doc.createElement("select"), line = doc.createElement("p");
    label.className = "select-label"; label.htmlFor = ids.select;
    label.append(rowLabel(service, version), select);
    select.id = ids.select;
    line.id = ids.status; line.className = "settings-note"; line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite");
    const slot = slotEntry(doc, providerSlotName(service, version));
    wrapper.append(label, line, slot.div);
    select.addEventListener("change", () => { selection.choose(service, version, select.value); render(); });
    return { wrapper, select, line, slot };
  };
  function render() {
    if (unbound) return;
    let services = [];
    try { services = selection.services(); } catch { /* none */ }
    const wanted = new Set(services.map((s) => `${s.id}@${s.version}`));
    for (const [key, row] of [...rows]) if (!wanted.has(key)) { row.wrapper.remove(); rows.delete(key); }
    for (const { id, version } of services) {
      const key = `${id}@${version}`;
      let row = rows.get(key);
      if (!row) { row = make(id, version); rows.set(key, row); }
      const providers = selection.providers(id, version), resolved = selection.resolve(id, version);
      row.select.replaceChildren(...providers.map((p) => {
        const option = doc.createElement("option");
        option.value = p.id; option.textContent = optionLabel(p);
        return option;
      }));
      row.select.value = resolved.choice && providers.some((p) => p.id === resolved.choice) ? resolved.choice : (resolved.default ?? providers[0]?.id ?? "");
      row.select.disabled = providers.length < 2;
      row.line.textContent = NOTES[key] ? `${resolved.status} ${NOTES[key]}` : resolved.status;
      row.slot.selected = row.select.value;
      row.slot.apply();
    }
    for (const { id, version } of services) node.append(rows.get(`${id}@${version}`).wrapper); // keeps the order
    node.hidden = rows.size === 0;
  }
  let off = () => {};
  try { off = subscribe?.(render) ?? off; } catch { /* no live updates */ }
  render();
  return () => {
    unbound = true;
    off();
    for (const row of rows.values()) row.wrapper.remove();
    rows.clear();
    node.hidden = true;
  };
}

/** The section value of core-plugin-management: the shared nodes plus the binding (needs the runtime's selection). */
export function providersSection({ selection, subscribe } = {}) {
  return Object.freeze({
    ...section,
    mount(el, ctx) {
      const dispose = section.mount(el, ctx);
      const node = section.nodes(el.ownerDocument ?? document)[0];
      const unbind = bindProvidersPanel({ node, selection, subscribe, doc: el.ownerDocument ?? document });
      return () => { unbind(); dispose(); };
    }
  });
}
