// Page-owned bridge from plugin contributions of kind "agent.extensions" to the
// pi-durable registry of whichever session is currently open. The plugin runtime
// outlives sessions (background/foreground, app revisions); sessions attach their
// registry and detach it on close. Detaching never closes or stops the runtime.
// No authorization: plugins are trusted app code. This module imports no library
// code so it stays cheap and testable; extensions are built by plugins with ctx.pi.
//
// A2: the app's own tools are contributions of ESSENTIAL built-in plugins
// (core-agent-plugins.js). Essential contributions
// - may use the permanent names below, and several of them with the same name are
//   merged in order into ONE extension (self-forming-native = core-tools +
//   core-self-update + core-plugin-management), so stored pi.agent selections that
//   name it keep exactly the same tools;
// - are processed before every other plugin, so another plugin can only take one of
//   their tools with an explicit replaces;
// - are never deselectable per conversation (describe/change);
// - also arrive as a bundled fallback with attach(registry, {builtins}) and are
//   installed at once, before composition settles, and kept when it fails, is slow,
//   or lacks (or failed to set up) a core plugin.
// A contribution may be session-bound: {name, tools: [names], create(host)} with a
// static declaration; create(host) builds that session's tools (or extension-like
// {tools, sections, hooks, wraps, tasks}) once per attached registry from the host
// given to attach, e.g. the session's workspace and harness handle.
//
// A3: prompt sections. The essential core-prompt contributes "self-forming-prompts"
// (core keys device, app, self-rebuild, subagents, servers, agents-guide, transcript).
// Any plugin extension may carry sections (pi-durable section(key, render)); the same
// rules as for tools apply:
// - section keys are unique across contributed extensions; taking an existing key
//   (a core key or another plugin's) needs an explicit replaces: ["<key>"] — replaces
//   names tools and/or section keys the contribution itself provides. A replaced core
//   section keeps its place in the prompt and its per-conversation selection
//   (core-agent-plugins.js gates it with PromptSelectionDoc);
// - order: core prompt sections first, then plugin sections in composition order
//   (pi-durable renders sections in the conversation's extension order; the agent's
//   instructions always come last);
// - excluding a plugin in a conversation (extensions.remove) removes its sections too.
//
// Core fallback: for every ESSENTIAL contribution the session supplied a bundled copy
// of (attach builtins), the runtime copy is used only while it is healthy: its plugin
// is active, the value normalizes, create(host) succeeds and the registry accepts it.
// Otherwise (setup failed, stopped, runtime closed, create threw or returned invalid
// tools/sections) the bundled copy is installed in its place, so a session never
// loses core tools or its prompt; list().fallbacks / describe() report
// "... (using built-in copy)". Essential plugins cannot be disabled app-wide.
//
// A3b: Agent Skills. Contribution kind "agent.skills" (one skill per contribution):
// - {name, description, path}: path is readable by the agent's file tools, relative
//   to the workspace or absolute (the app's own skills, core-agent-plugins.js);
// - {name, description, files: ["SKILL.md", ...]} or {name, description, contents:
//   {"SKILL.md": text, ...}}: a skill an installed plugin ships at web/skills/<name>/;
//   the session's skill mirror (plugin-skills.js, host.skillMirror) copies it to
//   <workspace>/.skills/<pluginId>/<name>/ and it is listed once copied.
// Skill names are unique; taking an existing name needs replaces: ["<name>"] (one
// replacement per name, it keeps the replaced skill's position). The essential
// core-skills section lists the skills a conversation may use: essential skills
// always, a plugin's skills while the conversation selects the plugin. A plugin that
// contributes skills but no extension gets an empty carrier extension
// "skills:<pluginId>" so per-conversation exclusion has a name to store.
export const AGENT_EXTENSIONS = "agent.extensions";
export const AGENT_SKILLS = "agent.skills";
export const skillCarrierName = (pluginId) => `skills:${pluginId}`;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_WAIT_MS = 5000;
// Permanent extension names of the app itself (docs/plugins.md §9a). Only essential
// plugins may contribute them: registry.install would silently replace the built-in.
export const CORE_EXTENSION_NAMES = Object.freeze([
  "self-forming-native", "self-forming-subagents", "self-forming-servers", "self-forming-workspace", "self-forming-prompts"
]);
export const READY_TIMEOUT_MS = 5000;
const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;
const FIELDS = ["tools", "sections", "hooks", "wraps", "tasks"];
const message = (error) => error instanceof Error ? error.message : String(error);

/** True when the stored pi.agent `extensions` field leaves out every given name. */
export function excludes(agentState, names) {
  const stored = agentState?.extensions;
  if (!names.length) return false;
  if (Array.isArray(stored)) return names.every((name) => !stored.includes(name));
  const removed = stored?.remove ?? [];
  return names.every((name) => removed.includes(name));
}

/**
 * Per-conversation selection is stored with pi-durable's own agent configuration
 * (pi.agent `extensions`) as {remove: [extension names]} over the live host default,
 * so plugins installed later are selected unless a conversation excluded them.
 * Returns the value for conversation.configure({extensions}); null = host default.
 */
export function selectionChange(agentState, names, enabled) {
  const named = (list) => list.map((name) => ({ name }));
  const stored = agentState?.extensions;
  if (Array.isArray(stored)) {
    // An explicit list (not written by this app) stays explicit.
    const next = enabled ? [...stored, ...names.filter((name) => !stored.includes(name))] : stored.filter((name) => !names.includes(name));
    return named(next);
  }
  const remove = new Set(stored?.remove ?? []);
  for (const name of names) enabled ? remove.delete(name) : remove.add(name);
  const add = (stored?.add ?? []).filter((name) => enabled || !names.includes(name));
  if (!remove.size && !add.length) return null;
  return { ...(add.length ? { add: named(add) } : {}), ...(remove.size ? { remove: named([...remove]) } : {}) };
}

