// Read-only workspace copies of the Agent Skills that ACTIVE installed plugins ship
// (docs/plugins.md §9a, A3b). A skill is a folder with SKILL.md (YAML frontmatter
// name + description) and optional scripts/, references/, assets/. Plugins ship it
// at web/skills/<name>/ inside the package: web/** is what both scripts/plugin.sh
// and the Android host hash, snapshot and serve (PluginHost.kt PluginFiles,
// openAsset), so a skill is part of the plugin's immutable revision.
// The installed snapshot is outside the workspace and not visible to the agent's
// file tools or its Linux shell, so the page copies each skill of the selected
// revision to <workspace>/.skills/<pluginId>/<skillName>/, refreshes it when the
// revision changes, removes copies of plugins that are no longer active and marks
// the copies read-only (chmod a-w through the execution environment; best effort:
// it is not a protection against the agent or other same-UID code).
//
// Reading the snapshot is a seam (source.read). servedSkillSource() uses the host
// bridge method plugins.read (Android 0.6.0+, capability pluginRead; the reader is
// set up by plugin-client.js loadInstalledPlugins) for the selected or page-pinned
// revision. Without it, it falls back to fetching the served URL
// /assets/web/plugins/<id>/<hash>/web/skills/<name>/<file>, which the 0.5.x Android
// page CSP refuses (no connect-src for the app's own origin). A contribution may
// instead carry the files inline ({contents: {path: text}}), which works on every host.
// No library import; exec/writeFile/readTextFile are the execution environment's API.
import { pluginFiles } from "./plugin-client.js";
export const SKILLS_DIRECTORY = ".skills";
const STAMP = ".revision.json";
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const message = (error) => error instanceof Error ? error.message : String(error);
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
// One mirror operation at a time per page, also across sessions (an old session may
// still be syncing while the next one opens).
let queue = Promise.resolve();

/** True for a canonical relative path inside a skill folder (no "..", no absolute path). */
export function skillFilePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
}

/**
 * Minimal Agent Skills frontmatter reader: the block between the first two "---"
 * lines, simple `key: value` pairs (quotes removed). Returns {name, description} or
 * throws with a reason. Nested YAML is ignored, as is everything after the block.
 */
export function skillFrontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("SKILL.md must start with YAML frontmatter (---)");
  const end = lines.indexOf("---", 1);
  const close = end > 0 ? end : lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0) throw new Error("SKILL.md frontmatter is not closed with ---");
  const fields = {};
  for (const line of lines.slice(1, close)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[match[1]] = value;
  }
  if (!fields.name) throw new Error("SKILL.md frontmatter has no name");
  if (!fields.description) throw new Error("SKILL.md frontmatter has no description");
  return { name: fields.name, description: fields.description };
}

/**
 * Production source: the installed snapshot. files = {read(id, hash, path) → bytes}
 * (default: the page's plugins.read reader, when the host has one); an explicit fetch
 * selects the served URL instead (see the CSP note above).
 */
