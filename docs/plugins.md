# Self Forming plugin architecture

Status: implementation design, revision 3. Supersedes drafts 1–2, including their approval/capability system. No implementation is implied by this document. Implementation starts with milestone M1 below; later milestones are explicitly separate.

## 1. Decision and trust model

Self Forming is a host composed from replaceable feature plugins. Built-ins and locally authored plugins use the same service and contribution interfaces. Built-in does not mean dynamically loaded: a Kotlin implementation may ship compiled into the APK or be loaded from dex.

Plugins are trusted application code. There is NO per-plugin authorization, approval dialog, permission capability layer, or special development mode. An agent can build, install and activate plugins automatically. A hash identifies a revision and checks integrity; it never grants authority. Dependency declarations are composition metadata, not security restrictions.

Existing Android permissions, APK installation confirmation, credential-store protections, execution secret scopes and destructive-data confirmations remain unchanged. Trusted same-process code is not sandboxed from other plugins, host internals or app data. Do not advertise namespacing or a restricted API as a security boundary.

## 2. Host versus features

Host mechanisms: bootstrap; source loading; service binding; contribution registries; scope/lifecycle management; JS/Kotlin transport; revision identity; safe startup/recovery. Android component declarations and permission enforcement remain in the host APK.

Feature plugins: agent sessions; providers; HTTP adapter; credentials UI/backend; storage adapter; execution/workspace; chat; conversations; settings contributions; attachments; subagents; supervised servers; self-modification.

The target is feature ownership, not one plugin per file. Recovery must work with zero feature plugins. Neither database contents nor credentials are moved during initial extraction.

## 3. Plugin identities and package format

IDs match `[a-z][a-z0-9-]{1,63}`. IDs identify logical features, revision hashes identify immutable code. Built-in IDs use `core-` by convention, not as a protected namespace. Explicit replacement is allowed. No implicit last-writer-wins service conflicts.

Editable sources: `<workspace>/plugins/<id>/`. Only shipped files are loaded, never a source tree halfway through a build.

```
plugin.json
web/index.js                 optional plain browser ESM (no framework/build required)
native/src/...               optional Kotlin sources, not shipped
native/module.jar            optional dex jar
```

Manifest example (M1):

```json
{
  "id": "counter",
  "name": "Counter",
  "version": "0.1.0",
  "api": 1,
  "web": { "entry": "web/index.js" },
  "native": { "jar": "native/module.jar", "class": "plugins.counter.CounterModule" },
  "reload": "restart",
  "provides": [{ "id": "counter.value", "version": 1 }],
  "requires": [],
  "uses": []
}
```

`provides/requires/uses`: arrays of `{id, version}` with exact positive-integer major contract versions in M1. `reload`: `scope` for cooperative web-only features, `page` for web features requiring page recreation, `restart` for native code or process-owned resources. Unknown API versions fail with an actionable error.