function names(list, label, owner) {
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string" || !name)) throw new TypeError(`${owner}: ${label} must be an array of names`);
  const twice = list.find((name, index) => list.indexOf(name) !== index);
  if (twice) throw new Error(`${owner} declares ${label} ${twice} twice`);
  return [...list];
}
function shape(extension) {
  for (const field of FIELDS) {
    if (extension[field] !== undefined && !Array.isArray(extension[field])) throw new TypeError(`Extension ${extension.name}: ${field} must be an array`);
  }
  const tools = (extension.tools ?? []).map((tool) => {
    if (typeof tool?.name !== "string" || !tool.name || typeof tool.execute !== "function") throw new TypeError(`Extension ${extension.name}: each tool needs a name and execute()`);
    return tool.name;
  });
  const duplicate = tools.find((name, index) => tools.indexOf(name) !== index);
  if (duplicate) throw new Error(`Extension ${extension.name} has two tools named ${duplicate}`);
  const sections = (extension.sections ?? []).map(({ key, render } = {}) => {
    if (typeof key !== "string" || !SECTION_KEY.test(key) || key === "instructions") throw new TypeError(`Extension ${extension.name}: invalid section key ${JSON.stringify(key)}`);
    if (typeof render !== "function") throw new TypeError(`Extension ${extension.name}: section ${key} needs render()`);
    return key;
  });
  const twice = sections.find((key, index) => sections.indexOf(key) !== index);
  if (twice) throw new Error(`Extension ${extension.name} has two sections with key ${twice}`);
  const tasks = (extension.tasks ?? []).map((task) => {
    const name = task?.definition?.name;
    if (typeof name !== "string" || !name) throw new TypeError(`Extension ${extension.name}: invalid task`);
    return name;
  });
  return { tools, sections, tasks };
}
function normalize(value) {
  if (value && typeof value === "object" && typeof value.create === "function" && !("extension" in value)) {
    // Session-bound: everything the composition checks is declared statically.
    if (typeof value.name !== "string" || !value.name) throw new TypeError("A session-bound agent extension needs a name");
    const owner = `Extension ${value.name}`;
    const tools = names(value.tools ?? [], "tool", owner), sections = names(value.sections ?? [], "section", owner), tasks = names(value.tasks ?? [], "task", owner);
    const replaces = [...new Set(names(value.replaces ?? [], "replaces", owner))];
    const missing = replaces.find((name) => !tools.includes(name) && !sections.includes(name));
    if (missing) throw new Error(`${owner} declares replaces ${missing} but contributes no tool or section of that name`);
    if (sections.some((key) => !SECTION_KEY.test(key) || key === "instructions")) throw new TypeError(`${owner}: invalid section key`);
    return { value, create: value.create, name: value.name, tools, sections, tasks, replaces };
  }
  const wrapped = value && typeof value === "object" && value.extension && typeof value.extension === "object" && !("name" in value);
  const extension = wrapped ? value.extension : value;
  const replaces = (wrapped ? value.replaces : value?.replaces) ?? [];
  if (!extension || typeof extension !== "object") throw new TypeError("agent.extensions needs a pi-durable extension object (ctx.pi.defineExtension)");
  if (typeof extension.name !== "string" || !extension.name) throw new TypeError("The contributed extension needs a name");
  if (!Array.isArray(replaces) || replaces.some((name) => typeof name !== "string" || !name)) throw new TypeError("replaces must be an array of tool names or section keys");
  const { tools, sections, tasks } = shape(extension);
  const missing = replaces.find((name) => !tools.includes(name) && !sections.includes(name));
  if (missing) throw new Error(`Extension ${extension.name} declares replaces ${missing} but contributes no tool or section of that name`);
  return { value, extension, name: extension.name, tools, sections, tasks, replaces: [...new Set(replaces)] };
}
function relativePath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
}
function normalizeSkill(value) {
  if (!value || typeof value !== "object") throw new TypeError("agent.skills needs {name, description, path} or {name, description, files}");
  const { name, description } = value;
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name)) throw new TypeError(`Invalid skill name ${JSON.stringify(name)}: lowercase letters, digits and single hyphens, at most 64`);
  if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new TypeError(`Skill ${name} needs a description of at most 1024 characters`);
  const replaces = value.replaces ?? [];
  if (!Array.isArray(replaces) || replaces.some((item) => item !== name)) throw new Error(`Skill ${name}: replaces may only name the skill itself (replaces: ["${name}"])`);
  const forms = ["path", "files", "contents"].filter((field) => value[field] !== undefined);
  if (forms.length > 1) throw new Error(`Skill ${name}: use one of path, files or contents`);
  const item = { value, name, description: description.trim(), replaces: replaces.length > 0 };
  if (value.path !== undefined) {
    const path = value.path;
    const parts = typeof path === "string" ? path.replace(/^\/+/, "") : "";
    if (!relativePath(parts) || !/\.md$/i.test(path)) throw new TypeError(`Skill ${name}: path must be a workspace or absolute path to its SKILL.md, without ..`);
    return { ...item, path };
  }
  if (value.contents !== undefined) {
    if (!value.contents || typeof value.contents !== "object" || Array.isArray(value.contents)) throw new TypeError(`Skill ${name}: contents must map file paths to text`);
    const files = Object.keys(value.contents);
    if (files.some((file) => !relativePath(file) || typeof value.contents[file] !== "string")) throw new TypeError(`Skill ${name}: contents must map relative file paths to text`);
    if (!files.includes("SKILL.md")) throw new Error(`Skill ${name}: contents need SKILL.md`);
    return { ...item, files, contents: value.contents };
  }
  const files = value.files ?? ["SKILL.md"];
  if (!Array.isArray(files) || files.length > 512 || files.some((file) => !relativePath(file))) throw new TypeError(`Skill ${name}: files must be relative paths inside web/skills/${name}/`);
  if (new Set(files).size !== files.length) throw new Error(`Skill ${name} lists a file twice`);
  if (!files.includes("SKILL.md")) throw new Error(`Skill ${name}: files need SKILL.md`);
  return { ...item, files: [...files] };
}

