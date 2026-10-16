// The chat owner alone observes #mode / #prompt. The agent warming policy gets
// explicit provider metadata + activity events, never scrapes another owner's DOM.
// Delegation survives an edited page replacing either element. No message text is read.
export function createBrowserActivity({ document, getMetadata = () => undefined } = {}) {
  const listeners = new Set();
  let closed = false, metadata = getMetadata;
  const emit = type => { if (!closed) for (const listener of [...listeners]) listener({ type }); };
  const change = event => { if (event.target?.id === "mode") emit("provider"); };
  const activity = event => { if (event.target?.id === "prompt") emit("activity"); };
  document?.addEventListener("change", change);
  document?.addEventListener("focusin", activity);
  document?.addEventListener("input", activity);
  return Object.freeze({
    getProvider() {
      const mode = document?.getElementById("mode")?.value;
      return { ...metadata(mode), id: mode };
    },
    setMetadata(resolver) { metadata = resolver; emit("provider"); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      closed = true; listeners.clear();
      document?.removeEventListener("change", change);
      document?.removeEventListener("focusin", activity);
      document?.removeEventListener("input", activity);
    }
  });
}
