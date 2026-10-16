// Shared browser package integrity contract. No host, VFS or storage dependencies.
export const ID = /^[a-z][a-z0-9-]{1,63}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_FILES = 4096, MAX_BYTES = 64 * 1024 * 1024, MAX_MANIFEST = 1024 * 1024;
export const fail = (message, code = "PLUGIN_INVALID") => { throw Object.assign(new Error(message), { code }); };
export function canonicalPath(path, prefix = "") {
  if (typeof path !== "string" || !path.startsWith(prefix) || !path || /[\\%?#\u0000-\u0020\u007f]/u.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) fail("Noncanonical plugin path");
  try { encodeURIComponent(path); } catch { fail("Plugin path must be valid Unicode"); }
  return path;
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
const encoder = new TextEncoder();
// UTF-8 byte ordering matches LC_ALL=C sort, including non-ASCII filenames.
export function sortedPaths(files) {
  return Object.keys(files).sort((a,b) => {
    const x = encoder.encode(a), y = encoder.encode(b);
    for (let i = 0; i < Math.min(x.length,y.length); i++) if (x[i] !== y[i]) return x[i]-y[i];
    return x.length-y.length;
  });
}
export async function packageHash(files) {
  const records = [];
  for (const path of sortedPaths(files)) records.push(`${path}\0${await sha256(files[path])}\n`);
  return sha256(encoder.encode(records.join("")));
}
export function validatePackage(files, builtinIds = []) {
  const paths = Object.keys(files);
  if (paths.length > MAX_FILES || paths.reduce((n,p) => n + files[p].byteLength, 0) > MAX_BYTES) fail("Plugin exceeds 4096 files / 64 MiB");
  for (const path of paths) {
    canonicalPath(path);
    if (path !== "plugin.json" && !path.startsWith("web/")) fail("Unexpected shipped plugin file");
  }
  if (!files["plugin.json"] || files["plugin.json"].byteLength > MAX_MANIFEST) fail("Missing or oversized plugin.json");
  let m;
  try { m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files["plugin.json"])); } catch { fail("Invalid plugin.json"); }
  if (!m || typeof m !== "object" || Array.isArray(m)) fail("Invalid manifest");
  if (Object.hasOwn(m,"native")) fail("Native plugins need the Android app", "PLUGIN_UNAVAILABLE");
  if (!ID.test(m.id) || typeof m.id !== "string" || m.api !== 1 || !["scope","page","restart"].includes(m.reload)) fail("Invalid M1 id, API or reload policy");
  if (builtinIds.includes(m.id)) fail("Cannot override a built-in plugin ID");
  for (const key of ["name","version"]) if (typeof m[key] !== "string" || m[key].length > 256 || !/\S/u.test(m[key])) fail(`Invalid manifest ${key}`);
  canonicalPath(m.web?.entry, "web/");
  if (!files[m.web.entry]) fail("Missing web entry");
  for (const key of ["provides","requires","uses"]) {
    const contracts = Object.hasOwn(m,key) ? m[key] : [];
    if (!Array.isArray(contracts)) fail(`Invalid ${key}`);
    const seen = new Set();
    for (const c of contracts) {
      if (!c || typeof c.id !== "string" || c.id.length > 256 || !/\S/u.test(c.id) || /[\u0000-\u001f]/u.test(c.id) || !Number.isInteger(c.version) || c.version < 1 || c.version > 2147483647 || seen.has(JSON.stringify([c.id,c.version]))) fail(`Invalid ${key} contract`);
      seen.add(JSON.stringify([c.id,c.version]));
    }
    m[key] = contracts;
  }
  for (const path of paths.filter(p => p.startsWith("web/skills/"))) {
    const parts = path.split("/");
    if (parts.length < 4 || !files[`web/skills/${parts[2]}/SKILL.md`]) fail("Each skill folder needs SKILL.md");
  }
  for (const path of paths.filter(p => /^web\/skills\/[^/]+\/SKILL.md$/.test(p))) {
    const name = path.split("/")[2], text = new TextDecoder().decode(files[path]);
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const value = key => front?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || value("name") !== name || !value("description") || value("description").length > 1024) fail("Invalid plugin skill frontmatter");
  }
  return m;
}