// Host compatibility rule (pi-durable 1.2.0, CHANGELOG "Breaking Changes": `ToolExecutionResult.content`
// is now `output`): a tool written for pi-durable <= 1.1 answers `{content}`, which 1.2+ ignores (the
// model would get only the retained progress text, usually nothing). Every extension the adapter
// installs gets its tools wrapped once: a result with `content` and no `output` is passed on with
// `output: content`. App tools answer `output` themselves; the wrap is for installed plugins and for
// built-ins not migrated yet (core-subagents). One wrapped extension per extension object, so the
// registry sees a stable value.
const compatibleExtensions = /* @__PURE__ */ new WeakMap();
function legacyToolResult(result) {
  if (!result || typeof result !== "object" || result.output !== void 0 || !Array.isArray(result.content)) return result;
  const { content, ...rest } = result;
  return { ...rest, output: content };
}
function compatibleTool(tool) {
  if (!tool || typeof tool.execute !== "function") return tool;
  const execute = tool.execute;
  return { ...tool, async execute(...args) {
    return legacyToolResult(await execute.apply(tool, args));
  } };
}
export function compatibleExtension(extension) {
  if (!extension || typeof extension !== "object" || !Array.isArray(extension.tools) || !extension.tools.length) return extension;
  let wrapped = compatibleExtensions.get(extension);
  if (!wrapped) {
    wrapped = Object.freeze({ ...extension, tools: Object.freeze(extension.tools.map(compatibleTool)) });
    compatibleExtensions.set(extension, wrapped);
  }
  return wrapped;
}
// The session's part: created once per registry; must stay inside its declaration.
function created(item, host) {
  let result = item.create(host);
  if (result == null) return null;
  if (Array.isArray(result)) result = { tools: result };
  if (typeof result !== "object" || typeof result.then === "function") throw new TypeError(`Extension ${item.name}: create() must synchronously return tools or an extension part`);
  if (result.name !== undefined && result.name !== item.name) throw new Error(`Extension ${item.name}: create() returned extension ${result.name}`);
  const actual = shape({ ...result, name: item.name });
  for (const [label, got, declared] of [["tool", actual.tools, item.tools], ["section", actual.sections, item.sections], ["task", actual.tasks, item.tasks]]) {
    const extra = got.find((name) => !declared.includes(name));
    if (extra) throw new Error(`Extension ${item.name}: created ${label} ${extra} was not declared`);
  }
  return result;
}

/**
 * createAgentExtensions({onError, timeoutMs}) → adapter:
 * - connect(runtime, {installed}) once composition started; unavailable(error) if it failed.
 * - ready(): page-level barrier, resolves when connected/unavailable or after timeoutMs.
 * - attach(registry, {host, builtins}) → detach(): install accepted extensions now and on
 *   every change; host (plus host.skills(query), this registry's skill listing) is
 *   passed to session-bound create(); builtins are the bundled essential contributions
 *   [{pluginId, key, order, value, kind?: "agent.skills"}] (core-agent-plugins.js).
 *   host.skillMirror (plugin-skills.js), when given, receives the packaged skills of
 *   active plugins once composition is connected.
 * - extensions(registry?): plugin (non-essential) extensions in accepted order; with a
 *   registry, the instances installed there.
 * - selection(base, registry): live pi-durable settings.extensions default.
 * - describe(agentState) / change(agentState, pluginId, enabled) for per-conversation UI.
 * - subscribe(listener) → unsubscribe; list() diagnostics, incl. skills and fallbacks
 *   ([{pluginId, reason}]: essential plugins currently served by their bundled copy).
 */
