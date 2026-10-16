// core-net-native: the native HTTP route and provider of net.fetch@1 (step X4; docs/plugins-providers-agent-core.md
// §B3/§H). native-fetch.js in this folder is packages/native-host/src/fetch.ts (createNativeFetch)
// hand-ported to plain JS. net.fetch@1 is a Fetch-compatible function over the page bridge (native
// HTTPS: CORS-free, background-safe, allow-list) with describe() and createFetch(host) (a fetch
// over another host {call, closed?, onClose?}, e.g. the browser development auth host). N1: this is the DEFAULT
// provider of net.fetch@1 (provides default: true); other network plugins (core-net-page, later net-tor,
// net-tailscale) simply provide net.fetch@1 too, and the plugin runtime's general provider selection
// (plugin-runtime.js) picks per request: the user's choice if active and available, else this one, with a
// visible reason. It has no settings entry: the selector is the plugin runtime's own Settings → Providers section
// (core-plugin-management, providers-settings.js), one row for every service with several providers.
// Fallback: native-fetch.js is imported lazily; if it cannot be loaded the old createNativeFetch
// export of the fixed native-host.js is used (last resort). app.js uses createNet(...) of this
// statically registered module as the page's bundled copy when composition does not give the service.

const NET_SERVICE = "net.fetch";
export const ROUTE_ID = "core-net-native";

let implementation;
/** This plugin's createNativeFetch; native-host.js's export only if native-fetch.js fails to load. */
export function loadNativeFetch({ load, fallback } = {}) {
  if (load || fallback) return resolveNativeFetch(load, fallback);
  if (!implementation) {
    const pending = resolveNativeFetch();
    implementation = pending;
    pending.catch(() => { if (implementation === pending) implementation = void 0; });
  }
  return implementation;
}
function resolveNativeFetch(load = () => import("./native-fetch.js"), fallback = () => import("../../../native-host.js")) {
  return Promise.resolve().then(load).then((module) => {
    if (typeof module?.createNativeFetch !== "function") throw new TypeError("native-fetch.js has no createNativeFetch");
    return module.createNativeFetch;
  }).catch(async (cause) => {
    console.error("core-net-native fetch unavailable: using native-host.js", cause);
    return (await fallback()).createNativeFetch;
  });
}

/** The net.fetch@1 value over the page bridge: fetch(input, init) + describe() + createFetch(host). */
export function createNet({ bridge, loaded = loadNativeFetch, stopped } = {}) {
  const createFetch = (host) => {
    if (stopped?.()) throw new Error("Network adapter is stopped");
    if (!host || typeof host.call !== "function") throw new TypeError("createFetch needs a host with call()");
    return async (input, init) => (await loaded())(host)(input, init);
  };
  const native = bridge ? createFetch(bridge) : undefined;
  const describe = () => Object.freeze({
    id: ROUTE_ID, label: "Native HTTP", reaches: "allow-list", private: false, persistent: true,
    ready: async () => Boolean(bridge) && !bridge.closed, status: bridge && !bridge.closed ? "ready" : "unavailable"
  });
  // Without a bridge there is no native HTTP: no fetch value (callers use the browser's fetch).
  const fetch = native && Object.assign((input, init) => native(input, init), { describe, createFetch });
  return Object.freeze({ fetch, createFetch, describe });
}

export function create({ bridge } = {}) {
  return {
    name: "Native network",
    setup(ctx) {
      const net = createNet({ bridge, stopped: () => ctx.signal.aborted });
      if (!net.fetch) return; // no native host: nothing to provide
      const service = Object.assign((input, init) => {
        if (ctx.signal.aborted) return Promise.reject(new Error("Network adapter is stopped"));
        return net.fetch(input, init);
      }, { describe: net.describe, createFetch: net.createFetch, available: () => Boolean(bridge) && !bridge.closed });
      ctx.provide(NET_SERVICE, 1, Object.freeze(service));
    }
  };
}
