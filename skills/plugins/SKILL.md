---
name: plugins
description: Create, check and compile trusted web/Kotlin plugins without rebuilding the APK
---

# M1 plugins

New features are new plugins (change existing behaviour in the built-in that owns it, the look in the look plugin); split independent plugins across subagents, then install and verify yourself, and ship each working plugin as its own small step so the user sees progress. Read `docs/plugins.md` revision 3 first. Plugins are trusted same-process application code, **not sandboxed**. There is no plugin authorization, approval prompt, capability grant or development mode. Existing Android permissions, secret execution scopes and destructive-data confirmations still apply. Do not read credentials to build plugins.

## Browser edition (web-only)

Everything marked **Android** below (Kotlin halves, `scripts/plugin.sh`, the toolchain, `ctx.native`, native restarts, APK builds) does not apply in the browser. There a plugin is web-only: a folder `/workspace/plugins/<id>/` with `plugin.json` and `web/index.js` (and `web/skills/<name>/` for skills), no `native` facet (a package with one is refused). Install it with the `plugins` tool (`action: install`, `path: /workspace/plugins/<id>`); the browser plugin host stores an immutable, hashed copy and loads it on the next page load (`plugins list` shows `reload-required` until then). `disable`, `enable` and `rollback` work the same; built-in ids cannot be installed. The Linux shell there has no `plugin.sh`: check the manifest and files by reading them and let the install validate the package.

## Create and build (Android)

From `self-forming/`:

```sh
# Creates a counter-based starter; refuses to overwrite an existing directory.
./scripts/plugin.sh new counter
# A bare ID resolves under ../plugins/; an explicit path works too.
./scripts/plugin.sh build counter
./scripts/plugin.sh check counter
```

Alternatively copy `examples/plugins/counter/` to `<workspace>/plugins/counter/`, then build. `new` changes the logical ID and service ID; its Kotlin entry remains `plugins.counter.CounterModule` (each plugin has its own classloader). Customize the starter before relying on it for another feature. The counter keeps its value only in memory. It exposes `get` and `increment`, each accepting `{}` and returning a JSON number. No automatic mutations, data deletion, UI, Android permissions, threads or disk writes are needed.

`web/index.js` is plain browser ESM exporting `setup(ctx)`. It registers `counter.value@1` with `ctx.provide(id, version, implementation)`. Its service methods call `ctx.native.call(method, input)`. The runtime removes registrations on scope closure; setup can also return cleanup. Do not add DOM dependencies just to expose a service.

## Agent Skills in a plugin

