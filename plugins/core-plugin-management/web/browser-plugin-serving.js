// Service-worker owner adapter: installed namespace is always terminal (never network
// or editable-revision fallback). All published snapshots are retained for old pages.
import { ID, HASH, canonicalPath, packageHash, validatePackage } from "./browser-plugin-package.js";
import { openPluginStore } from "./browser-plugin-store.js";
const TYPES = { js:"text/javascript; charset=utf-8", mjs:"text/javascript; charset=utf-8", css:"text/css; charset=utf-8", html:"text/html; charset=utf-8", json:"application/json", svg:"image/svg+xml", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", ico:"image/x-icon", txt:"text/plain; charset=utf-8", md:"text/markdown; charset=utf-8", wasm:"application/wasm", woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf", otf:"font/otf", pdf:"application/pdf", mp3:"audio/mpeg", mp4:"video/mp4", avif:"image/avif" };
export const assetPrefix = scope => new URL("assets/web/plugins/",scope).pathname;
export function isPluginRequest(url, scope) {
  // Inspect decoded spelling too, so encoded namespace separators cannot bypass the terminal handler.
  const prefix = assetPrefix(scope);
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { return url.pathname.includes("assets"); }
  return url.pathname.startsWith(prefix) || decoded.startsWith(prefix);
}
export async function servePlugin(request, scope, { openStore = () => openPluginStore(globalThis.indexedDB, { probe: false }) } = {}) {
  let store;
  const headers = { "cache-control":"no-store", "x-content-type-options":"nosniff" };
  const missing = status => new Response("Installed plugin resource unavailable",{status,headers});
  try {
    const url = new URL(request.url), prefix = assetPrefix(scope);
    if (request.method !== "GET" && request.method !== "HEAD") return missing(405);
    if (!url.pathname.startsWith(prefix) || url.search || url.hash || /%2f|%5c|%25|\\/i.test(url.pathname)) return missing(400);
    const [id,hash,...parts] = decodeURIComponent(url.pathname.slice(prefix.length)).split("/");
    if (!ID.test(id) || !HASH.test(hash)) return missing(400);
    const path = canonicalPath(parts.join("/"),"web/");
    store = await openStore();
    const snapshot = await store.snapshot(id,hash);
    if (!snapshot || snapshot.hash !== hash) return missing(404);
    const manifest = validatePackage(snapshot.files);
    if (await packageHash(snapshot.files) !== hash) return missing(404);
    if (manifest.id !== id) return missing(404);
    const bytes = snapshot.files[path];
    if (!bytes) return missing(404);
    return new Response(request.method === "HEAD" ? null : bytes, { headers: { ...headers, "content-type": TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream", "content-length": String(bytes.byteLength) } });
  } catch { return missing(404); }
  finally { store?.close(); }
}
