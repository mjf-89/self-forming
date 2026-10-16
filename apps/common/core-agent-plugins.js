// The app's own agent tools and prompt sections as ordinary built-in plugins
// (docs/plugins.md §9a, Track A steps A2 and A3). Each feature is a plugin folder
// plugins/<id>/ (plugin.json + web/index.js; core-prompt, core-skills, core-workspace-tools,
// core-tools, core-self-update, core-plugin-management, core-servers) whose web entry exports
// its ROW (extension, order, unavailable, tools, create, ...); the generated static registry
// builtin-plugins.js imports them. This module is the engine over those rows: one table
// drives both paths, so they cannot drift apart:
// - createCoreAgentPlugins(): runtime definitions, registered by plugin-builtins.js
//   (createBuiltinPlugins) and consumed by agent-extensions.js;
// - coreAgentContributions(): the same contributions for one session, given to
//   agentExtensions.attach() as the bundled fallback while composition is pending,
//   failed, or lacks a core plugin.
// A fork leaves out a feature by not shipping its plugin folder (§9b), not by editing session.js.
//
// Permanent names: the plugins contribute PARTS of the stored extension names
// "self-forming-native" and "self-forming-workspace". Parts of one name are merged in
// order (core-tools, core-self-update, core-plugin-management), so conversations whose
// pi.agent references "self-forming-native" keep exactly the tools they had.
// A3: core-prompt contributes the whole extension "self-forming-prompts" (the system
// prompt sections of prompt-sections.js, unchanged). Its doc kind
// self-forming.prompt-sections (PromptSelectionDoc: each conversation's chosen sections,
// subagent context, transcript; null = an old helper whose prompt is in its
// instructions) and section keys are permanent. Order -10: its sections come first.
// A3b: core-skills (order -5) adds the part with section "skills" to the same
// extension, after the core sections. The app's own skills are agent.skills
// contributions of the rows that own the feature: self-rebuild (core-self-update) and
// plugins (core-plugin-management), pointing at the existing workspace files
// self-forming/skills/<name>/SKILL.md (no copy).
// A4: core-servers (order 40) contributes the whole permanent extension
// "self-forming-servers" and PROVIDES servers@1 (docs/plugins.md §9c C2). Browser
// edition: available with linuxShell (the session's execution environment must be Linux; tab-bound lifetime).
// A5: core-subagents (order 35) contributes the whole permanent extension
// "self-forming-subagents" (tool subagent, its task and doc kinds), built per session
// from host.harness (agent.harness@1) and host.pi only (plugins/core-subagents/web).
//
// X2: this file is only the merge engine. The tool, server and prompt implementations live
// in the plugins (plugins/core-tools/web/tools.js, core-self-update/web/self-update-tools.js,
// core-plugin-management/web/plugin-tool.js, core-workspace-tools/web/workspace-tools.js,
// core-servers/web/servers.js, core-prompt/web/prompt-sections.js); a row names its module
// with load(), and loadCoreBuilders() merges the loaded modules into the builder bag.
// No library import at module evaluation (plugin-builtins.js imports this file in
// tests without the bundled library); the modules load in setup.
import { AGENT_EXTENSIONS, AGENT_SKILLS } from "./agent-extensions.js";
import { BUILTIN_PLUGINS, builtinPlugin } from "./builtin-plugins.js";
import { definitionShell } from "./builtin-definition.js";

export const NATIVE_EXTENSION = "self-forming-native";
export const WORKSPACE_EXTENSION = "self-forming-workspace";
export const PROMPT_EXTENSION = "self-forming-prompts";
export const SERVERS_EXTENSION = "self-forming-servers";
export const SUBAGENTS_EXTENSION = "self-forming-subagents";
// Declared by the plugin that owns them (plugins/<id>/web/index.js).
const owned = (id) => builtinPlugin(id)?.entry ?? {};
export const SERVER_TASK_KIND = owned("core-servers").SERVER_TASK_KIND ?? "self-forming.server";
export const PROMPT_SECTION_KEYS = owned("core-prompt").PROMPT_SECTION_KEYS ?? Object.freeze([]);
export const SKILLS_SECTION_KEY = owned("core-skills").SKILLS_SECTION_KEY ?? "skills";
// The app's own Agent Skills (skills/<name>/SKILL.md in the source repository, which
// SelfSource restores on every launch). Name and description equal the frontmatter.
export const BUILTIN_SKILLS = Object.freeze({
  selfRebuild: owned("core-self-update").SELF_REBUILD_SKILL,
  plugins: owned("core-plugin-management").PLUGINS_SKILL
});

/**
 * Rows, from the registry: every built-in plugin whose web entry exports `row`, ordered
 * by row.order: id and display name (from plugin.json), target extension name, part
 * order, unavailable(caps, hostInfo, host?) → reason or undefined (host: the session's
 * agent host, only on the session side), tools(caps, hostInfo) → declared tool names,
 * optional sections() → declared section keys, optional tasks() → declared durable task
 * kinds, optional skills(caps) → agent.skills, optional load() → the row's implementation module (lazy import), and create(builders, host) → this
 * session's tools or extension part (null/[] = none for this session). Optional:
 * omit(hostInfo) → true leaves the row out of the page runtime on that host; the
 * manifest's provides + serve(ctx) → services of the runtime plugin (only while
 * available, so a blocked row never conflicts with another provider).
 * host is the session's agent host (see agentHostCapabilities); builders are the
 * exports of the rows' own modules (row.load).
 */
