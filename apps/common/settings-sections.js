// apps/common/settings-sections.js
// Consumer of the "settings.sections" contribution kind (step S1 of docs/plugins-ui-editions.md).
// A plugin contributes ctx.contribute("settings.sections", key, {title, order?, mount(el, ctx) -> dispose?}, order).
// Settings renders each contributed section after the static ones, in contribution order, and
// keeps the list live: a section is mounted when its plugin scope opens and disposed and removed
// when the scope closes (or the value changes). mount() may be async; its dispose may be async.
// A section that throws (or rejects) shows a one-line error and never affects Settings or other
// sections. The mount ctx is {id: plugin id, key, title, signal} (signal aborts on removal).
// Slots (S1a): a value with slot: "<name>" naming one of the `slots` given to
// createSettingsSections ({name: element or () => element}) is mounted inside that element
// instead, as a heading-less <div class="settings-slotted"> (display: contents), in order.
// Built-in providers use the "provider" slot (#provider-panels, under #mode). An unknown or
// missing slot falls back to an ordinary section. resolveSlot(name) answers names that are not in `slots` (a host with
// append() and children).
export const SETTINGS_SECTIONS = "settings.sections";
const message = (error) => error instanceof Error ? error.message : String(error);

export function createSettingsSections({ container, slots = {}, resolveSlot, onError = (cause, details) => console.error("Settings section unavailable", details, cause) } = {}) {
  const live = new Map(); // "plugin/key" -> {value, wrapper, controller, dispose, gone, order}
  let runtime = null, unsubscribe = () => {}, busy = false, again = false, closed = false;

  function slotOf(name) {
    if (typeof name !== "string") return null;
    try {
      // resolveSlot(name) -> host or null: slots that are not fixed (e.g. one per provider selector row).
      const found = Object.hasOwn(slots, name) ? (typeof slots[name] === "function" ? slots[name]() : slots[name]) : resolveSlot?.(name);
      return found && typeof found.append === "function" ? found : null;
    } catch { return null; }
  }
  function report(cause, details) { try { onError(cause, details); } catch { /* reporting must not break Settings */ } }
  async function release(item) {
    item.gone = true;
    try { item.controller.abort(); } catch { /* ignore */ }
    try { item.wrapper.remove(); } catch { /* ignore */ }
    const dispose = item.dispose;
    item.dispose = null;
    if (typeof dispose === "function") {
      try { await dispose(); } catch (cause) { report(cause, { phase: "dispose", id: item.id, key: item.key }); }
    }
  }
  function build(entry, id) {
    const value = entry.value;
    if (!value || typeof value !== "object" || typeof value.mount !== "function") throw new TypeError("settings.sections needs {title, mount(el, ctx)}");
    const title = typeof value.title === "string" && value.title ? value.title : entry.key;
    const host = slotOf(value.slot);
    let wrapper, body;
    if (host) {
      wrapper = body = document.createElement("div");
      wrapper.className = "settings-slotted";
      wrapper.dataset.slot = value.slot;
    } else {
      wrapper = document.createElement("section");
      wrapper.className = "settings-section settings-contributed";
      const heading = document.createElement("h3");
      heading.className = "settings-section-title";
      heading.textContent = title;
      body = document.createElement("div");
      body.className = "settings-section-body";
      wrapper.append(heading, body);
    }
    wrapper.dataset.plugin = entry.providerId;
    wrapper.dataset.section = entry.key;
    const item = { id, key: entry.key, value: entry.value, wrapper, host: host ?? container, controller: new AbortController(), dispose: null, gone: false };
    const fail = (cause) => {
      report(cause, { phase: "mount", id: entry.providerId, key: entry.key });
      if (item.gone) return;
      const note = document.createElement("p");
      note.className = "settings-note";
      note.setAttribute("role", "status");
      note.textContent = `This section could not load: ${message(cause)}`;
      try { body.replaceChildren(note); } catch { /* ignore */ }
    };
    const keep = (dispose) => {
      if (typeof dispose !== "function") return;
      if (item.gone) { void Promise.resolve().then(dispose).catch((cause) => report(cause, { phase: "dispose", id: entry.providerId, key: entry.key })); }
      else item.dispose = dispose;
    };
    try {
      const result = value.mount(body, Object.freeze({ id: entry.providerId, key: entry.key, title, signal: item.controller.signal }));
      if (result && typeof result.then === "function") result.then(keep, fail);
      else keep(result);
    } catch (cause) { fail(cause); }
    return item;
  }

  async function refresh() {
    if (closed || !container) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        let entries = [];
        try { entries = runtime ? runtime.contributions(SETTINGS_SECTIONS) : []; } catch (cause) { report(cause, { phase: "list" }); }
        const wanted = new Map(entries.map((entry) => [`${entry.providerId}/${entry.key}`, entry]));
        for (const [name, item] of [...live]) {
          const entry = wanted.get(name);
          if (!entry || entry.value !== item.value) { live.delete(name); await release(item); }
        }
        const ordered = [];
        for (const [name, entry] of wanted) {
          let item = live.get(name);
          if (!item) {
            try { item = build(entry, entry.providerId); }
            catch (cause) { report(cause, { phase: "mount", id: entry.providerId, key: entry.key }); continue; }
            live.set(name, item);
          }
          ordered.push(item);
        }
        // Static sections stay first; contributed ones follow in order (per host: the
        // container or a slot). children is an HTMLCollection in a browser: copy it.
        for (const host of new Set(ordered.map((item) => item.host))) {
          const mine = ordered.filter((item) => item.host === host);
          const current = [...host.children].filter((child) => mine.some((item) => item.wrapper === child));
          if (current.length !== mine.length || current.some((child, index) => child !== mine[index].wrapper)) {
            for (const item of mine) host.append(item.wrapper);
          }
        }
      } while (again && !closed);
    } finally { busy = false; }
  }

  return {
    /** Follows a plugin runtime (contributions(kind) + subscribe). Replaces a previous runtime. */
    connect({ runtime: next } = {}) {
      unsubscribe(); unsubscribe = () => {};
      runtime = next ?? null;
      if (runtime && typeof runtime.subscribe === "function") {
        try { unsubscribe = runtime.subscribe(() => { void refresh(); }); } catch (cause) { report(cause, { phase: "subscribe" }); }
      }
      return refresh();
    },
    refresh,
    /** Disposes every contributed section and stops following the runtime. */
    async dispose() {
      closed = true; unsubscribe(); unsubscribe = () => {};
      const items = [...live.values()]; live.clear();
      for (const item of items) await release(item);
    },
    count: () => live.size
  };
}