A package needs at least one facet. `web.entry` must be beneath `web/`; native jar beneath `native/`. Absolute paths, `..`, symlinks, duplicate IDs in an activation set and excessive sizes are rejected as integrity/error checks, not authorization. M1 limits: 64 MiB shipped total, 4096 files, 1 MiB manifest. Shipped files: plugin.json, web/**, native/module.jar. Hash canonical sorted path/digest records (UTF-8 relative path + NUL + lowercase SHA256 + LF). Publication uses a temporary directory and atomic rename. Reject stale/changed input while staging.

Installed snapshots belong to `<filesDir>/plugins/installed/<id>/<hash>/`; registry/pointers stored separately with atomic writes. Writable data belongs to `<filesDir>/plugins/data/<id>/`. Plugin code snapshots are read-only, including dex marked read-only before bytes are written through an already-open descriptor, following Android's dynamic-code-loading requirements. Reverify before load. These locations are not a sandbox against same-UID code.

## 3a. Built-in plugins as packages

Built-ins use the package format above and live in the repository as `plugins/<id>/` (this folder is NOT the workspace folder `<workspace>/plugins/<id>/` of editable sources; it is part of the app source):

```
plugins/<id>/plugin.json     as §3, plus "builtin": true, "essential": true (where applicable), "bundle": "<bundle id>"
plugins/<id>/web/index.js    the web entry
plugins/<id>/web/*.js        implementation modules that plugin owns (core-providers-claude/web/provider.js, core-servers/web/servers-service.js, ...)
```

- Entries: `core-execution` and `core-agent` export `create(options)` returning the definition parts (`setup`, optionally `provides`) because the page injects what they wrap (`openExecution`, the sessions/harness facades). The agent rows (`core-prompt`, `core-skills`, `core-workspace-tools`, `core-tools`, `core-self-update`, `core-plugin-management`, `core-servers`) export `row` (extension, order, `unavailable`, `tools`, `create(builders, host)`, ...), consumed by `core-agent-plugins.js`; `core-providers-*` export `provider` {mode, order, lazy `load`}, consumed by `core-providers.js`/`plugin-builtins.js`. The manifest provides id, `reload`, `essential`, `provides/requires/uses` (`builtin-definition.js` turns it into the runtime definition); the code never repeats them.
- Native half: `plugins/<id>/native/src/**.kt` (package `md.incept.selfforming`, compiled statically into the APK through the Gradle source sets, never dex-loaded), optional `native/manifest.xml` fragment (components/permissions the plugin owns, merged by `addStaticManifestFile`), tests in `native/test` and `native/androidTest`. Today: core-execution, core-plugin-management, core-providers-chatgpt, core-self-update (docs/plugins-providers-agent-core.md §J). `apps/android` keeps the host (MainActivity, NativeBridge routing, recovery, the SDK). `pack-source.sh` and the source exports include `plugins/*/native` like the rest of `plugins/`.
- Shared engine modules stay in `apps/common` (`session.js`, `session-providers.js`, `agent-extensions.js`, `agent-providers.js`, `plugin-runtime.js`, `core-agent-plugins.js`, `core-providers.js`, `plugin-builtins.js` ...).
- Registry: `apps/common/builtin-plugins.js` is generated by `scripts/gen-builtins.sh` (jq only, sorted, deterministic, checked in; `--check` fails when stale, run by `web-lite.sh`, `build-browser.sh`, `build.mjs` and `tests/plugin-builtin-registry.test.mjs`). It imports every `web/index.js` statically and embeds each `plugin.json`, so start-up and the bundled fallback of every session stay synchronous. Entries must not import `library/` at evaluation (lazy `import()` in `setup`/`load`). Built-ins never go through `plugins.install`; an installed plugin may still replace one explicitly (§1).
- Served path: `builtin/<id>/web/**` next to the app files (`/assets/web/builtin/<id>/web/index.js`). `plugins/` cannot be used: on Android every request below `/assets/web/plugins/` goes to `PluginHost.openAsset` (installed snapshots `/assets/web/plugins/<id>/<hash>/web/...`) and never reaches the app store. Plugin sources therefore import shared modules and the library by their served paths from `builtin/<id>/web/` (`../../../agent-extensions.js`, `../../../library/pi-ai.js`; a sibling plugin as `../../<id>/web/x.js`), which makes them runnable in the served layout only, like `library/` today. Tests use `tests/plugin-agent-support.mjs` `assembleApp()` (apps/common + `builtin/` + library).
- Packaging: `web-lite.sh` and `build.mjs` copy `plugins/*/web/**` to `dist/app/builtin/<id>/web/**` and list the files as `editableFiles` in `app-manifest.json` (so they are editable and revisioned like the app files; `WebAppStore` accepts nested names); `build-browser.sh` copies them to `builtin/` in the output and lists them in its manifest; `pack-source.sh` packs the `plugins/` root. `plugin.json` is source only (not served).
- Live copy (`app_update` `sourcePath`): the store walks subdirectories (limits 256 files, 4 MiB per file, 16 MiB per revision; no symlinks; fixed names `library/`, `native-host.js`, `app-manifest.json`, `app-source-README.md` refused). Copy `apps/common/*.js|css|html` and the `builtin/` tree (34 files, ~0.9 MB today; 77 files in total), and delete files that left `apps/common` (`core-provider-*.js`, `servers-service.js`, the old top-level modules of the other moved plugins). `scripts/sync-builtins.sh to-live|from-live <sourcePath>` does this. An APK built before a new built-in listed it in its manifest still accepts it (extra files are served); an APK that lists `builtin/**` requires them in the source folder, which a new host version seeds itself.

## 4. Composition model

A service is `{id, version, providerId, implementation}`. Consumers declare hard `requires` or optional `uses`. Dependencies resolve before activation; providers activate before consumers, teardown reverses that order. Missing hard dependencies and cycles block affected plugins with reasons, not the whole app. Optional absence yields null. Duplicate providers are a conflict unless the composition explicitly selects one.

A contribution registry collects entries with stable keys and explicit order: tools, views, settings sections, model providers, commands. Registrations belong to a scope. Closing a scope removes every entry it owns. Core and external plugins contribute identically. Overrides are explicit configuration, not load-order accidents.

Local services are ordinary JS objects or Kotlin interfaces. Do NOT serialize local calls. Remote services use the native transport adapter. No attempt to port the complete Chord runtime to Kotlin in M1.

Contract versioning (decided): a contract version is ONE positive integer, matched exactly (`counter.value@1`). No minor numbers, no ranges. A compatible change (new method, bug fix) keeps the number; a breaking change (rename/remove a method, change meaning or required input) bumps it. A consumer that relies on a later addition must check for it at runtime (feature detection, e.g. via the methods listed in the contract file) or the provider bumps the number. A provider may offer several versions at once during a transition. Plugin release versions (`plugin.json` `version`) are separate, for people and updates only, and never used for compatibility.

Future contract files use a precisely supported JSON Schema dialect and validate both directions. M1 service versions and request-shape checks do not claim full schema validation. Unsupported schema keywords must eventually fail, never silently pass.

## 5. Web runtime contract (M1)

New `apps/common/plugin-runtime.js` exports `createPluginRuntime({onError})`. Returned runtime supports:

- `register(definition)` with `{id, version, provides, requires, uses, reload, setup(ctx)}`.
- `start()` activates registered features in dependency order and returns per-plugin status.
- `stop(id)` stops that feature and its hard dependents; `close()` releases all scopes.
- `list()` returns diagnostic state; `service(id, version=1)` resolves selected active provider or null.
- `contributions(kind)` returns active keyed contributions; `subscribe(listener)` returns unsubscribe.

Setup context:
- `provide(id, version, implementation)` fulfills a declared service.
- `get(id, version=1)` resolves a declared dependency, null for absent optional use.
- `contribute(kind, key, value, order=0)` registers an owned contribution, returns dispose.
- `cleanup(fn)`, `signal`, managed `setInterval`/`setTimeout`, `id`, `version`.

`setup` may return cleanup. Cleanup is idempotent, reverse registration order, with per-error reporting and continued cleanup. A failed setup removes partial registrations. A 5-second async readiness deadline blocks only that plugin; abort its scope and ignore/dispose late completion. This does NOT interrupt synchronous JS loops; recovery needs page restart and a startup watchdog. Do not claim general exception containment.

Host compatibility rule (tool results, since the pi-durable 1.3.0 upgrade, APK 0.6.5): pi-durable 1.2.0 renamed `ToolExecutionResult.content` to `output` (CHANGELOG 1.2.0 "Breaking Changes"); a tool should answer `{ output: [...] }`. A tool still answering `{ content: [...] }` (written for the 1.0.x host) keeps working: every extension the agent extension adapter installs (`apps/common/agent-extensions.js` `compatibleExtension`) has its tools wrapped so that a result with `content` and no `output` is passed on as `output`. The wrap stays for installed plugins; built-ins answer `output` (core-subagents until its owner migrates).

External `web/index.js` exports `setup(ctx)` (or default `{setup}`). `plugin-client.js` loads installed web facets by immutable URL, not blob/eval. `ctx.native.call(method, input)` uses `plugins.call` with plugin id and pinned revision hash. Native-only packages are legal; tools can call them via management tooling. Attach host libraries through supplied adapters; do not copy pi-durable into plugins.

## 6. Kotlin SDK and host (M1)

Single source of SDK ABI: `apps/android/app/src/main/java/md/incept/selfforming/plugin/PluginApi.kt`.

```kotlin
package md.incept.selfforming.plugin
interface PluginModule {
    fun start(context: PluginContext)
    fun call(method: String, input: org.json.JSONObject): Any?
    fun stop()
}
class PluginContext(
    val appContext: android.content.Context,
    val id: String,
    val dataDir: java.io.File
)
```

The compiler tool emits a host-api.jar from exactly this source. Plugins compile against android.jar, host-api.jar, and the host Kotlin stdlib (2.2.20), but do not bundle them. Native code executes via an executor, never on Android's UI thread. Platform UI operations must explicitly dispatch to main. Exceptions become bounded structured failures. Runtime method cancellation is cooperative and not present in this minimal ABI; stop/timeout is not proof an operation was undone.

Host class loader is the parent of a plugin DexClassLoader, with one loaded instance per selected revision. On Android 14+, loaded dex must satisfy read-only rules. No security classloader filtering claim. Native revision changes require an app process restart in M1; never promise class unloading. Installation and selection are allowed immediately, activation is reported as restart-required when needed.

Built-in service implementations should later register through the same native registry; M1 adapts the existing host execution service on the web side without rewriting its backend.

## 7. Transport and native management API (M1)

Reuse existing `bridge.call` for low-rate commands. No new unknown events are sent through the fixed native-host.js validator. Events/binary lanes are deferred until benchmarked; do not disguise events as command output.

`plugins.*` methods:
- `plugins.list {}` → `{api:1, plugins:[{id,name,version,hash,enabled,state,reason?,web?,native?,provides,requires,uses,reload}]}`.
- `plugins.install {path}` → `{id,hash,state,restartRequired}`. Stages source, selects immutable snapshot, preserves previous pointer. No approval. Loading happens at safe lifecycle points.
- `plugins.enable {id}` / `plugins.disable {id}` → `{id,state,restartRequired}`.
- `plugins.call {id,hash,method,input}` → JSON result. Reject revision mismatch. No automatic retry.
- `plugins.rollback {id}` → `{id,hash,state,restartRequired}` selects previous snapshot, no data rollback claim.

States: installed, active, disabled, blocked, failed, restart-required. Return relative `web.entry` and manifest metadata; client constructs URL below. Do not delete plugin data in M1. Disabled is not an instantaneous revocation of arbitrary same-process code.

Serve installed web code at `/assets/web/plugins/<id>/<hash>/web/...`. Resolve only selected/pinned installed snapshots, canonical paths, proper MIME, nosniff. This path is within the existing script-src self policy and asset origin. Never serve writable data, keys or registry as executable assets. Page pins loaded hashes, old snapshots retained while in use.

Later: binary message support with feature checks; streaming file responses with cancellation/range semantics where needed. (The events channel exists from 0.6.0, §7a.) Native media rendering avoids transporting frames. No claimed round-trip latency until measured.

## 7a. Native lanes added in APK 0.6.0 (Track B part 1)

Additive only; 0.5.x plugins (e.g. the counter, built against the old SDK) load unchanged. Every item is feature-detected through `host.info.capabilities`.

- **Events (`pluginEvents`).** `PluginContext.emit(event, data): Boolean` (Kotlin, any thread; names `[A-Za-z][A-Za-z0-9._:-]{0,63}`, data ≤ 64 KiB JSON) → page `ctx.native.on(event, (data, {event, seq, dropped}) => …)` returns `off`; listeners are released with the plugin scope; `ctx.native.events` tells whether the host has the lane (otherwise `on` is a no-op). Transport: a second WebMessage listener object `PiPlugins` (main frame + app origin only, like `PiNative`), so the fixed `native-host.js` validator never sees plugin traffic. The page sends `{type:"listen", page:<random token>, plugins:[ids]}` whenever its set of listened plugins changes; the host (`PluginEvents.kt`, process-owned) delivers `{type:"event", page, plugin, hash, event, data, seq, dropped}` only to the current page epoch (replaced on every page start), in order, in bounded main-thread batches. Bounded queue (256 events / 2 MiB); events are dropped and counted (`dropped`, a running total) when no page listens to that plugin, when the queue is full, or when the page changed before delivery. Never stored for a later page, never replayed. Old SDK hosts lack `emit` (NoSuchMethodError).
- **File reads (`pluginRead`).** `plugins.read {id, hash, path, encoding?: "auto"|"text"|"base64"}` → `{path, size, encoding, text|data}`. Same revision rules as served assets: this document's pinned hash, else only the enabled, selected revision (fully reverified; the read pins it for the page). Canonical relative path beneath `web/`, ≤ 1 MiB. Web: `ctx.native.readFile(path, {encoding})` for a plugin's own revision; `plugin-skills.js` `servedSkillSource()` uses it (via `plugin-client.js` `pluginFiles()`) for `{files}` skills. Serving at `/assets/web/plugins/...` is unchanged; the page CSP is unchanged.
- **Plugin credentials (`pluginCredentials`, decision §F.1 of docs/plugins-providers-agent-core.md).** `auth.info/load/save/clear` accept `provider: "plugin:<pluginId>:<name>"` (`<pluginId>` = plugin id pattern, `<name>` = `[a-z0-9][a-z0-9._-]{0,63}`); other `auth.*` methods refuse it. One AES-256-GCM record per credential in `no_backup/plugin-auth/<pluginId>/<name>/credentials.aesgcm`, own Android Keystore key `md.incept.selfforming.plugin.v1.<pluginId>.<name>`; record ≤ 64 KiB JSON. `auth.save {provider, record}` → null; `auth.load {provider}` → record or null; `auth.clear {provider}` deletes record and key; `auth.info {provider}` → `{storage:"encrypted", saved}` (no host id for plugin records). ChatGPT/Claude records unchanged. Readable by app code (trusted plugins), like the sign-in tokens; never passed to agent commands. No web helper yet (P5).
- **HTTP allow-list (`httpAllowList`, decision §F.2 / §B3 `core-net-native`).** `http.allowList.get {}` / `http.allowList.set {entries:[url,…]}` → `{entries, max: 32}`. Entries are `https://host[:port]/path-prefix` (https only; DNS host; no user, query, fragment, `%`, `//`, `.`/`..` segments; the fixed OpenAI/Anthropic/OAuth hosts cannot be listed). `set` replaces the whole list atomically (all-or-nothing) in `no_backup/http-allow-list.json`; a corrupt file means no extra endpoints. `NativeHttpPolicy` permits a request to a listed endpoint (host + port match, path prefix on a segment boundary, methods GET/POST/PUT/DELETE/HEAD, queries allowed, no dot/encoded-slash paths, no redirects as before) in addition to its fixed endpoints, whose rules are never relaxed. The page CSP is unchanged: listed endpoints are reached through the native fetch (`createNativeFetch`), not page `fetch`. Settings UI later.

## 8. Reload and failure semantics

Stages: validate → stage immutable snapshot → select at safe boundary → activate → mark healthy. Keep previous revision. Failed hashes do not auto-loop on startup; explicit retry/changed hash required. Persistent startup marker identifies uncertain native startup, disables suspect revision on next boot, and permits fallback only if safe. Crash attribution is best effort; OS process death can produce false positives, so report suspected failure rather than asserting plugin culpability.

No universal transaction: module imports and constructors can have side effects; stop/start can fail; external actions and database migrations cannot be magically rolled back. In M1 there are no automatic data migrations. Preserve data, require an explicit migration strategy before changing storage format. In-flight calls whose transport disappears have UNKNOWN outcome, not guaranteed failure; never replay mutations automatically.

Native recovery can disable all external plugins without loading them. Bundled recovery and essential host bootstrap stay independent. Core service replacements initially take effect on page/process restart. Keep bundled fallback composition available. Do not stop an active durable session merely to update a plugin: coordinate at existing saved-session/reload boundaries; side-effectful pending tool tasks must not silently resume under incompatible code.

## 9. Everything-as-plugin migration

M1 (implement now):
1. Generic web runtime with services, dependency ordering, scopes, contribution registries and failure diagnostics.
2. Built-in definitions for the execution adapter, using existing implementations. Demonstrate ordinary service calls and registry consumption, not just decorative plugin metadata.
3. Native package staging/loading/calls/recovery and external web package loading.
4. Minimal counter example with web and Kotlin facets, standalone compiler tooling and contract tests.
5. Main-agent integration into boot/session/agent tools; APK only after checks.

M2: extract tools/providers/subagents/servers and settings/chat/navigation to feature plugins, replace hard-coded catalogs with registry adapters. Retain existing pi-durable names/storage compatibility.

M3: agent sessions, credentials, storage and native execution as replaceable service plugins. Explicit provider selection and tested restart/rollback policies. Core extraction is not declared complete until consumers actually use contracts rather than old globals/imports.

M4: shared native screen host, device features, binary/streaming transport, background service lifecycle. New Android permissions added for concrete features, not a blanket speculative manifest.

## 9a. pi-durable as plugins (M2 design, decided)

Two layers. The Harness (storage, registry, task runtime, recovery, session lifecycle) is ONE page-owned service provided by `core-agent`; it is not split. pi-durable extensions (tools, sections, hooks, wraps, tasks, docs) are the plugin-shaped unit: plugins contribute them and `core-agent` turns contributions into `registry.install()` / `registry.uninstall()`.

Services and contribution kinds:
- `agent.sessions@1` (chat-facing: send, stop, snapshot, tree, switch, drafts), `agent.harness@1` (snapshot docs, abort tasks, open conversations) - provided by `core-agent`.
- `agent.extensions` (a pi-durable extension object built with the host's pi-durable from `ctx.pi`), `agent.providers` (model providers + credential hooks), `agent.sections` (prompt sections).
- Extraction order: `core-workspace-tools`, `core-tools` -> `core-prompt` -> `core-self-update` -> `core-servers`, `core-subagents` -> `core-providers-*` -> `core-agent`; chat then becomes a plugin on `agent.sessions@1`.

Implemented (A1, A2):
- A1: `agent-extensions.js` installs `agent.extensions` contributions into each session registry; `ctx.pi` (`plugin-pi.js`) gives plugins the host's pi-durable; readiness barrier ≤5 s; per-conversation exclusions in pi.agent `extensions.remove`; Settings → Plugins (`plugin-settings.js`). Verified on device with the counter plugin's `counter_value` tool.
- A2: `plugins/core-workspace-tools|core-tools|core-self-update|core-plugin-management` (rows; engine `core-agent-plugins.js`, §3a) define essential built-ins `core-workspace-tools` (extension `self-forming-workspace`), `core-tools`, `core-self-update`, `core-plugin-management`. The last three are merged, in that order, into the ONE permanent extension `self-forming-native` (pi-durable silently drops unknown stored names, so splitting the name would break stored selections). Definitions may carry `essential: true` (not deselectable, only built-ins) and `unavailable: "reason"` (blocked, setup never runs; set from missing host capabilities). Session-bound contributions `{name, tools, create(host)}` build tools per session. Each session installs bundled core contributions synchronously before the Harness opens, so core tools never wait for or depend on plugin composition; the runtime's copies replace them in place when composition connects. `tests/plugin-a2-tools.snapshot.json` pins the tool lists; regenerate only on purpose (`plugin-a2-capture.mjs`).
- A3: essential built-in `core-prompt` (order -10, no capability needed) contributes the permanent extension `self-forming-prompts` built by the unchanged `createPromptExtension`; doc kind `self-forming.prompt-sections` and the 7 core section keys are permanent. Plugins add prompt sections through their `agent.extensions` (`sections`); they come after core sections, are removed by per-conversation exclusion, and may take a core or another plugin's key only with explicit `replaces` (one replacement per key; a replaced core key keeps its position and follows the conversation's section selection). `tests/plugin-a3-prompts.snapshot.json` pins rendered prompts (regenerate on purpose with `plugin-a3-capture.mjs`). The section `plugins` (develop the app through plugins; Android and browser variants chosen from `nativePlugins`/`platform`) is such a plugin section: `core-plugin-management` ships it with the `plugins` tool (`plugins-prompt.js`); `core-prompt` lists the name in `MAIN_PROMPT_SECTIONS` only so conversations and subagent `context` can select it. The `app` section ends with one line pointing to it.
- Core fallback: an essential contribution's runtime copy is used only while healthy (plugin active, value valid, `create(host)` succeeds, registry accepts); otherwise the session keeps/reinstalls the bundled copy and reports "Failed: <reason> (using built-in copy)" (`list().fallbacks`). Essential plugins still cannot be disabled.
- A3b skills: contribution kind `agent.skills` (`{name, description, path}` workspace file | `{files}` from the installed snapshot | `{contents}` inline). Plugin packages ship skills under `web/skills/<name>/SKILL.md` (the host only hashes/serves `plugin.json`, `web/**`, `native/module.jar`; a top-level `skills/` is rejected by `plugin.sh check`). Essential `core-skills` adds the `skills` section to `self-forming-prompts` (after core sections, only when the conversation has `read`). `plugin-skills.js` copies active plugins' skills to `<workspace>/.skills/<id>/<name>/` (chmod a-w best effort; no effect under PRoot). A skills-only plugin contributes an empty extension named `skills:<pluginId>` - PERMANENT identifier (stored in exclusions). `{files}` is read through the bridge method `plugins.read` on hosts with capability `pluginRead` (Android 0.6.0+, §7a); Android before 0.6.3 refuses the served-URL fetch (its CSP lacked `connect-src 'self'`; since 0.6.3 (N4) it has `'self'` plus the cors-rot relay origins in `BrowserConnections.kt` `RELAY_CONNECT_SRC`), so packages that must also work there use `{contents}`.
- A4: essential built-in `core-servers` (order 40; omitted on the browser platform) contributes the permanent extension `self-forming-servers` (tool `manage_server`, task kind `self-forming.server` v2, doc kind `self-forming.servers`) and provides `servers@1` (`plugins/core-servers/web/servers-service.js`): start/stop/restart/status/logs with exactly the tool's results and errors; `status()` adds `persistent: true`. The implementation is built once per session so bundled/runtime copies share task and tool objects (no relaunch on swap). Pending Server tasks resume through the bundled copy installed before the Harness opens.
- P0–P2, C0–C1 (see docs/plugins-providers-agent-core.md): provider behaviour pinned by `tests/plugin-p0-*`; static rows `plugins/core-providers-*/web/provider.js` and engine `session-providers.js`; contribution kind `agent.providers` (`agent-providers.js`) with essential built-ins `core-providers-*` and per-row bundled fallback; `core-agent` provides `agent.sessions@1` (`agent-sessions.js`, contract in `agent-contracts.js`, Reload now).
- C3 (docs/plugins-providers-agent-core.md §C3): `session.js` is split by verbatim moves into `session-tail.js` (chat rendering, conversation tail), `session-threads.js` (ThreadsDoc/AttachmentDoc, metadata queue, drafts, attachments, rename/archive/unarchive), `session-tree.js` (tree, owned naming) and `session-engine.js` (Harness open/close, storage, registry, send/stop/resume); `session.js` only re-exports the same public API.
- C3d: `core-agent`'s setup opens the page's sessions (`plugins/core-agent/web/open-sessions.js`) through the page controller (`begin`); app.js only gives session options and mounts the chat on `agent.sessions@1`. If composition fails, core-agent does not begin, or composition is not ready within 5 s, app.js uses the bundled core-agent copy. App-update activation still awaits `closeForReload`.
- A5: essential built-in `core-subagents` (order 35, needs an execution environment, bundle `self-forming-tools`) contributes the whole permanent extension `self-forming-subagents` (tool `subagent`, task kinds `self-forming.subagent-anchor/-reporter/-stop`, doc kinds `self-forming.subagents`, `self-forming.subagent-operation`; `plugins/core-subagents/web/subagents.js`, formerly `apps/common/subagents.js`, behaviour unchanged). Its session-bound `create(host)` uses only `host.harness` (agent.harness@1: `models`, `tools`, `prompt`, `abortTask`, `abortSubmission`) and `host.pi`; the session engine no longer imports it. Built once per session (keyed by the harness handle) so bundled and runtime copies share task and tool objects; the bundled copy is installed before the Harness opens, so pending subagent tasks resume as before. Additive: the session agent host carries `pi` (the `ctx.pi` bag), and `ctx.pi` gains `AgentDoc`, `LiveDoc`, `InboxDoc`, `AssistantEntry`, `configure`. The conversation tree names subagents from a read-only view of the permanent doc `self-forming.subagents` (`session-tree.js`); without the plugin they show as unnamed tasks. Tests: `tests/plugin-a5-core-subagents.test.mjs`.

- L2 (APK 0.6.1): built-in plugins own their Kotlin half in `plugins/<id>/native` (§3a, docs/plugins-providers-agent-core.md §J).

Persistence rules:
- Existing extension names (`self-forming-native`, `-subagents`, `-servers`, `-workspace`, prompt extension) and doc/task kinds (`self-forming.threads`, `.subagents`, `.prompt-sections`, ...) are permanent identifiers. Plugin ids may differ; the names they contribute never change. Doc/task shape changes bump the doc version and migrate.
- Tool names are unique across contributed extensions. A plugin replaces another plugin's tool only by declaring the replacement explicitly; never pi-durable's silent last-wins.
- Tools declare `replay` honestly (safe/unsafe).

Decisions (user, 2026-10-14):
1. **Per-conversation plugin selection.** Each conversation can select its own subset of plugins. Default: everything. Stored with pi-durable's per-conversation agent configuration as EXCLUSIONS ("all except ..."), so newly installed plugins appear in conversations that have not excluded them. Subagent/task conversations start as a copy of their owner's selection (pi-durable behaviour). Plugins the agent itself needs to run (`core-agent`, chosen provider) cannot be deselected. Selection affects which contributed extensions a conversation uses; it does not stop the plugin for other conversations.
2. **Disabling a plugin with pending durable work: warn.** Show which conversations/tasks are waiting (e.g. "2 pending tasks wait for core-servers"); then proceed if confirmed. The tasks wait and resume when the plugin is enabled again.
3. **Hooks and wraps: allowed for every plugin** (trusted model). Order is explicit (plugin composition order, deterministic and shown in diagnostics), never accidental.

When changes apply: tool/section/hook plugins between steps (running calls finish on old code); task-bearing plugins for new work, pending tasks at their next phase; provider plugins at the next model request; `core-agent` itself only through the save-close-reload path used by app updates.

## 9b. Fork and release (target workflow, later milestone M5)

Workflow: start Self Forming -> shape an app through plugins -> fork it into a standalone app -> release it (e.g. Google Play). The fork is a frozen product grown by Self Forming, not a copy of Self Forming.

Freeze step (`scripts/fork.sh <name>`, agent-driven):
1. Select the plugins (core + installed) that make up the product; resolve the dependency graph; refuse missing/blocked/conflicting services.
2. Native facets: copy Kotlin sources into the fork's Android project and register them in a generated static registry (same `PluginModule`/service interfaces, no DexClassLoader). Web facets: copy into the fork's bundled web files as built-in definitions.
3. Generate real manifest entries from plugin metadata (screens -> activities, declared permissions, later services/entry points), instead of the generic screen host.
4. New identity: applicationId, app name/icon, its own signing key (never Self Forming's), versionCode/versionName, release build as an Android App Bundle.
5. Edition profile switches off self-forming capabilities that a store build cannot or should not ship: dynamic plugin loading, `app_update`, `app_install_apk` and REQUEST_INSTALL_PACKAGES, likely the Ubuntu/PRoot runtime and shell tools (store rules on downloaded executable code; to be reviewed against the current policy text before any release). Whether the agent stays in the product, and with which tools/providers, is a per-fork choice.
6. Carry data/migration notes; a fork starts with fresh storage unless an import is designed.

Rules for work done NOW so forking stays possible:
- Every plugin must also work as a built-in: no behaviour may depend on being dex-loaded, on snapshot paths, or on the workspace source folder at runtime.
- Host capabilities are feature-detected (`host.info.capabilities`), never assumed, so a fork can omit them (shell, self-update, plugin loading) and dependent plugins report blocked instead of breaking.
- Self-forming-only features live in their own plugins (`core-self-update`, `core-tools` shell parts, plugin management), so a fork excludes them by not selecting them.
- No secrets, credentials or Self Forming signing material ever enter a fork.

## 9b2. Bundles (planned)

Plugins stay the unit of failure, capability gating and replacement (each core feature is its own plugin so it can be blocked per host, dropped by a fork, swapped for another provider, and fall back on its own). Bundles are the unit people see and pick:
- A bundle is a named, versioned list of plugin ids (`self-forming-core`: what every conversation runs on - agent sessions, model providers, prompt, skills, workspace and file/shell tools, execution; `self-forming-tools`: optional extras a fork can leave out - self-update, plugin management, servers, subagents; plus a fork's own product bundle). Bundle ids and display names are the same lowercase hyphenated names. Bundles carry no code and add no dependency semantics; the runtime still resolves each plugin.
- Settings → Plugins shows each bundle as one collapsed row ("self-forming-core · 9 · all active"), expanding to its plugins, and expanded automatically when a member is not active.
- The fork step (§9b) selects bundles plus individual plugins.

## 9c. Cross-host contracts (browser edition)

The browser edition (`apps/browser`, owned by the browser-edition conversation) runs the same web app, plugin runtime and built-ins. Hosts differ only in which providers and capabilities they offer. Contracts below are shared; each host implements its side.

### C1. Installing web-only plugins in the browser
- Host advertises `capabilities.plugins: true`, `capabilities.nativePlugins: false`; Android advertises `nativePlugins: true` (from 0.6.0, together with `pluginEvents`, `pluginRead`, `pluginCredentials`, `httpAllowList`; see §7a).
- Same management calls and JSON shapes as §7: `plugins.list/install/enable/disable/rollback`; `plugins.call` is refused (`PLUGIN_UNAVAILABLE`, "needs the Android app").
- Install source: a folder in the browser workspace (`/workspace/plugins/<id>`). Uses the M1 manifest/schema, content, digest and size/count contracts from `scripts/plugin.sh check`, with stricter canonical browser paths as detailed below (no symlinks). A package with a `native` facet is REJECTED with reason "needs the Android app" (never half-installed, never stripped).
- Revision hash: the same canonical algorithm (sorted UTF-8 relative path + NUL + lowercase SHA-256 of contents + LF, over plugin.json and web/**), computed with WebCrypto, so the same package hashes identically on both hosts. Share one implementation module.
- Storage: immutable snapshots in IndexedDB (or OPFS) keyed by id+hash; registry with selected/previous pointers; atomic updates.
- Browser implementation: `plugins/core-plugin-management/web/browser-plugin-{host,package,store,serving}.js`. IndexedDB database **`self-forming-browser-plugins-v1`**, version 1, contains `snapshots` (id/hash → immutable manifest+bytes) and `selections` (id → selected hash, previous hash, enabled). Both publish in one transaction; quota/abort never selects an incomplete snapshot. Management startup probes a committing write; SW reads open without that probe, so exhausted write quota does not prevent serving previously published code. Each response currently revalidates and hashes the snapshot (bounded at 4096 files/64 MiB); no verification cache is claimed. No existing workspace, auth, JSONL or host-ID keys change. Snapshots are retained (no automatic garbage collection), including disabled/previous revisions, so already-loaded pages can finish relative imports and asset reads.
- Serving: Android retains `/assets/web/plugins/<id>/<hash>/web/...`; the browser uses **`<deployment-scope>/assets/web/plugins/<id>/<hash>/web/...`**, reported by `host.info.pluginAssetBase` (root deployments match Android). The SW serves only verified stored bytes with accurate MIME and nosniff, before editable revisions; misses, malformed/encoded separators, queries and fragments fail closed without network fallback. Relative ESM/CSS/assets use ordinary same-origin URLs, not Blob URLs.
- Capability gating requires a durable store plus a controlling SW with an installed-serving handshake. First-load controllerchange is awaited without reloading. Unsupported storage/worker leaves plugins/pluginRead false; nativePlugins, plugin credentials, native events and native allow-lists are not offered. A failed bootstrap never silently falls back to an in-memory installer.
- `?safe` uses the deployed recovery app and does not import external plugins, while listing/disable/rollback remain available without clearing user data. Management mutations report reload needed; Settings → Plugins uses the existing save/close/session reload path, never a forced reload timeout. Disable does not revoke code already running on this page. Plugins are trusted same-origin code, not sandboxed.
- Browser install refuses built-in IDs, validates schema/contract arrays, native facet exclusion, paths, skill frontmatter and 4096 files/64 MiB/1 MiB manifest bounds, copies bytes and rehashes a second source capture before publication. Integrity failures leave selection unchanged. Browser paths are deliberately canonical (no whitespace/control, percent, query, fragment, backslash or dot segments); this is stricter than shell packaging for ambiguous names.
- Web-only plugins that require a service only native plugins provide are shown as blocked (normal dependency rule).

### C2. `servers@1` (supervised long-running processes)
- Service: `{ start({name, command, cwd?, health?, startGraceSeconds?}), stop(name), restart(name, changes?), status(name?), logs(name, lines?) }` with the same semantics and results as today's `manage_server`; the agent tool `manage_server` is contributed by whichever plugin provides `servers@1`. Durable task kind and doc kind of the existing implementation stay permanent.
- Android provider: `core-servers` (today's `servers.js`: tmux in Ubuntu, restarts with backoff, survives page reloads and app restarts, logs in `.services/logs/`).
- Browser provider: `browser-vm-servers` (browser-edition conversation): processes detached inside the v86 Alpine VM (tmux via apk or a BusyBox supervisor), logs in `/workspace/.services/logs/`, the serial console stays free. Health checks run inside the VM (wget) or via inbound TCP to the guest port once the virtual network supports inbound connections. Lifetime: servers end with the tab; the durable Server task restarts them after a reload (not continuous). Previews: the service worker maps `/preview/<port>/...` to guest TCP via the page; WebSockets are a known limitation: a service worker cannot intercept them and the guest has no real network address. Best effort only: the service worker injects a shim at the top of proxied preview HTML that replaces `window.WebSocket` and tunnels frames into the guest's in-page TCP stack. Not covered: WebSockets from workers inside the preview, code holding the original constructor before the shim runs, pages not served through the proxy. Full WebSocket support would need a real relay endpoint (external service), deliberately out of scope. Report this limitation to users rather than claiming WebSocket support.
- Status must report host limits honestly (e.g. `persistent: false` in the browser).

## 10. Build and persistence

Web source is plain JS. Kotlin compile uses standalone 2.2.20 kotlinc + D8, JVM target 17, min API 28. Benchmarked cold build ~20–25 s; repeat builds in one JVM ~4 s for a small example, NOT full-app timings or a universal guarantee. Start with reproducible cold CLI, then managed warm compiler. Keep one build active per source snapshot and publish only on success.

Tooling in `scripts/plugin.sh`, SDK jars/generated outputs in ignored build directories. No dependency on npm/Bun. A resident compiler must be supervised by manage_server; an idle exit must not produce a supervisor restart loop. App/native edits persist in self-forming; live web sync and APK activation are main-agent responsibilities. Never overwrite concurrent edits wholesale.

## 11. Acceptance tests

- Required dependency ordering, optional absence, cycles, duplicate provider/key rejection, setup failure cleanup, idempotent stop, transitive shutdown, late async completion.
- Chat drafts survive closing/reopening; features use actual plugin services/contributions.
- Install/call sample native plugin; hash mismatch refused; no approval prompt; old snapshot remains intact after failed build/install.
- Traversal, symlink and oversize input rejection; read-only dex and web asset MIME checks.
- Disable-all recovery works with a broken plugin and without importing any plugin code.
- Native revision replacement truthfully reports restart-required; no auto replay after detach.
- Existing sign-in, secrets scope controls, core tools, app revisions and session persistence unchanged.
- Unit/static tests are not on-device verification. Report what has and has not been tested.

## 12. Implementation ownership

Native helper: Kotlin PluginApi/PluginHost, NativeBridge routing, MainActivity asset routing and SettingsActivity recovery only. No Gradle/version/manifest or web edits without coordination.
Web helper: new plugin-runtime.js, plugin-client.js, plugin-builtins.js and focused tests only. Propose app integration points, do not edit shared entry points.
Tooling helper: scripts/plugin.sh, skills/plugins/SKILL.md, examples/plugins/counter and benchmark-based compiler utility only. SDK source ABI is fixed above, do not duplicate/edit it.
Main agent: composition integration, app/session/tool wiring, integration review, source synchronization, versioning/build/install and user communication.

## 13. References and limits

Opencode b4f19bfe7: packages/gui-extensions/README.md (core shell, provides/uses/requires), packages/core/src/plugin (scopes, loading, fallback), packages/plugin-browser/README.md (disconnect uncertainty), packages/plugin (host API).
Pi Chord: packages/chord/docs/guide.md (facets, contracts, roots, registries, resource lifetime). Installed Pi is 1.3.0 (APK 0.6.5; the app uses only `chord/context`); Chord's host runtime changed a lot since 1.0.4. Similar message names are NOT wire compatibility. Use ideas without claiming a future drop-in replacement. Chord adoption is a separate evaluated dependency change, not a prerequisite for M1.