export const CORE_AGENT_PLUGINS = Object.freeze(BUILTIN_PLUGINS
  .filter((item) => item.entry.row)
  .map(({ manifest, entry }) => Object.freeze({
    id: manifest.id, name: manifest.name, ...entry.row,
    ...manifest.provides?.length ? { provides: Object.freeze(manifest.provides.map(({ id, version }) => Object.freeze({ id, version }))) } : {}
  }))
  .sort((a, b) => a.order - b.order));

/**
 * Capabilities of one session's agent host. The page decides them from host.info;
 * a session has exactly what it was given (app.js passes env/appRevision/apkInstaller
 * only when the host reports executionEnv/editableApp/apkInstall), so both agree.
 * host: {hostInfo, env, workspace, appRevision, apkInstaller, pluginHost, projectGuide,
 * harness, pi, servers} (harness: the session's agent.harness@1 handle; pi: the host's
 * pi-durable/pi-ai bag, plugin-pi.js; servers: the session's server binding,
 * servers-service.js createServerSession).
 */
export function agentHostCapabilities(host = {}) {
  return {
    ...host.hostInfo?.capabilities,
    executionEnv: Boolean(host.env),
    editableApp: Boolean(host.appRevision),
    apkInstall: Boolean(host.apkInstaller),
    plugins: Boolean(host.pluginHost)
  };
}

function contribution(row, builders, caps, hostInfo) {
  const tools = Object.freeze(row.tools(caps, hostInfo));
  const sections = row.sections ? Object.freeze([...row.sections(caps, hostInfo)]) : undefined;
  const tasks = row.tasks ? Object.freeze([...row.tasks(caps, hostInfo)]) : undefined;
  // Session-bound contribution (agent-extensions.js): static name/tool/section/task
  // declaration, created per attached session registry from that session's agent host.
  return Object.freeze({ name: row.extension, tools, ...(sections ? { sections } : {}), ...(tasks ? { tasks } : {}), create: (host) => row.create(builders, host) });
}
const keyOf = (row) => `${row.extension}/${row.id}`;
const skillKey = (row, skill) => `skill/${row.id}/${skill.name}`;

/**
 * Runtime definitions (essential: never deselectable per conversation). hostInfo is
 * the page's host.info; a missing capability registers the plugin as blocked with a
 * reason instead of throwing. loadBuilders lazily imports the rows' own modules
 * (loadCoreBuilders: one builder bag, as the session passes it).
 */
export function createCoreAgentPlugins({ selection, subscribe, hostInfo, capabilities = hostInfo?.capabilities ?? {}, loadBuilders = loadCoreBuilders, version = "1.0.0", rows = CORE_AGENT_PLUGINS } = {}) {
  if (typeof loadBuilders !== "function") throw new TypeError("loadBuilders must be a function");
  return rows.filter((row) => !row.omit?.(hostInfo)).map((row) => {
    const reason = row.unavailable(capabilities, hostInfo);
    return {
      ...definitionShell(row.id, { version, provides: reason ? [] : row.provides ?? [], fallback: { essential: true } }), name: row.name,
      ...(reason ? { unavailable: reason } : {}),
      async setup(ctx) {
        const builders = await loadBuilders();
        if (ctx.signal.aborted) return;
        ctx.contribute(AGENT_EXTENSIONS, keyOf(row), contribution(row, builders, capabilities, hostInfo), row.order);
        for (const skill of row.skills?.(capabilities) ?? []) ctx.contribute(AGENT_SKILLS, skillKey(row, skill), skill, row.order);
        row.serve?.(ctx, builders, { selection, subscribe, hostInfo });
      }
    };
  });
}

/** The builder bag: the exports of every row's own implementation module (row.load()), merged. */
export async function loadCoreBuilders(rows = CORE_AGENT_PLUGINS) {
  const modules = await Promise.all(rows.filter((row) => typeof row.load === "function").map((row) => row.load()));
  return Object.assign({}, ...modules);
}

/**
 * The same contributions, synchronously, for one session (bundled fallback).
 * builders: the rows' module exports in one object (loadCoreBuilders()).
 * [{pluginId, name, key, order, value}] for every row whose capability exists.
 */
export function coreAgentContributions({ host = {}, builders, rows = CORE_AGENT_PLUGINS } = {}) {
  if (!builders) throw new TypeError("coreAgentContributions needs the builders (loadCoreBuilders())");
  const caps = agentHostCapabilities(host);
  return rows.filter((row) => !row.unavailable(caps, host.hostInfo, host)).map((row) => ({
    pluginId: row.id, name: row.name, key: keyOf(row), order: row.order, value: contribution(row, builders, caps, host.hostInfo)
  }));
}

/**
 * The app's own skills for one session (bundled fallback of the rows' agent.skills
 * contributions): [{pluginId, name, key, order, value, kind: "agent.skills"}].
 */
export function coreSkillContributions({ host = {}, rows = CORE_AGENT_PLUGINS } = {}) {
  const caps = agentHostCapabilities(host);
  return rows.filter((row) => !row.unavailable(caps, host.hostInfo, host)).flatMap((row) => (row.skills?.(caps) ?? []).map((skill) => ({
    pluginId: row.id, name: row.name, key: skillKey(row, skill), order: row.order, value: skill, kind: AGENT_SKILLS
  })));
}