export function servedSkillSource({ fetch: fetchFile, files } = {}) {
  return Object.freeze({
    async read(pluginId, hash, path) {
      if (!ID.test(pluginId) || !HASH.test(hash) || !skillFilePath(path)) throw new Error(`Invalid plugin file ${pluginId}/${path}`);
      const reader = files ?? (fetchFile ? null : pluginFiles());
      if (reader) {
        try { return await reader.read(pluginId, hash, path); }
        catch (error) { throw new Error(`Could not read ${path} of ${pluginId}: ${message(error)}`); }
      }
      const fetch = fetchFile ?? globalThis.fetch?.bind(globalThis);
      if (typeof fetch !== "function") throw new Error("This page cannot read installed plugin files");
      let response;
      try { response = await fetch(`/assets/web/plugins/${pluginId}/${hash}/${path.split("/").map(encodeURIComponent).join("/")}`); }
      catch (error) { throw new Error(`Could not read ${path} of ${pluginId}: ${message(error)} (the host must allow the page to read plugin files)`); }
      if (!response.ok) throw new Error(`Could not read ${path} of ${pluginId}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  });
}

/**
 * createSkillMirror({env, source, directory, onError}):
 * - sync(skills): skills = [{pluginId, hash, name, files?: [paths], contents?: {path: text}}],
 *   the COMPLETE set of packaged skills of active plugins. Copies what changed,
 *   removes stale plugin folders, resolves {ready, failed}. Calls are serialized
 *   and the latest set wins. onError only hears about failures of a whole sync
 *   (e.g. the environment closed); per-skill problems are in the result.
 * - location(pluginId, hash, name): absolute path of the copied SKILL.md, or
 *   undefined while it is not (yet) copied for that revision.
 * - settled(timeoutMs): resolves when no sync is pending (or after timeoutMs).
 * - list(): {ready: [...], failed: [{pluginId, name, reason}]} diagnostics.
 */
export function createSkillMirror({ env, source, directory = SKILLS_DIRECTORY, onError = () => {} } = {}) {
  if (!env || typeof env.exec !== "function" || typeof env.writeFile !== "function") throw new TypeError("The skill mirror needs an execution environment with exec and writeFile");
  if (!source || typeof source.read !== "function") throw new TypeError("The skill mirror needs a source with read(pluginId, hash, path)");
  if (!skillFilePath(directory)) throw new TypeError("directory must be a relative workspace path");
  const base = String(env.cwd ?? "").replace(/\/+$/, "");
  if (!base.startsWith("/")) throw new TypeError("The execution environment has no absolute workspace directory");
  const root = `${base}/${directory}`;
  const ready = new Map(); // `${id}\0${hash}\0${name}` -> absolute SKILL.md path
  let failed = [];
  let latest = null, active = null;

  function report(error, details) {
    try { onError(error instanceof Error ? error : new Error(String(error)), details); } catch { /* reporting must not break the mirror */ }
  }
  async function run(script) {
    let output = "";
    const result = await env.exec(script, { cwd: base, timeout: 60, onOutput(text) { if (output.length < 4000) output += text; } }, {});
    if (!result?.ok) throw new Error(result?.error?.message ?? "Command failed");
    if (result.value?.exitCode !== 0) throw new Error(output.trim().slice(-400) || `Command exited with ${result.value?.exitCode}`);
  }
  async function readStamp(pluginId) {
    if (typeof env.readTextFile !== "function") return undefined;
    try {
      const result = await env.readTextFile(`${root}/${pluginId}/${STAMP}`, {});
      return result?.ok ? String(result.value) : undefined;
    } catch { return undefined; }
  }
  async function bytesOf(skill, path) {
    if (skill.contents) {
      const text = skill.contents[path];
      if (typeof text !== "string") throw new Error(`Skill ${skill.name} has no inline ${path}`);
      return new TextEncoder().encode(text);
    }
    const data = await source.read(skill.pluginId, skill.hash, `web/skills/${skill.name}/${path}`);
    return typeof data === "string" ? new TextEncoder().encode(data) : data;
  }
  // Every file of one skill, read before anything is written; SKILL.md must name it.
  async function collect(skill) {
    const paths = skill.contents ? Object.keys(skill.contents) : skill.files ?? ["SKILL.md"];
    if (!paths.includes("SKILL.md")) throw new Error(`Skill ${skill.name} has no SKILL.md`);
    const files = [];
    for (const path of paths) {
      if (!skillFilePath(path)) throw new Error(`Skill ${skill.name}: invalid file path ${JSON.stringify(path)}`);
      files.push([path, await bytesOf(skill, path)]);
    }
    const front = skillFrontmatter(new TextDecoder().decode(files.find(([path]) => path === "SKILL.md")[1]));
    if (front.name !== skill.name) throw new Error(`Skill ${skill.name}: SKILL.md names it ${front.name}`);
    return files;
  }
  async function mirrorPlugin(pluginId, hash, skills) {
    const stamp = JSON.stringify({ hash, skills: skills.map((skill) => ({ name: skill.name, files: (skill.contents ? Object.keys(skill.contents) : skill.files ?? ["SKILL.md"]).slice().sort() })) });
    const key = (skill) => `${pluginId}\0${hash}\0${skill.name}`;
    const location = (skill) => `${root}/${pluginId}/${skill.name}/SKILL.md`;
    if (await readStamp(pluginId) === stamp) {
      for (const skill of skills) ready.set(key(skill), location(skill));
      return [];
    }
    const good = [], problems = [];
    for (const skill of skills) {
      try { good.push([skill, await collect(skill)]); }
      catch (error) { problems.push({ pluginId, name: skill.name, reason: message(error) }); }
    }
    const staging = `${root}/.staging-${pluginId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const directories = new Set([staging]);
    for (const [skill, files] of good) for (const [path] of files) {
      const parts = `${skill.name}/${path}`.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(`${staging}/${parts.slice(0, i).join("/")}`);
    }
    await run(`mkdir -p ${[...directories].map(quote).join(" ")}`);
    for (const [skill, files] of good) for (const [path, data] of files) {
      const written = await env.writeFile(`${staging}/${skill.name}/${path}`, data, {});
      if (written && written.ok === false) throw new Error(written.error?.message ?? `Could not write ${path}`);
    }
    // An incomplete copy is not stamped as the revision: the next sync tries again.
    const stampWrite = await env.writeFile(`${staging}/${STAMP}`, problems.length ? "{\"incomplete\":true}" : stamp, {});
    if (stampWrite && stampWrite.ok === false) throw new Error(stampWrite.error?.message ?? "Could not write the skill stamp");
    const final = `${root}/${pluginId}`;
    for (const skill of skills) ready.delete(key(skill));
    await run(`set -e; if [ -e ${quote(final)} ]; then chmod -R u+w ${quote(final)} 2>/dev/null || true; rm -rf ${quote(final)}; fi; mv ${quote(staging)} ${quote(final)}; chmod -R a-w ${quote(final)} 2>/dev/null || true`);
    for (const [skill] of good) ready.set(key(skill), location(skill));
    return problems;
  }
  async function apply(skills) {
    const byPlugin = new Map();
    const problems = [];
    for (const skill of skills) {
      if (!ID.test(skill?.pluginId ?? "") || !HASH.test(skill?.hash ?? "") || !SKILL_NAME.test(skill?.name ?? "")) {
        problems.push({ pluginId: skill?.pluginId, name: skill?.name, reason: "Invalid packaged skill (plugin id, revision hash or skill name)" });
        continue;
      }
      if (!byPlugin.has(skill.pluginId)) byPlugin.set(skill.pluginId, { hash: skill.hash, skills: [] });
      const entry = byPlugin.get(skill.pluginId);
      if (entry.hash !== skill.hash) { problems.push({ pluginId: skill.pluginId, name: skill.name, reason: "Skills of one plugin come from two revisions" }); continue; }
      entry.skills.push(skill);
    }
    // Nothing to copy and nothing copied before: do not create .skills/ at all.
    if (!byPlugin.size) {
      ready.clear();
      await run(`[ -e ${quote(root)} ] || exit 0; chmod -R u+w ${quote(root)} 2>/dev/null || true; rm -rf ${quote(root)}`);
      return problems;
    }
    await run(`mkdir -p ${quote(root)}`);
    for (const [pluginId, { hash, skills: list }] of byPlugin) {
      try { problems.push(...await mirrorPlugin(pluginId, hash, list)); }
      catch (error) {
        for (const skill of list) problems.push({ pluginId, name: skill.name, reason: message(error) });
      }
    }
    // Stale copies: plugins no longer active (or without skills) and abandoned staging folders.
    for (const key of [...ready.keys()]) {
      const [pluginId, hash, name] = key.split("\0");
      if (!skills.some((skill) => skill.pluginId === pluginId && skill.hash === hash && skill.name === name)) ready.delete(key);
    }
    const keep = [...byPlugin.keys()].join(" ");
    await run(`cd ${quote(root)} && for entry in * .staging-*; do [ -e "$entry" ] || continue; case " ${keep} " in *" $entry "*) ;; *) chmod -R u+w "$entry" 2>/dev/null || true; rm -rf "$entry";; esac; done`);
    return problems;
  }
  async function loop() {
    while (latest) {
      const { skills, waiters } = latest;
      latest = null;
      let outcome;
      try {
        // Per-skill problems are returned (agent-extensions.js reports and diagnoses them).
        failed = await apply(skills);
        outcome = { ready: [...ready.values()], failed: failed.map((item) => ({ ...item })) };
      } catch (error) {
        // The environment refused (closed, no shell): nothing is listed as copied.
        ready.clear();
        failed = skills.map((skill) => ({ pluginId: skill.pluginId, name: skill.name, reason: message(error) }));
        report(error, { phase: "skills" });
        outcome = { ready: [], failed: failed.map((item) => ({ ...item })) };
      }
      for (const resolve of waiters) resolve(outcome);
    }
  }
  function start() {
    const run = queue.then(loop).catch((error) => report(error, { phase: "skills" }));
    queue = run;
    active = run.finally(() => { active = null; if (latest) start(); });
  }
  function sync(skills) {
    if (!Array.isArray(skills)) throw new TypeError("sync expects the list of packaged skills");
    const waiters = latest?.waiters ?? [];
    latest = { skills: skills.map((skill) => ({ ...skill })), waiters };
    const done = new Promise((resolve) => waiters.push(resolve));
    if (!active) start();
    return done;
  }
  // Resolves once no sync is queued or running (bounded: a prompt never waits long).
  async function settled(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (active && Date.now() < deadline) {
      let timer;
      await Promise.race([active, new Promise((resolve) => { timer = globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
      globalThis.clearTimeout(timer);
    }
  }
  function location(pluginId, hash, name) {
    return ready.get(`${pluginId}\0${hash}\0${name}`);
  }
  function list() {
    return { root, ready: [...ready.values()], failed: failed.map((item) => ({ ...item })) };
  }
  return Object.freeze({ sync, location, settled, list, root });
}
