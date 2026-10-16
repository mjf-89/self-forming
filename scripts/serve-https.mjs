// Static HTTPS server for testing the browser edition from another device (e.g. over Tailscale).
// Serves dist/browser read-only with correct MIME types; no other behaviour, no request logging
// of query strings. Also serves the local test CA certificate at /self-forming-test-ca.crt so a
// device can install and trust it.
// Usage: node scripts/serve-https.mjs --host 100.x.y.z --port 8443 --cert server.crt --key server.key --ca ca.crt [--root dist/browser]
import { createServer } from "node:https";
import { readFileSync, createReadStream, statSync } from "node:fs";
import { resolve, join, extname, sep } from "node:path";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(arg("root", new URL("../dist/browser", import.meta.url).pathname));
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", "8443"));
const caPath = arg("ca");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".map": "application/json",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".br": "application/octet-stream",
};

const server = createServer({ cert: readFileSync(arg("cert")), key: readFileSync(arg("key")) }, (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, "https://x").pathname); } catch { res.writeHead(400).end(); return; }
  if (caPath && path === "/self-forming-test-ca.crt") {
    res.writeHead(200, { "content-type": "application/x-x509-ca-cert", "content-disposition": 'attachment; filename="self-forming-test-ca.crt"' });
    res.end(readFileSync(caPath));
    return;
  }
  if (path.endsWith("/")) path += "index.html";
  const file = resolve(join(root, path));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  let info;
  try { info = statSync(file); } catch { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
  if (!info.isFile()) { res.writeHead(404).end(); return; }
  // Validators so browsers revalidate (304) instead of downloading again.
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const lastModified = new Date(info.mtimeMs).toUTCString();
  if (req.headers["if-none-match"] === etag || (!req.headers["if-none-match"] && req.headers["if-modified-since"] && Date.parse(req.headers["if-modified-since"]) >= Math.floor(info.mtimeMs / 1000) * 1000)) {
    res.writeHead(304, { etag, "last-modified": lastModified, "cache-control": "no-cache" }).end();
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": "no-cache",
    etag,
    "last-modified": lastModified,
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
});
server.listen(port, host, () => console.log(`Serving ${root} on https://${host}:${port}/`));