export function createAgentExtensions({ onError = () => {}, timeoutMs = READY_TIMEOUT_MS } = {}) {
  let runtime = null, unsubscribeRuntime = () => {}, settled = false, late = false, unavailableReason;
  let resolveSettled;
  const whenSettled = new Promise((resolve) => { resolveSettled = resolve; });
  let readiness;
  // registry -> {installed: Map<name, extension>, host, parts: WeakMap<value, part|null>, groups: Map<name, {values, extension}>}
  const registries = new Map();
  let core = { names: new Set(CORE_EXTENSION_NAMES), installedNames: new Set(), tools: new Map(), sections: new Map(), tasks: new Set() };
  let bundled = []; // essential contributions supplied by the session (fallback)
  let accepted = [], rejected = [];
  let skills = []; // accepted agent.skills items, in listing order
  let fallbacks = new Map(); // essential plugin id -> why its bundled copy is used
  const createFallbacks = new Map(); // runtime contribution key -> {pluginId, reason}: create failed, bundled part used
  const mirrorFailures = new Map(); // skill contribution key -> reason the mirror could not copy it
  const carriers = new Map(); // plugin id -> frozen empty carrier extension (skills only)
  const installFailures = new WeakMap(); // contribution value -> reason (registry refused it)
  const seen = new Map(); // plugin id -> true once it contributed agent extensions on this page
  let installed = []; // host inventory diagnostics (external plugins)
  const listeners = new Set();
  let scheduled = false, signature = "";
  const reported = new Set(); // each rejection is reported once per page

  function report(error, details) {
    try { onError(error instanceof Error ? error : new Error(String(error)), details); } catch { /* reporting must not break sync */ }
  }
  function reportOnce(id, error, details) {
    if (reported.has(id)) return;
    reported.add(id);
    report(error, details);
  }
  function settle() {
    if (settled) return;
    settled = true;
    resolveSettled();
  }
  function managed() {
    const result = new Set(accepted.map((item) => item.name));
    for (const state of registries.values()) for (const name of state.installed.keys()) result.add(name);
    return result;
  }
  function readCore(registry) {
    const ours = managed();
    const snapshot = registry.snapshot();
    const extensions = snapshot.installed().filter((extension) => !ours.has(extension.name));
    const next = { names: new Set(CORE_EXTENSION_NAMES), installedNames: new Set(), tools: new Map(), sections: new Map(), tasks: new Set() };
    const ourTasks = new Set(accepted.flatMap((item) => item.tasks));
    for (const extension of extensions) {
      next.names.add(extension.name);
      next.installedNames.add(extension.name);
      for (const tool of extension.tools ?? []) next.tools.set(tool.name, `built-in ${extension.name}`);
      for (const { key } of extension.sections ?? []) next.sections.set(key, `built-in ${extension.name}`);
    }
    for (const task of snapshot.tasks?.() ?? []) if (!ourTasks.has(task.definition.name)) next.tasks.add(task.definition.name);
    return next;
  }

  // Why an essential plugin's runtime copy cannot be used (undefined: still pending
  // or simply absent, e.g. not connected yet or a runtime without core plugins).
  function unusable(record, key) {
    if (!record) return undefined;
    if (record.state === "failed") return record.reason ?? "Setup failed";
    if (record.state === "stopped") return "Stopped unexpectedly";
    if (record.state === "blocked") return record.reason ?? "Blocked";
    if (record.state === "active") return `Contributed no ${key}`;
    return undefined;
  }
  /**
   * Runtime contributions of one kind plus the bundled essential copies standing in
   * for unusable runtime copies. Returns [{key, pluginId, source, essential, order,
   * fallback?, ...normalized}] and pushes failures; records fallbacks.
   */
  function gather(kind, normalizeValue, byId, failed, nextFallbacks) {
    const items = [];
    const live = new Set();
    const copies = bundled.filter((entry) => (entry.kind ?? AGENT_EXTENSIONS) === kind);
    const backupOf = (pluginId, key) => copies.find((entry) => entry.pluginId === pluginId && entry.key === key);
    for (const entry of runtime ? runtime.contributions(kind) : []) {
      const isEssential = byId.get(entry.providerId)?.essential === true;
      if (!isEssential) seen.set(entry.providerId, true);
      const backup = isEssential ? backupOf(entry.providerId, entry.key) : undefined;
      const base = { kind, key: entry.key, pluginId: entry.providerId, source: "runtime", essential: isEssential, order: entry.order };
      try {
        const item = { ...base, ...normalizeValue(entry.value) };
        const refused = installFailures.get(item.value);
        if (refused) throw new Error(refused);
        if (backup) item.fallback = backup.value;
        items.push(item);
        live.add(entry.key);
      } catch (error) {
        const reason = message(error);
        failed.push({ ...base, reason: backup ? `${reason} (using built-in copy)` : reason, ...(backup ? { fallback: true } : {}) });
        if (backup && !nextFallbacks.has(entry.providerId)) nextFallbacks.set(entry.providerId, reason);
      }
    }
    for (const entry of copies) {
      if (live.has(entry.key)) continue; // the healthy runtime copy is used
      const reason = unusable(byId.get(entry.pluginId), entry.key);
      if (reason && !nextFallbacks.has(entry.pluginId)) nextFallbacks.set(entry.pluginId, reason);
      const base = { kind, key: `bundled:${entry.key}`, pluginId: entry.pluginId, source: "bundled", essential: true, order: entry.order ?? 0 };
      try {
        const item = { ...base, ...normalizeValue(entry.value) };
        const refused = installFailures.get(item.value);
        if (refused) throw new Error(refused);
        items.push(item);
      } catch (error) { failed.push({ ...base, reason: message(error) }); }
    }
    return items;
  }

  function compute() {
    const records = runtime ? runtime.list() : [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const failed = [], nextFallbacks = new Map();
    const essential = [], plain = [], replacing = [];
    for (const item of gather(AGENT_EXTENSIONS, normalize, byId, failed, nextFallbacks)) {
      (item.essential ? essential : item.replaces.length ? replacing : plain).push(item);
    }
    essential.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const owners = new Map([...core.names].map((name) => [name, "the app"]));
    const groups = new Map(); // essential extension name -> owner text
    const tools = new Map(core.tools), sections = new Map(core.sections);
    const tasks = new Map([...core.tasks].map((name) => [name, "the app"]));
    const replaced = new Map(), replacedSections = new Map();
    const result = [];
    // Essential parts first; then plain contributions, then explicit replacements, each
    // in the runtime's deterministic contribution order. Later selection wins in
    // pi-durable, so a replacement is ordered after what it replaces; everything else
    // must be unique.
    for (const item of [...essential, ...plain, ...replacing]) {
      const reject = (reason) => failed.push({ kind: AGENT_EXTENSIONS, key: item.key, pluginId: item.pluginId, source: item.source, essential: item.essential, name: item.name, reason });
      const owner = item.essential ? `core plugin ${item.pluginId}` : `plugin ${item.pluginId}`;
      if (item.essential) {
        // Permanent names are open to essential parts unless the session installed one itself.
        if (core.installedNames.has(item.name)) { reject(`Extension name ${item.name} is already used by the app`); continue; }
        if (owners.has(item.name) && !groups.has(item.name) && !CORE_EXTENSION_NAMES.includes(item.name)) { reject(`Extension name ${item.name} is already used by ${owners.get(item.name)}`); continue; }
      } else if (owners.has(item.name)) { reject(`Extension name ${item.name} is already used by ${owners.get(item.name)}`); continue; }
      const clash = item.tools.find((name) => tools.has(name) && !item.replaces.includes(name));
      if (clash) { reject(`Tool ${clash} is already provided by ${tools.get(clash)}; declare replaces: ["${clash}"] to replace it`); continue; }
      const replacesTools = item.replaces.filter((name) => item.tools.includes(name));
      const replacesSections = item.replaces.filter((name) => item.sections.includes(name));
      const twice = replacesTools.find((name) => replaced.has(name));
      if (twice) { reject(`Tool ${twice} is already replaced by ${replaced.get(twice)}`); continue; }
      const section = item.sections.find((key) => sections.has(key) && !item.replaces.includes(key));
      if (section) { reject(`Prompt section ${section} is already provided by ${sections.get(section)}; declare replaces: ["${section}"] to replace it`); continue; }
      const sectionTwice = replacesSections.find((key) => replacedSections.has(key));
      if (sectionTwice) { reject(`Prompt section ${sectionTwice} is already replaced by ${replacedSections.get(sectionTwice)}`); continue; }
      const task = item.tasks.find((name) => tasks.has(name));
      if (task) { reject(`Task ${task} is already provided by ${tasks.get(task)}`); continue; }
      if (item.essential) groups.set(item.name, owner);
      owners.set(item.name, item.essential ? "a core plugin" : owner);
      for (const name of item.tools) tools.set(name, owner);
      for (const name of replacesTools) replaced.set(name, owner);
      for (const key of replacesSections) replacedSections.set(key, owner);
      for (const key of item.sections) sections.set(key, owner);
      for (const name of item.tasks) tasks.set(name, owner);
      result.push({ ...item, position: result.length });
    }
    const listed = computeSkills(byId, failed, nextFallbacks);
    // Skills-only plugins: one empty carrier extension each (per-conversation exclusion).
    const withExtensions = new Set(result.filter((item) => !item.essential).map((item) => item.pluginId));
    for (const pluginId of [...new Set(listed.filter((skill) => !skill.essential).map((skill) => skill.pluginId))]) {
      if (withExtensions.has(pluginId)) continue;
      const name = skillCarrierName(pluginId);
      if (owners.has(name)) {
        for (const skill of listed.filter((entry) => entry.pluginId === pluginId)) failed.push({ kind: AGENT_SKILLS, key: skill.key, pluginId, source: skill.source, name: skill.name, reason: `Extension name ${name} is already used by ${owners.get(name)}` });
        listed.splice(0, listed.length, ...listed.filter((entry) => entry.pluginId !== pluginId));
        continue;
      }
      if (!carriers.has(pluginId)) carriers.set(pluginId, Object.freeze({ name }));
      owners.set(name, `plugin ${pluginId}`);
      result.push({ kind: AGENT_EXTENSIONS, key: name, pluginId, source: "runtime", essential: false, carrier: true, order: 0, value: carriers.get(pluginId), extension: carriers.get(pluginId), name, tools: [], sections: [], tasks: [], replaces: [], position: result.length });
    }
    return { accepted: result, rejected: failed, skills: listed, fallbacks: nextFallbacks };
  }

  // agent.skills: essential first (by order), then plugins, then explicit replacements.
  function computeSkills(byId, failed, nextFallbacks) {
    const hashes = new Map(installed.filter((item) => typeof item.hash === "string").map((item) => [item.id, item.hash]));
    const essential = [], plain = [], replacing = [];
    for (const item of gather(AGENT_SKILLS, normalizeSkill, byId, failed, nextFallbacks)) {
      (item.essential ? essential : item.replaces ? replacing : plain).push(item);
    }
    essential.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const result = [], names = new Map(), replaced = new Map();
    for (const item of [...essential, ...plain, ...replacing]) {
      const reject = (reason) => failed.push({ kind: AGENT_SKILLS, key: item.key, pluginId: item.pluginId, source: item.source, essential: item.essential, name: item.name, reason });
      const owner = item.essential ? `core plugin ${item.pluginId}` : `plugin ${item.pluginId}`;
      if (item.files) {
        if (item.essential) { reject(`Skill ${item.name}: built-in skills point at a workspace path`); continue; }
        if (!hashes.has(item.pluginId)) { reject(`Skill ${item.name}: packaged skills need an installed plugin revision`); continue; }
        item.hash = hashes.get(item.pluginId);
      }
      if (names.has(item.name)) {
        const index = names.get(item.name);
        if (!item.replaces) { reject(`Skill ${item.name} is already provided by ${result[index].owner}; declare replaces: ["${item.name}"] to replace it`); continue; }
        if (replaced.has(item.name)) { reject(`Skill ${item.name} is already replaced by ${replaced.get(item.name)}`); continue; }
        replaced.set(item.name, owner);
        result[index] = { ...item, owner }; // keeps the replaced skill's position
        continue;
      }
      names.set(item.name, result.length);
      result.push({ ...item, owner });
    }
    return result;
  }

  // Extensions for one registry: essential groups (parts merged in order), then
  // plugin extensions; static single contributions keep their identity.
  function plan(state) {
    const groups = new Map();
    for (const item of accepted) {
      if (!groups.has(item.name)) groups.set(item.name, []);
      groups.get(item.name).push(item);
    }
    const wanted = new Map();
    for (const [name, items] of groups) {
      if (items.length === 1 && items[0].extension) { wanted.set(name, { items, extension: items[0].extension }); continue; }
      const values = items.map((item) => item.value);
      const cached = state.groups.get(name);
      if (cached && cached.values.length === values.length && cached.values.every((value, index) => value === values[index])) {
        if (cached.extension) wanted.set(name, { items, extension: cached.extension });
        continue;
      }
      const merged = { name };
      for (const field of FIELDS) merged[field] = [];
      for (const item of items) {
        let part = item.extension;
        if (!part) {
          if (!state.parts.has(item.value)) {
            try { state.parts.set(item.value, created(item, state.createHost)); }
            catch (error) {
              state.parts.set(item.value, null);
              if (item.fallback) {
                // An essential runtime copy that cannot be built: this session uses the bundled copy.
                createFallbacks.set(item.key, { pluginId: item.pluginId, reason: message(error) });
                reportOnce(`create\0${item.key}\0${message(error)}`, new Error(`${message(error)} (using built-in copy)`), { id: item.pluginId, phase: "create", name: item.name });
                try { state.parts.set(item.value, created({ ...item, ...normalize(item.fallback) }, state.createHost)); }
                catch (second) { reportOnce(`create\0bundled:${item.key}\0${message(second)}`, second, { id: item.pluginId, phase: "create", name: item.name }); }
              } else reportOnce(`create\0${item.key}\0${message(error)}`, error, { id: item.pluginId, phase: "create", name: item.name });
            }
          }
          part = state.parts.get(item.value);
        }
        if (part) for (const field of FIELDS) merged[field].push(...part[field] ?? []);
      }
      for (const field of FIELDS) if (!merged[field].length) delete merged[field];
      const extension = FIELDS.some((field) => merged[field]) ? Object.freeze(merged) : null;
      state.groups.set(name, { values, extension });
      if (extension) wanted.set(name, { items, extension });
    }
    for (const name of [...state.groups.keys()]) if (!groups.has(name)) state.groups.delete(name);
    return wanted;
  }
  function apply(registry, state) {
    const wanted = plan(state);
    for (const [name, extension] of [...state.installed]) {
      if (wanted.has(name)) continue;
      try { registry.uninstall(extension); } catch (error) { report(error, { phase: "uninstall", name }); }
      state.installed.delete(name);
    }
    let refused = false;
    for (const [name, { items, extension: contributed }] of wanted) {
      const extension = compatibleExtension(contributed);
      if (state.installed.get(name) === extension) continue;
      try {
        registry.install(extension); // Same name replaces in place; running work keeps its code.
        state.installed.set(name, extension);
      } catch (error) {
        for (const item of items) installFailures.set(item.value, `The agent registry refused ${name}: ${message(error)}`);
        report(error, { id: items[0].pluginId, phase: "install", name });
        refused = true;
      }
    }
    return refused;
  }

  // Packaged skills to copy into the workspace: only once composition is connected
  // (before that the set is unknown and the mirror must not remove anything).
  function packaged() {
    return skills.filter((skill) => skill.files).map((skill) => ({ key: skill.key, pluginId: skill.pluginId, hash: skill.hash, name: skill.name, files: skill.files, ...(skill.contents ? { contents: skill.contents } : {}) }));
  }
  function mirror(state) {
    const target = state.host.skillMirror;
    if (!target || !runtime) return;
    const wanted = packaged();
    const next = JSON.stringify(wanted.map(({ key, pluginId, hash, name, files }) => [key, pluginId, hash, name, files]));
    if (next === state.mirrored) return;
    state.mirrored = next;
    void Promise.resolve().then(() => target.sync(wanted.map(({ key, ...skill }) => skill))).then((outcome) => {
      let changed = false;
      const problems = new Map((outcome?.failed ?? []).map((item) => [`${item.pluginId}\0${item.name}`, item.reason]));
      for (const skill of wanted) {
        const reason = problems.get(`${skill.pluginId}\0${skill.name}`);
        if (mirrorFailures.get(skill.key) !== reason) { reason ? mirrorFailures.set(skill.key, reason) : mirrorFailures.delete(skill.key); changed = true; }
        if (reason) reportOnce(`skills\0${skill.key}\0${reason}`, new Error(reason), { id: skill.pluginId, phase: "skills", name: skill.name });
      }
      if (changed) schedule();
    }, (error) => report(error, { phase: "skills" }));
  }
  function sync() {
    scheduled = false;
    let again = false;
    for (let round = 0; round < 3; round++) {
      ({ accepted, rejected, skills, fallbacks } = compute());
      again = false;
      for (const [registry, state] of registries) again = apply(registry, state) || again;
      if (!again) break;
    }
    for (const key of [...createFallbacks.keys()]) if (!accepted.some((item) => item.key === key)) createFallbacks.delete(key);
    for (const key of [...mirrorFailures.keys()]) if (!skills.some((skill) => skill.key === key)) mirrorFailures.delete(key);
    for (const state of registries.values()) mirror(state);
    for (const item of accepted) {
      if (item.source !== "runtime" || item.carrier) continue;
      const fallback = createFallbacks.get(item.key);
      runtime?.diagnose?.(AGENT_EXTENSIONS, item.key, fallback ? { state: "failed", reason: `${fallback.reason} (using built-in copy)`, fallback: true, name: item.name }
        : { state: "installed", position: item.position, name: item.name, tools: item.tools, ...(item.sections.length ? { sections: item.sections } : {}), ...(item.replaces.length ? { replaces: item.replaces } : {}) });
    }
    for (const skill of skills) {
      if (skill.source !== "runtime") continue;
      const problem = mirrorFailures.get(skill.key);
      runtime?.diagnose?.(AGENT_SKILLS, skill.key, problem ? { state: "failed", name: skill.name, reason: problem } : { state: "installed", name: skill.name, ...(skill.files ? { packaged: true } : { path: skill.path }) });
    }
    for (const item of rejected) {
      if (item.source === "runtime") runtime?.diagnose?.(item.kind ?? AGENT_EXTENSIONS, item.key, { state: "failed", reason: item.reason, ...(item.name ? { name: item.name } : {}), ...(item.fallback ? { fallback: true } : {}) });
    }
    const next = JSON.stringify([accepted.map((item) => [item.key, item.pluginId, item.name, item.tools, item.sections]), rejected, late, unavailableReason ?? null,
      skills.map((skill) => [skill.key, skill.pluginId, skill.name]), [...fallbacks], [...createFallbacks], [...mirrorFailures],
      runtime ? runtime.list().map((r) => [r.id, r.state, r.reason ?? ""]) : []]);
    if (next !== signature) {
      signature = next;
      for (const item of rejected) reportOnce(`${item.pluginId}\0${item.key}\0${item.reason}`, new Error(item.reason), { id: item.pluginId, phase: item.kind ?? AGENT_EXTENSIONS, key: item.key });
      for (const [pluginId, reason] of fallbacks) reportOnce(`fallback\0${pluginId}\0${reason}`, new Error(`${reason} (using built-in copy)`), { id: pluginId, phase: "fallback" });
      notify();
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { report(error, { phase: "subscribe" }); }
    }
  }

  function connect(next, { installed: inventory = [] } = {}) {
    if (runtime) { report(new Error("Agent extensions are already connected to a plugin runtime"), { phase: "connect" }); return; }
    if (!next || typeof next.contributions !== "function" || typeof next.subscribe !== "function") throw new TypeError("connect needs a plugin runtime");
    runtime = next;
    installed = Array.isArray(inventory) ? inventory.map((item) => ({ ...item })) : [];
    unsubscribeRuntime = runtime.subscribe(schedule);
    sync(); // Synchronously: attached registries have the extensions before ready resolves.
    settle();
  }
  function unavailable(error) {
    if (runtime || settled) return;
    unavailableReason = message(error ?? "Plugins are unavailable");
    report(error ?? new Error(unavailableReason), { phase: "composition" });
    settle();
    notify();
  }
  function ready() {
    if (!readiness) readiness = new Promise((resolve) => {
      if (settled) { resolve(); return; }
      const timer = globalThis.setTimeout(() => {
        if (!settled) {
          late = true;
          report(new Error(`Plugins were not ready within ${timeoutMs} ms; replies continue without their tools until they load`), { phase: "readiness" });
          notify();
        }
        resolve();
      }, timeoutMs);
      void whenSettled.then(() => { globalThis.clearTimeout(timer); resolve(); });
    });
    return readiness;
  }
  function attach(registry, { host = {}, builtins } = {}) {
    if (!registry || typeof registry.install !== "function" || typeof registry.uninstall !== "function") throw new TypeError("attach needs a pi-durable registry");
    if (registries.has(registry)) return registries.get(registry).detach;
    if (builtins !== undefined) {
      if (!Array.isArray(builtins) || builtins.some((entry) => typeof entry?.pluginId !== "string" || typeof entry?.key !== "string" || !entry.value || ![undefined, AGENT_EXTENSIONS, AGENT_SKILLS].includes(entry.kind))) throw new TypeError("builtins must be [{pluginId, key, order, value, kind?}]");
      bundled = builtins.map((entry) => ({ ...entry }));
    }
    core = readCore(registry);
    let detached = false;
    const state = {
      installed: new Map(), host, parts: new WeakMap(), groups: new Map(), mirrored: undefined,
      detach: () => { if (!detached) { detached = true; registries.delete(registry); } }
    };
    // What session-bound create(host) receives: the session's host plus this registry's
    // skill listing (core-skills renders it).
    state.createHost = Object.freeze({ ...host, skills: (query) => skillsFor(state, query) });
    registries.set(registry, state);
    sync();
    return state.detach;
  }
  /**
   * Skills one conversation may use: [{name, description, location, pluginId, packaged}].
   * query: {extensions: Set of the conversation's resolved extension names, cwd: the
   * workspace directory for relative paths}. Packaged skills are listed once copied.
   */
  async function skillsFor(state, { extensions, cwd } = {}) {
    const target = state.host.skillMirror;
    if (target && runtime && skills.some((skill) => skill.files)) await target.settled?.(SKILL_WAIT_MS);
    const names = new Map();
    for (const item of accepted) if (!item.essential) names.set(item.pluginId, [...names.get(item.pluginId) ?? [], item.name]);
    const selected = (skill) => skill.essential || !(extensions instanceof Set) || (names.get(skill.pluginId) ?? []).some((name) => extensions.has(name));
    const base = typeof cwd === "string" ? cwd.replace(/\/+$/, "") : "";
    const result = [];
    for (const skill of skills) {
      if (!selected(skill)) continue;
      const location = skill.files ? target?.location?.(skill.pluginId, skill.hash, skill.name)
        : skill.path.startsWith("/") ? skill.path : base ? `${base}/${skill.path}` : undefined;
      if (location) result.push({ name: skill.name, description: skill.description, location, pluginId: skill.pluginId, packaged: Boolean(skill.files) });
    }
    return result;
  }
  function extensions(registry) {
    const plugins = accepted.filter((item) => !item.essential);
    if (registry === undefined) return plugins.filter((item) => item.extension).map((item) => item.extension);
    const state = registries.get(registry);
    if (!state) return [];
    return [...new Set(plugins.map((item) => item.name))].map((name) => state.installed.get(name)).filter(Boolean);
  }
  function selection(base, registry) {
    const plugins = new Set(accepted.filter((item) => !item.essential).map((item) => item.name));
    for (const state of registries.values()) for (const name of state.installed.keys()) if (!accepted.some((item) => item.name === name && item.essential)) plugins.add(name);
    // Without a base list: the registry's own order (session core, then essential groups).
    const coreSelection = base ?? registry?.snapshot().installed().filter((extension) => !plugins.has(extension.name)) ?? [];
    return [...coreSelection, ...extensions(registry)];
  }
  function selects(agentState, extensionName) {
    return !excludes(agentState, [extensionName]);
  }
  function essentialIds() {
    return new Set([...(runtime ? runtime.list() : []).filter((record) => record.essential).map((record) => record.id), ...bundled.map((entry) => entry.pluginId)]);
  }
  function pluginRows() {
    const records = runtime ? runtime.list() : [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const inventory = new Map(installed.map((item) => [item.id, item]));
    const fixed = essentialIds();
    const ids = [];
    const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
    for (const record of records) {
      // Healthy or capability-blocked core plugins are not per-conversation choices; a
      // failed one is shown (fixed, with its reason) because the agent lacks its tools.
      if (fixed.has(record.id)) { if (record.state === "failed" || fallbackOf(record.id) || rejected.some((entry) => entry.pluginId === record.id)) add(record.id); continue; }
      if (seen.has(record.id)) add(record.id);
    }
    for (const item of installed) {
      const record = byId.get(item.id);
      const host = item.registered ? record?.state : item.state;
      if (["failed", "blocked", "restart-required"].includes(host) || ["failed", "blocked"].includes(record?.state)) add(item.id);
    }
    return ids.map((id) => {
      const record = byId.get(id), item = inventory.get(id);
      const mine = accepted.filter((entry) => entry.pluginId === id);
      const errors = rejected.filter((entry) => entry.pluginId === id && !entry.fallback).map((entry) => entry.reason);
      const state = record?.state ?? item?.state ?? "unknown";
      const reason = record?.reason ?? (record ? undefined : item?.reason);
      const own = skills.filter((skill) => skill.pluginId === id).map((skill) => skill.name);
      const fallback = fallbackOf(id);
      return {
        id, name: item?.name ?? id, state, ...(reason ? { reason } : {}), ...(fixed.has(id) ? { essential: true } : {}),
        extensions: [...new Set(mine.map((entry) => entry.name))], tools: mine.flatMap((entry) => entry.tools),
        ...(mine.some((entry) => entry.sections.length) ? { sections: mine.flatMap((entry) => entry.sections) } : {}),
        ...(own.length ? { skills: own } : {}), ...(fallback ? { fallback } : {}), errors
      };
    });
  }
  // Why this essential plugin's bundled copy is in use (setup/stop/validation or create), or undefined.
  function fallbackOf(pluginId) {
    return fallbacks.get(pluginId) ?? [...createFallbacks.values()].find((entry) => entry.pluginId === pluginId)?.reason;
  }
  function describe(agentState) {
    return pluginRows().map((row) => ({ ...row, toggle: !row.essential && row.extensions.length > 0, enabled: row.essential ? true : !excludes(agentState, row.extensions) }));
  }
  function change(agentState, pluginId, enabled) {
    if (essentialIds().has(pluginId)) throw new Error("Built-in agent tools stay on in every conversation.");
    const names = accepted.filter((entry) => entry.pluginId === pluginId && !entry.essential).map((entry) => entry.name);
    if (!names.length) throw new Error("This plugin currently adds no agent tools, prompt sections or skills.");
    return selectionChange(agentState, names, enabled);
  }
  function status() {
    return { connected: Boolean(runtime), settled, late: late && !runtime, ...(unavailableReason ? { unavailable: unavailableReason } : {}) };
  }
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe expects a function");
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  function list() {
    return {
      ...status(),
      registries: registries.size,
      accepted: accepted.map(({ key, pluginId, name, tools, sections, replaces, position, essential, source }) => ({ key, pluginId, name, tools: [...tools], ...(sections.length ? { sections: [...sections] } : {}), replaces: [...replaces], position, ...(essential ? { essential: true, source } : {}) })),
      rejected: rejected.map(({ kind, key, pluginId, name, reason, essential, source }) => ({ key, pluginId, ...(name ? { name } : {}), reason, ...(essential ? { essential: true, source } : {}), ...(kind === AGENT_SKILLS ? { kind } : {}) })),
      skills: skills.map(({ key, pluginId, name, description, path, files, essential, source }) => ({ key, pluginId, name, description, ...(path ? { path } : { files: [...files] }), ...(essential ? { essential: true } : {}), source, ...(mirrorFailures.has(key) ? { failed: mirrorFailures.get(key) } : {}) })),
      fallbacks: [...new Set([...fallbacks.keys(), ...[...createFallbacks.values()].map((entry) => entry.pluginId)])].map((pluginId) => ({ pluginId, reason: fallbackOf(pluginId) }))
    };
  }
  function close() {
    unsubscribeRuntime();
    unsubscribeRuntime = () => {};
    listeners.clear();
    registries.clear();
  }
  return Object.freeze({ connect, unavailable, ready, attach, extensions, selection, selects, describe, change, status, subscribe, list, close });
}
