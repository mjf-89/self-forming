// apps/common/provider-panels.js
// Settings panels of the built-in model providers (step S1a of docs/plugins-ui-editions.md).
// Each panel's markup lives in its plugin folder (plugins/core-providers-<mode>/web/settings-panel.js)
// and is contributed by that plugin as a settings.sections entry {title, slot: "provider", mount}.
// The slot is #provider-panels in the Agent settings (right under "This chat uses"), so a
// panel stays next to #mode instead of becoming a separate section at the end of Settings.
//
// The panel elements are created ONCE per document (same nodes for the bundled copy and
// the plugin), with the IDs and markup index.html used to ship, so app.js keeps its element
// references and listeners (sign-in, key entry, model selects) whatever the composition does:
// - app.js calls mountBundledProviderPanels() before it looks the IDs up: the bundled
//   fallback, so the panels appear even when plugin composition fails or never finishes;
// - the plugin's mount(el) moves the same nodes into its section; its dispose moves them
//   back into the slot. Moving nodes keeps listeners, input values and focus targets.
export const PROVIDER_SLOT = "provider";
export const PROVIDER_PANELS_ID = "provider-panels";

const built = new WeakMap(); // document -> Map(markup -> nodes)

function nodesFor(markup, doc) {
  let perDoc = built.get(doc);
  if (!perDoc) built.set(doc, perDoc = new Map());
  let nodes = perDoc.get(markup);
  if (!nodes) {
    const template = doc.createElement("template");
    template.innerHTML = markup.trim();
    nodes = Object.freeze([...template.content.children]);
    perDoc.set(markup, nodes);
  }
  return nodes;
}

/**
 * A settings.sections value whose nodes are built once per document from markup and live in
 * the slot element #slotId when not mounted (the bundled place). Also used by core-secrets
 * (S1b, slot "secrets"). extra: further frozen fields (e.g. mode).
 */
export function slotPanelSection({ slot, slotId, title, markup, ...extra }) {
  if (typeof slot !== "string" || !slot || typeof slotId !== "string" || !slotId || typeof markup !== "string") throw new TypeError("slotPanelSection needs {slot, slotId, title, markup}");
  return Object.freeze({
    ...extra,
    title: title || slot,
    slot,
    slotId,
    markup,
    nodes: (doc = document) => nodesFor(markup, doc),
    mount(el) {
      const doc = el.ownerDocument ?? document;
      const nodes = nodesFor(markup, doc);
      el.append(...nodes);
      return () => {
        // Back to the bundled place, unless the nodes already moved on (a newer mount).
        const home = doc.getElementById(slotId);
        if (!home) return;
        for (const node of nodes) if (node.parentNode === el) home.append(node);
      };
    }
  });
}

/**
 * Bundled fallback of one slot panel: puts its nodes into #slotId unless already attached.
 * Returns the number of nodes placed.
 */
export function mountBundledPanel(section, doc = document) {
  const home = section && typeof section.nodes === "function" ? doc.getElementById(section.slotId) : null;
  if (!home) return 0;
  let placed = 0;
  for (const node of section.nodes(doc)) {
    if (!node.parentNode || node.parentNode.nodeType === 11) { home.append(node); placed += 1; }
  }
  return placed;
}

/**
 * A provider's settings.sections value. markup: the panel's HTML (top-level elements only,
 * IDs unchanged from index.html). nodes(doc) returns the memoized elements.
 */
export function providerPanelSection({ mode, title, markup }) {
  if (typeof mode !== "string" || !mode || typeof markup !== "string") throw new TypeError("providerPanelSection needs {mode, title, markup}");
  return slotPanelSection({ mode, title: title || mode, slot: PROVIDER_SLOT, slotId: PROVIDER_PANELS_ID, markup });
}

/**
 * Bundled fallback: puts every built-in provider panel (rows with a section) into
 * #provider-panels, unless it is already attached. Returns the number of panels placed.
 */
export function mountBundledProviderPanels({ rows = [], doc = document } = {}) {
  const slot = doc.getElementById(PROVIDER_PANELS_ID);
  if (!slot) return 0;
  let placed = 0;
  for (const row of rows) {
    const section = row?.section;
    if (!section || typeof section.nodes !== "function") continue;
    for (const node of section.nodes(doc)) {
      if (!node.parentNode || node.parentNode.nodeType === 11) { slot.append(node); placed += 1; }
    }
  }
  return placed;
}
