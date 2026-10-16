// apps/common/auth-host.js
// The page's host for the credential controllers (ChatGPT, Claude): {call, fetch}. X4: the
// native fetch is core-net-native's (createFetch of net.fetch@1's bundled copy, passed in by app.js); without
// it (tests, forks) the old createNativeFetch export of native-host.js is the last resort.
// The Claude and ChatGPT sign-in protocols themselves are not here.
async function lastResortFetch(host) {
  return (await import("./native-host.js")).createNativeFetch(host);
}
const lazyFetch = (host) => {
  let pending;
  return async (input, init) => (await (pending ??= lastResortFetch(host)))(input, init);
};
/**
 * Stable page fetch over a live composition, or the owning bundled fetch when composition
 * is missing/failed. A live runtime returning null MUST fail closed rather than use fallback.
 * Getters avoid capturing initial readiness or a composition promise at page startup.
 */
function createSelectedFetch({ runtime, fallback } = {}) {
  return async (input, init) => {
    const composition = runtime?.();
    const records = composition?.list?.() ?? [];
    const resolved = composition?.selection?.resolve("net.fetch", 1);
    const intended = resolved?.choice ?? resolved?.default;
    const failed = records.some(row => row.state === "failed" && (row.essential || row.id === intended));
    const selected = composition && !failed ? composition.service("net.fetch", 1) : fallback?.();
    if (typeof selected !== "function") {
      const status = composition?.selection?.resolve("net.fetch", 1)?.status;
      throw new Error(status ? `Network is unavailable: ${status}` : "Network is unavailable: no ready selected provider");
    }
    return selected(input, init);
  };
}
function createAuthHost(bridge, { createFetch, fetch: selectedFetch } = {}) {
  const makeFetch = createFetch ?? lazyFetch;
  // Browser callers supply the selected-route fetch explicitly. Sending it back through
  // http.* would re-enter the same route adapter (and can recurse after B1 composition).
  if (bridge) return { call: (method, params) => bridge.call(method, params), fetch: selectedFetch ?? makeFetch(bridge) };
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1") throw new Error("Sign-in needs the Android host or the local development app.");
  async function post(path, data, signal) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-self-forming": "1" },
      body: JSON.stringify(data),
      signal,
      credentials: "omit",
      redirect: "error"
    });
  }
  const host = {
    async call(method, params = {}) {
      const response = await post("/__pi/auth", { method, params });
      if (!response.ok) throw new Error(response.status === 404 ? "Start the development app with pnpm dev to enable connections." : "The local connection service could not complete this operation.");
      const reply = await response.json();
      if (!reply.ok) throw new Error(reply.error?.message ?? "The connection failed.");
      return reply.result;
    }
  };
  return { ...host, fetch: makeFetch(host) };
}
export {
  createAuthHost, createSelectedFetch
};
