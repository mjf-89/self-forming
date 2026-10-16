// Guard for docs/host-ownership.md: every host file is listed, nothing stale, every native-host.js importer listed,
// and every import from apps/common into plugins/*/web is a listed bundled fallback for a named service (X3b).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "docs/host-ownership.md"), "utf8");
const body = doc.slice(doc.indexOf("## Ownership list"));
const [main, rest = ""] = body.split(/^### native-host\.js importers.*$/m);
const [importersPart, fallbackPart = ""] = rest.split(/^### bundled-fallback imports.*$/m);
const entries = (text) => {
  const out = [];
  for (const m of text.matchAll(/^- `([^`]+)` — (.+)$/gm)) {
    assert.match(m[2], /^host: .+/, `${m[1]}: line must start with "host: <reason>"`);
    const p = m[2].match(/\| pending: (\S+) → (\S+)$/);
    if (m[2].includes("| pending:")) assert.ok(p, `${m[1]}: pending must read "pending: <step> → <plugin>"`);
    out.push(m[1]);
  }
  return out;
};
const listed = entries(main);
const importers = entries(importersPart);

const walk = (dir, keep) => {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
};
const hostFiles = [
  ...readdirSync(join(root, "apps/common")).filter((n) => n.endsWith(".js")).map((n) => `apps/common/${n}`),
  ...walk("apps/android/app/src/main/java", (p) => p.endsWith(".kt")),
];
const importRe = /(?:from\s*|import\s*\(\s*|import\s+)["'][^"']*native-host\.js["']/;
const found = [
  ...hostFiles.filter((f) => f.endsWith(".js")),
  ...readdirSync(join(root, "plugins")).flatMap((id) => existsSync(join(root, "plugins", id, "web")) ? walk(`plugins/${id}/web`, (p) => p.endsWith(".js")) : []),
].filter((f) => importRe.test(readFileSync(join(root, f), "utf8")));

// Bundled-fallback imports: "- `apps/common/<file>` → `plugins/<id>/web/<path>` — falls back for: <service>@<n> (<id>)"
// or "... — falls back for: <kind> contribution (<id>)". The generated registry builtin-plugins.js is exempt
// (it imports only the plugins' web entries, which is how built-ins are registered at all).
const fallbacks = [...fallbackPart.matchAll(/^- `([^`]+)` → `([^`]+)` — falls back for: (.+)$/gm)].map((m) => ({ from: m[1], to: m[2], service: m[3] }));
const pluginImportRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']\.\/builtin\/([^/"']+)\/web\/([^"']+)["']/g;
const pluginImports = hostFiles.filter((f) => f.startsWith("apps/common/") && f !== "apps/common/builtin-plugins.js").flatMap((f) =>
  [...readFileSync(join(root, f), "utf8").matchAll(pluginImportRe)].map((m) => `${f} → plugins/${m[1]}/web/${m[2]}`));

test("every host file is in the ownership list", () => {
  assert.deepEqual(hostFiles.filter((f) => !listed.includes(f)), []);
});
test("every listed file still exists", () => {
  assert.deepEqual([...listed, ...importers].filter((f) => !existsSync(join(root, f))), []);
});
test("every native-host.js importer is listed under importers", () => {
  assert.deepEqual([...new Set(found)].filter((f) => !importers.includes(f)), []);
});
test("every apps/common import of plugin code is a listed bundled fallback, and the list is current", () => {
  const listedImports = fallbacks.map(({ from, to }) => `${from} → ${to}`);
  assert.deepEqual([...new Set(pluginImports)].filter((i) => !listedImports.includes(i)), [], "unlisted import of plugin code from apps/common");
  assert.deepEqual(listedImports.filter((i) => !pluginImports.includes(i)), [], "stale bundled-fallback entry");
  assert.ok(fallbacks.length > 0);
});
test("each bundled fallback names a service or contribution of the plugin that owns the file", () => {
  for (const { from, to, service } of fallbacks) {
    const owner = to.match(/^plugins\/([^/]+)\/web\//)?.[1];
    assert.ok(owner && existsSync(join(root, to)), `${to}: not a plugin web file`);
    const svc = service.match(/^(\S+)@(\d+) \((\S+)\)$/);
    const kind = service.match(/^(\S+) contribution \((\S+)\)$/);
    assert.ok(svc || kind, `${from} → ${to}: "falls back for" must read "<service>@<n> (<plugin>)" or "<kind> contribution (<plugin>)"`);
    assert.equal((svc ?? kind).at(-1), owner, `${from} → ${to}: the service must be the owning plugin's`);
    if (svc) {
      const manifest = JSON.parse(readFileSync(join(root, "plugins", owner, "plugin.json"), "utf8"));
      assert.ok(manifest.provides.some((p) => p.id === svc[1] && p.version === Number(svc[2])), `${owner} does not provide ${svc[1]}@${svc[2]}`);
    }
  }
});
test("browser fixed JS inventory and B6 ownership contracts", () => {
  const files = readdirSync(join(root, "apps/browser")).filter(n => n.endsWith(".js")).map(n => `apps/browser/${n}`).sort();
  assert.deepEqual(files, ["apps/browser/browser-app-state.js", "apps/browser/browser-host.js", "apps/browser/browser-main.js", "apps/browser/browser-network.js", "apps/browser/browser-probation.js", "apps/browser/browser-recovery-ui.js", "apps/browser/browser-recovery.js", "apps/browser/browser-revisions.js", "apps/browser/browser-splash.js", "apps/browser/browser-tab-lock.js", "apps/browser/sw.js"].sort());
  const inventory = doc.split("## Browser host ownership inventory")[1]?.split(/^## /m)[0] ?? "";
  for (const file of files) assert.ok(inventory.includes(`| ${file} |`), `${file}: missing current row`);
  const net = readFileSync(join(root, "apps/browser/browser-network.js"), "utf8");
  assert.ok(net.includes("self-forming.net.route"));
  assert.ok(net.includes("self-forming.browser.network-mode"));
  assert.ok(net.includes("plugins/net-tor"));
  assert.ok(net.includes("plugins/net-tailscale"));
  const worker = readFileSync(join(root, "plugins/exec-js/web/browser/browser-console-worker.js"), "utf8");
  assert.match(worker, /git/);
  assert.doesNotMatch(worker, /(?:from\s*|import\s*\(\s*|import\s+)["'][^"']*(?:core-git|browser-git|isomorphic-git)/);
  const actual = files.flatMap(from => [...readFileSync(join(root, from), "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:\.\.\/\.\.\/(plugins\/[^"']+)|\.\/builtin\/([^"']+))["']/g)].map(m => from + " → " + (m[1] ?? `plugins/${m[2]}`)));
  const ownerSection = doc.split("## Browser explicit owner imports")[1];
  assert.ok(ownerSection, "missing explicit owner import list");
  const rows = [...ownerSection.matchAll(/^- `([^`]+)` → `([^`]+)` — (.+)$/gm)];
  assert.deepEqual(actual.sort(), rows.map(m => m[1] + " → " + m[2]).sort());
  for (const [, from, to, reason] of rows) {
    assert.ok(existsSync(join(root, to)), from + " → " + to);
    assert.match(reason, /^(service|bootstrap|UI adjunct): .+/);
  }
  for (const old of ["browser-git.js", "browser-buffer-global.js", "browser-network-ui.js", "browser-preconnect.js", "browser-snowflake.js", "browser-oauth.js", "browser-vfs.js", "browser-execution.js", "browser-console-worker.js", "browser-v86.js", "browser-v86-worker.js", "browser-linux.js", "browser-linux-worker.js"]) assert.equal(existsSync(join(root, "apps/browser", old)), false, old + ": old host twin");
  assert.doesNotMatch(readFileSync(join(root, "plugins/exec-linux/web/browser/browser-v86-worker.js"), "utf8"), /browser-host|native-host/);
  assert.match(inventory, /same-VFS Git controller/);
});
test("the generated registry imports only plugin web entries", () => {
  const registry = readFileSync(join(root, "apps/common/builtin-plugins.js"), "utf8");
  for (const m of registry.matchAll(pluginImportRe)) assert.equal(m[2], "index.js", `builtin-plugins.js imports ${m[0]}`);
});

// Only immutable serving/installer recovery bootstrap is fixed, not its Settings/tool owner tree.
test("browser installed-plugin boundaries stay exact and cannot fall through to editable resources", async () => {
  const { FIXED } = await import("../apps/browser/browser-revisions.js");
  const owner = "builtin/core-plugin-management/web/";
  for (const name of ["host", "package", "store", "serving"]) assert.equal(FIXED.test(`${owner}browser-plugin-${name}.js`), true);
  for (const name of ["index.js", "plugin-settings.js", "plugin-tool.js", "plugins-panel.js", "providers-settings.js"]) assert.equal(FIXED.test(owner + name), false);
  const sw = readFileSync(join(root, "apps/browser/sw.js"), "utf8");
  assert.ok(sw.indexOf("if (isPluginRequest(") < sw.indexOf('if (request.mode === "navigate")'));
  assert.match(sw, /event\.respondWith\(servePlugin\(request, self\.registration\.scope\)\); return;/);
  const build = readFileSync(join(root, "scripts/build-browser.sh"), "utf8");
  for (const name of ["host", "package", "store", "serving"]) assert.ok(build.includes(`${owner}browser-plugin-${name}.js`));
  assert.ok(build.includes('"builtinIds"'));
  const main = readFileSync(join(root, "apps/browser/browser-main.js"), "utf8");
  assert.match(main, /type: "module"/); assert.match(main, /controllerchange/); assert.match(main, /plugin-serving/);
  assert.doesNotMatch(main, /location\.reload/);
  assert.match(main, /createBrowserPlugins\(\{ vfs, builtinIds: manifest\?\.builtinIds, safe/);
});
