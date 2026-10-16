// core-net-page: a plain provider of net.fetch@1 (step N2 of docs/plugins-ui-editions.md "Network routes as
// plugins"). The value is the WebView's own fetch (subject to the page's CORS rules and CSP, not
// background-safe, no allow-list). It is used only when chosen in Settings → Providers (the plugin runtime's
// general provider selection; core-net-native is the default and the fallback). Not essential, bundle
// self-forming-core; no Kotlin half. createFetch(host) is not offered (the page has only its own fetch).
const NET_SERVICE = "net.fetch";
export const ROUTE_ID = "core-net-page";

const isAvailable = () => typeof globalThis.fetch === "function";
const describe = () => Object.freeze({
  id: ROUTE_ID, label: "Page fetch (WebView)", reaches: "cors", private: false, persistent: false,
  ready: async () => isAvailable(), status: isAvailable() ? "ready" : "unavailable"
});
export const pageFetch = Object.freeze(Object.assign((input, init) => globalThis.fetch(input, init), { describe, available: isAvailable }));

export function create() {
  return {
    name: "Page fetch (WebView)",
    hint: "many APIs block it (CORS)",
    setup(ctx) {
      ctx.provide(NET_SERVICE, 1, pageFetch);
    }
  };
}