A plugin can ship [Agent Skills](https://agentskills.io/specification) (the format Pi uses): a folder with `SKILL.md` and optional `scripts/`, `references/`, `assets/`. Put each skill at **`web/skills/<name>/`** inside the package, not at a top-level `skills/`: only `plugin.json`, `web/**` and `native/module.jar` are shipped, hashed and served by the host, and `check` refuses a top-level `skills/` so it is never silently left out of the revision.

```text
plugins/notes/
├── plugin.json
└── web/
    ├── index.js
    └── skills/notes/
        ├── SKILL.md
        └── scripts/add.sh
```

`SKILL.md` starts with YAML frontmatter; `name` must equal the folder name (lowercase letters, digits, single hyphens, at most 64) and `description` (at most 1024 characters) says what the skill does and when to use it:

```markdown
---
name: notes
description: Keep notes in notes/. Use when the user asks to remember something.
---

# Notes

Run `scripts/add.sh` relative to this folder.
```

`check` validates every `web/skills/<name>/SKILL.md` (frontmatter present and closed, name equals the folder, description present). Then contribute each skill from `web/index.js`, one `agent.skills` contribution per skill, listing its files (the page cannot list folders of the installed snapshot):

```js
export function setup(ctx) {
  ctx.contribute('agent.skills', 'notes', {
    name: 'notes',
    description: 'Keep notes in notes/. Use when the user asks to remember something.',
    files: ['SKILL.md', 'scripts/add.sh']   // relative to web/skills/notes/
  });
}
```

While the plugin is active, the app copies the skill of the selected revision to `<workspace>/.skills/<pluginId>/<name>/` (read-only, best effort: `chmod a-w`; some file systems ignore it), refreshes the copy when the revision changes and removes copies of plugins that are no longer active. Never edit `.skills/`: change the plugin source, rebuild/install it. The prompt section `skills` lists name, description and the `SKILL.md` path of each skill a conversation may use; the agent reads `SKILL.md` when a task matches. Excluding the plugin in a conversation (Settings → Plugins) removes its skills there and in its subagents. Settings → Plugins shows each plugin's skills.

Host note: since 0.6.3 (N4) the page CSP `connect-src` includes `'self'` plus the cors-rot relay origins (`RELAY_CONNECT_SRC` in `BrowserConnections.kt`), so `files` can be read on current hosts; on older Android hosts copying `files` fails with "the host must allow the page to read plugin files". For those, pass the files inline instead of `files` (same folder layout, text files only):

```js
import skill from './skills/notes/skill.js';   // export default {'SKILL.md': '...', 'scripts/add.sh': '...'}
ctx.contribute('agent.skills', 'notes', { name: 'notes', description: '...', contents: skill });
```

Rules: skill names are unique across the app and plugins; taking an existing name (also the app's own `self-rebuild` and `plugins`) needs `replaces: ['<name>']` and then keeps that skill's place in the list. A plugin may also point at a file in the workspace with `path` (relative to the workspace or absolute) instead of `files`/`contents`. Skills are listed on hosts with a shell and plugin support (the Android app and the browser edition).

## Installed tools (no Gradle/npm) — Android

The script uses installed tools only; it does not download, update, or modify the benchmark. Defaults reflect the on-device benchmark:

- `JAVA_HOME=/opt/pi-android/jdk`
- `PLUGIN_KOTLIN_HOME=<workspace>/plugin-bench/tools/kotlinc` (compiler **2.2.20** required)
- `PLUGIN_ANDROID_JAR=/opt/pi-android/sdk/platforms/android-36/android.jar`
- `PLUGIN_D8_JAR=/opt/pi-android/sdk/build-tools/36.0.0/lib/d8.jar`

Override these named paths for another installation. Required shell tools: Bash, jq, coreutils, find, sort, flock, zip and unzip. Toolchain provisioning is a separate host task; consult `skills/self-rebuild/SKILL.md`, not Gradle or npm. Building a plugin does not require an APK build or signing key.

The SDK **single source of truth** is:

`apps/android/app/src/main/java/md/incept/selfforming/plugin/PluginApi.kt`

If missing, request it from the native helper. Never copy the benchmark SDK or create an alternative interface. Its ABI must match documentation §6: `start(PluginContext)`, `call(String, JSONObject): Any?`, `stop()`, with `PluginContext(appContext, id, dataDir)`. Report a mismatch rather than changing the sample to fit it. From host 0.6.0 the context also has `emit(event, data): Boolean` (native → this plugin's web facet, received with `ctx.native.on(event, cb)`; best effort, dropped while no page listens; check `ctx.native.events` on the web side), and web facets can read their own `web/` files with `ctx.native.readFile(path)`; see docs/plugins.md §7a. A module that calls `emit` fails with NoSuchMethodError on 0.5.x hosts.

Each cold build compiles that source to `host-api.jar` against android.jar and Kotlin stdlib 2.2.20; compiles the plugin with those three dependencies on its classpath, JVM target **17**; then runs D8 in release mode with **min API 28**. Only plugin JVM classes are D8 input: the platform, host API and stdlib are **never bundled**. Host must provide the matching Kotlin stdlib. There is no resident compiler or unmanaged server. Cold timings are printed separately for SDK compile, plugin compile and D8 (whole seconds, excluding tool version startup and staging).

## Validation and publication (`check` is Android; the browser host validates on install)

`check` validates API 1, IDs, contract arrays/positive integral versions, facet paths/existence and reload policy, Agent Skills under `web/skills/` (see above), rejects symlinks/special files, limits shipped content to 4096 files/64 MiB and manifest to 1 MiB, and checks that the native jar contains `classes.dex`. Native packages use `native/module.jar` and `reload: restart`. Unknown API versions fail. This is a build/package check, not an Android runtime test or proof of plugin safety.

Shipped content is exactly `plugin.json`, `web/**`, `native/module.jar`; `native/src/**` and `out/**` are not shipped. The reported revision is SHA256 over sorted UTF-8 relative path + NUL + lowercase file SHA256 + LF records. The installer must independently validate, snapshot and rehash these files; never load directly from this editable source directory.

Builds take an exclusive nonblocking per-directory flock, stage a private input copy, compare canonical input records after copying and again before publication, and check that the SDK source did not change. A failed stage leaves the previous `native/module.jar` intact. Only after compilation, D8 and package checks succeed is that jar published with an atomic rename. Dex ZIP paths/order/timestamps are normalized. Sources/web edits are not rolled back by this compiler; immutable whole-package publication is the host installer's responsibility. Successful inspection artifacts (SDK jar, plugin JVM jar, staged inputs and dex) remain in ignored `out/plugin-build/build.*`; failed temporary stages are removed. Do not package `out/`.

## Install and use — main agent integration

The build script **never installs, enables, calls or reloads** a plugin. Once the host includes M1 management, the main agent can call the existing bridge:

```js
const installed = await bridge.call('plugins.install', {
  path: '<workspace>/plugins/counter'
});
// Use installed.hash, not a guessed or stale revision. No automatic retries.
await bridge.call('plugins.call', {
  id: 'counter', hash: installed.hash, method: 'get', input: {}
});
```

(Android: `plugins.call` and native code do not exist in the browser.) Native selection/replacement can report `restart-required`: do not promise class unloading or immediate activation. Coordinate any page/process restart at the host's saved-session lifecycle boundary. A lost call response has UNKNOWN outcome; never automatically replay `increment`. Installed code URL loading and service activation belong to `plugin-client.js`/`plugin-runtime.js`. Rollback selects old code, not old counter/data state. Do not install the sample into a live host merely to compile-test it.

Warm compilation is deferred. If added later, the **main agent must supervise it with `manage_server`**, explicitly choose logs and port, test health, and stop it through that tool. Do not launch a detached compiler with Bash. Configure a deliberate stop/idle policy that cannot cause a supervisor restart loop. This M1 script requires no server.
