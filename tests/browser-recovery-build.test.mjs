// Browser edition build output: the recovery page is deployed as a FIXED file (never an
// editable revision file), its module imports resolve in the assembled layout, the
// service worker and the host treat it as fixed, and the PWA manifest has the shortcut.
// Build first: scripts/build-browser.sh [dir]; PI_BROWSER_TEST_DIST=file:///abs/dir/ selects another output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const explicit = process.env.PI_BROWSER_TEST_DIST;
if (explicit !== undefined) assert.ok(explicit.startsWith("file:///") && explicit.endsWith("/"), "PI_BROWSER_TEST_DIST must be a file:///.../ URL with a trailing slash");
const dist = new URL(explicit ?? "../dist/browser/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dist), "utf8");
const imports = (text) => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);

function closure(entries) {
  const seen = new Set();
  const visit = (url) => {
    assert.ok(url.href.startsWith(dist.href), `dependency escapes output: ${url}`);
    assert.ok(statSync(url).isFile(), `missing dependency: ${url}`);
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const specifier of imports(readFileSync(url, "utf8"))) visit(new URL(specifier, url));
  };
  for (const url of entries) visit(url);
  return [...seen].map((href) => href.slice(dist.href.length));
}

test("recovery.html is deployed, fixed and not an editable app file", () => {
  assert.ok(statSync(new URL("recovery.html", dist)).isFile(), "recovery.html missing: rebuild with scripts/build-browser.sh");
  const manifest = JSON.parse(read("app-manifest.json"));
  for (const name of ["recovery.html", "browser-recovery.js", "browser-recovery-ui.js", "browser-app-state.js", "browser-probation.js"]) {
    assert.ok(!manifest.editableFiles.includes(name), `${name} must not be editable`);
  }
  // Both the host and the service worker keep it out of revisions.
  assert.match(read("browser-app-state.js"), /recovery\\\.html\$/);
  assert.match(read("sw.js"), /recovery\\\.html\$/);
  assert.match(read("sw.js"), /searchParams\.has\("recovery"\)/);
});

test("recovery page module closure resolves to fixed files only (no app module)", async () => {
  const page = new URL("recovery.html", dist);
  const html = read("recovery.html");
  assert.doesNotMatch(html, /https?:\/\//, "no external assets");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const entries = scripts.flatMap((s) => imports(s)).map((s) => new URL(s, page));
  assert.deepEqual(entries.map((u) => u.href.slice(dist.href.length)), ["browser-recovery.js"]);
  const files = closure(entries);
  const { FIXED } = await import(new URL("browser-app-state.js", dist));
  for (const name of files) assert.ok(FIXED.test(name), `${name} is not a fixed file`);
  assert.ok(files.includes("builtin/core-plugin-management/web/browser-plugin-store.js"));
  for (const name of files) assert.doesNotMatch(name, /^(?:app|session|plugin-runtime)\.js$/);
});

test("browser-main's recovery modules resolve; the service worker's imports resolve", () => {
  const direct = imports(read("browser-main.js"));
  for (const name of ["./browser-recovery-ui.js", "./browser-revisions.js"]) assert.ok(direct.includes(name), name);
  const files = closure(["browser-recovery-ui.js", "browser-revisions.js", "sw.js"].map((name) => new URL(name, dist)));
  for (const name of ["browser-app-state.js", "browser-probation.js", "builtin/core-plugin-management/web/browser-plugin-serving.js"]) assert.ok(files.includes(name), name);
});

test("PWA manifest offers a Recovery shortcut", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  const shortcut = manifest.shortcuts?.find((s) => s.name === "Recovery");
  assert.ok(shortcut);
  assert.equal(new URL(shortcut.url, "https://h/app/manifest.webmanifest").href, "https://h/app/recovery.html");
});
