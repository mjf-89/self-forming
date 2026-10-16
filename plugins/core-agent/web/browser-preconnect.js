// Connection-warming trigger policy, not a transport or provider catalogue.
// Inputs are explicit page/session contracts: selected provider metadata
// {id, preconnectOrigins: [HTTP(S) origin]}, composer/provider activity events,
// page visibility, and the selected net.fetch@1 transport's warming/status facade.
// Module/script/bootstrap networking is deliberately outside this policy.
export const RETYPE_INTERVAL_MS = 20000;

function originsOf(provider) {
  const origins = new Set();
  for (const value of provider?.preconnectOrigins ?? []) {
    try {
      const url = new URL(value);
      // Metadata must contain public origins, not request paths or credentials.
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
          url.search || url.hash || url.pathname !== "/") continue;
      origins.add(url.origin);
    } catch { /* invalid or absent metadata means no speculative request */ }
  }
  return [...origins];
}

export function mountPreconnect({ network, getProvider, subscribeActivity, subscribeVisibility,
  hintBrowser, now = Date.now, intervalMs = RETYPE_INTERVAL_MS } = {}) {
  if (!network?.preconnect || typeof getProvider !== "function") return () => {};
  let closed = false, lastTorState, lastMode;
  const lastWarm = new Map(), hinted = new Set(), cleanups = [];
  const keep = stop => {
    if (typeof stop !== "function") return;
    if (closed) stop(); else cleanups.push(stop);
  };
  const subscribe = (source, listener) => {
    if (!source) return;
    try { void Promise.resolve(source(listener)).then(keep).catch(() => {}); } catch { /* optional event source */ }
  };
  const warm = async (force = false) => {
    if (closed) return;
    let provider, origins;
    try { provider = getProvider(); origins = originsOf(provider); } catch { return; }
    for (const origin of origins) {
      if (closed) return;
      const key = `${provider?.id ?? ""}\0${origin}`;
      const time = now();
      if (!force && lastWarm.has(key) && time - lastWarm.get(key) < intervalMs) continue;
      lastWarm.set(key, time);
      try {
        const result = await network.preconnect(origin);
        // Only the route owner can say that ordinary browser hints apply. Never
        // make a direct connection just because Tor/Tailscale is unavailable.
        if (!closed && result?.route === "direct" && !hinted.has(origin) && hintBrowser) {
          hinted.add(origin);
          keep(hintBrowser(origin));
        }
      } catch { /* best effort; no retry, route change, or fetch fallback */ }
    }
  };
  subscribe(network.subscribe?.bind(network), status => {
    const ready = status?.torState === "ready" && lastTorState !== "ready";
    const changed = status?.mode && status.mode !== lastMode;
    lastTorState = status?.torState;
    lastMode = status?.mode;
    if (ready || changed) void warm(true);
  });
  subscribe(subscribeActivity, event => {
    if (event?.type === "provider") void warm(true);
    else if (event?.type === "activity") void warm();
  });
  subscribe(subscribeVisibility, visible => { if (visible) void warm(true); });
  return () => {
    if (closed) return;
    closed = true;
    for (const stop of cleanups.splice(0).reverse()) stop();
    hinted.clear(); lastWarm.clear();
  };
}
