# Self Forming — browser edition

The app runs in a browser tab with browser storage and workers, without the Android host. Build a static deployment:

```sh
scripts/build-browser.sh                         # -> dist/browser
busybox httpd -f -p 127.0.0.1:8770 -c scripts/browser-httpd.conf -h dist/browser # HTTPS or localhost required
node --test tests/browser-edition.test.mjs
node --test tests/browser-integration.test.mjs
node --test tests/browser-smoke-dependencies.test.mjs
```

Tests default to the assembled `dist/browser/` output. To test another assembled directory, use an explicit file URL with a trailing slash (and module-mode output for Node 18 imports):

```sh
PI_BROWSER_TEST_DIST=file:///absolute/path/to/output/ node --test tests/browser-smoke-dependencies.test.mjs
```

The smoke dependency check fails if its assembled inputs are missing; it does not silently skip.

The Git-excluded binaries (v86, Linux image, Tor/Tailscale WASM) are fetched and sha256-verified from `scripts/assets.lock` by `scripts/fetch-assets.sh` (the build calls it; `SF_SKIP_FETCH=1` skips). `SF_STRIP_MAPS=1` leaves out source maps. The build adds a CSP `<meta>` to `index.html`; no COOP/COEP is needed. GitHub Pages deployment: `docs/browser-deploy.md`.

Build needs prebuilt `dist/app/library/` and `native-host.js`. It copies browser sources, smoke pages, manifest/icons, vendor assets and `libs/cors-rot/` to the output. The result is static files; serve via HTTPS or localhost, with `.wasm` as `application/wasm`. Output paths overlapping inputs are refused.

## Networking

`plugins/net-tor` and `plugins/net-tailscale` own route implementations and consume the unchanged `libs/cors-rot/` library/assets. `apps/browser/browser-network.js` assembles their bundled controllers and the generic Providers selection. `browser-host.js` does not import cors-rot or implement a route.

Settings → **Providers** selects a provider for `net.fetch@1` (not a second Network selector). Tailscale uses an in-page client and a selected exit node; Tor uses its in-page client and runs its Snowflake proxy while selected. Provider readiness/setup varies. Same-origin app files, module/bootstrap fetch, workers and assets use ordinary browser fetch, independently of external-model routing; no blanket direct fallback is implied. Tor networking is experimental; anonymity is weaker than Tor Browser, and accounts still identify users.

## Host and execution

`browser-main.js` installs the browser host before loading `app.js`. Same-origin/bootstrap traffic is not routed through the selected external-model provider. The bridge and browser APIs are documented in `docs/bridge.md`.

| Area | Browser behavior |
|---|---|
| Files | `core-execution` owns the page VFS (`browser-vfs.js`), shared with revisions and execution; filesystem data uses IndexedDB. |
| Execution | Two `execution@1` providers, chosen in Settings → Providers → Execution environment: `exec-linux` (Bash in an in-tab Alpine/v86 VM; the default) and `exec-js` (JavaScript in a fresh worker). Both share core-execution's page VFS; the agent gets one shell tool (`bash` or `javascript`) matching the selection. Switching reopens the conversation in place once the agent is idle (same save-close path as an app update, no page reload); servers keep running in the Linux VM and their supervision waits while JavaScript is selected. |
| Git | `plugins/core-git` provides `git@1`; execution uses RPC and the shared binary filesystem. No native Git CLI. |
| Conversations | `core-storage` uses JSONL in `/data/conversations`; SQLite bridge methods are unused. |
| Authentication | Browser records are in profile `localStorage`, not Android's encrypted keystore. ChatGPT callback handling is a manual paste adapter; no native callback interception. |
| Revisions | IndexedDB revisions and service-worker serving provide browser update/recovery behavior. |

Browser storage may be evicted despite persistence requests. Export important files separately. JavaScript workers and path restrictions are not a secure sandbox; code can use browser-origin facilities and open its own network channels. Routing covers provided APIs, not all browser traffic. Availability depends on endpoint CORS/auth behavior. Native git, npm, Python and general native binary execution are not provided.

## Explicit network smoke page

`network-smoke.html` offers separate buttons for Tor exit-IP, streaming and public Git ref discovery. Requests happen only after button presses. Git discovery imports the owning Git service and receives a filesystem that rejects file operations: it does not access app files or credentials. No private URLs or credentials should be entered. Public endpoints are contacted only on user action; discovery is not clone/push/authentication verification.

## Ownership and verification

The browser smoke build is a static deployment; it does not apply a live app revision. Browser Git/UI/warming implementations live in their plugins; fixed revision/SW recovery stays host-owned. Tor/Tailscale routes are experimental (Tor on Android is not claimed to work), and full Shell/server support is not claimed. Host file ownership: `docs/host-ownership.md`.

## Console Git and execution limits

In the JavaScript tool (fresh worker per command):

```js
await git.init({ defaultBranch: 'main' });
await fs.writeFile('notes.txt', 'hello\n');
await git.add({ filepath: 'notes.txt' });
await git.statusMatrix();
// Commits require your explicit author; the adapter invents no identity.
// Public discovery, only if requested and your selected route permits it:
await git.listServerRefs({ url: 'https://github.com/isomorphic-git/isomorphic-git.git' });
```

Use `process.chdir()` for another repository. Author/auth callbacks are explicit; Git saves no credentials.
Await asynchronous work: worker completion cancels owned operations. Worker fetch responses are pulled
in at most 64 KiB chunks; uploads through worker fetch RPC are buffered, not a full Fetch implementation.
Git HTTP runs on the page and preserves upstream streaming uploads/responses instead of using that
buffered upload path. Streaming uploads require browser support and HTTP/2 or HTTP/3; upstream Git
and the whole-file VFS still hold pack buffers, so this is not constant-memory Git. Symlinks and
executable modes are unsupported; checkout can fail rather than silently lose them.

Linux (exec-linux, default): a string runs as `bash --noprofile --norc -c`, an argv array is exec'd
directly (no shell); stdout and stderr are separate. Timeout/abort TERM, then KILL, only the command's own
process group (the VM is never reset; processes that setsid away, such as tmux servers, keep running);
timeouts report code `timeout`; an unconfirmed cancellation marks Linux unhealthy until the page reloads.
The image must include bash. JavaScript (exec-js): a string is source; argv only `["node", <file>, ...args]`.
There is no `PI_EXEC_KIND` selector; inheritEnv/spill are not implemented. The guest `/workspace` is a
live 9p mount (9P2000.L, `cache=none`) of the page files, served on the page (p9-server.js) over the VM's
virtual network card: there is no copying, page edits are visible to the next guest read (also to running
servers) and guest writes are in the page files when each command returns. `/scratch` is a fast VM-local
directory, wiped with the VM; dependencies, build output, caches and large clones belong there. Commands may
run with cwd under `/workspace` or `/scratch`. The mount is (re)established after boot, a VM restart or a
dropped connection; if it fails, the command is not run and fails with a retryable "Linux could not mount
/workspace" error (the next command retries). Limits: symlinks, hard links and xattrs are unsupported; if the
page renames a file while the guest has unflushed writes to it, those writes are dropped; throughput is
bounded per file operation (about ten 9p round trips each through the emulated NIC), so many-file work such
as git or `npm install` in `/workspace` is slow. The image needs the `9pnet_fd` module. `backgroundExecution` remains
false. `servers@1` (core-servers) is tab-bound, needs the Linux environment (the JavaScript one is refused)
and has no general provisioning, guest preview or WebSocket serving. Manual ChatGPT callback paste has no local
listener or native callback interception. Bootstrap/module and same-origin traffic remain independent
of selected application routes.

## Storage and revision recovery

Keep the same scheme, hostname **and port** when serving again: browser storage is origin-scoped.
The IndexedDB filesystem roots are `/workspace`, `/tmp` and `/data`; Web Locks prevent concurrent app
tabs from overwriting state. Files are stored whole, read lazily, with a 64 MiB content cache. Persistence
requests can be refused; back up important files.

Editable deployed source is materialized at `/workspace/.self-forming/app/<version>-browser`.
Revisions stage bounded snapshots into IndexedDB and activate through the service worker. Open `?safe`
(or `recovery.html`, see Recovery) to bypass an editable revision and load deployed files; an unready startup can roll back automatically
(the ready watchdog is 45 seconds). Restore original/previous via the revision tools when available.
Fixed resources are not replaced by revision overlays: top-level `browser-*.js`, `sw.js`, `native-host.js`,
`library/`, `cors-rot/`, vendor assets and deployment metadata. The plugin exception is exactly
`builtin/core-execution/web/browser/` (the eight execution bootstrap files) and the two files
`builtin/core-providers-chatgpt/web/browser-oauth.js` and
`builtin/core-providers-claude/web/browser-auth.js`. Other plugin web files, including core-git and
network UI, retain their existing editable policy; no entire provider/network tree is fixed.
These are recovery mechanisms independent of successful plugin composition, not dynamic installed-plugin
snapshot serving. Builds do not overwrite a live app unless explicitly deployed.

## Recovery

All recovery code is fixed host code (deployed with the host, never taken from an app revision or plugin, independent of `app.js`):

- **Recovery page** `recovery.html` (also `?recovery` on the app URL, and the PWA shortcut "Recovery"): open the app normally or in safe mode; the last 10 activated revisions (time, in use, did not start/stopped responding) with "Use this version" and "Use the original app"; installed plugins with Disable/Enable and "Disable all"; "Reset the page loader" (unregisters the service worker, no data removed). It imports only `browser-recovery.js`, `browser-app-state.js`, `browser-probation.js` and the fixed plugin store/package modules, reads the IndexedDB stores directly, waits for the `self-forming-browser-host` lock, writes through the host's own transitions and plugin selection records, and never deletes data. Neither it nor `?safe` executes revision code.
- **State** (`browser-app-state.js`, shared by `browser-revisions.js`, `sw.js` and the page): one-transaction read-modify-write; `history` keeps the last 10 activated revisions (single `previous` semantics unchanged for `app.restore` and Settings); unreferenced revisions are pruned (never active/previous/pending or one staged within the last hour).
- **Fixed bar** (`browser-recovery-ui.js`, mounted by `browser-main.js` before `app.js`): `<sf-recovery>` on `<html>` with inline `!important` guards and a closed shadow root. "The app didn't start properly — Recovery" on a startup exception or no `app.ready` within 20 s; "App updated to revision … — Undo · Keep · Recovery" for 10 minutes after an activation; a one-time alert after an automatic rollback.
- **Probation and freezes** (`browser-probation.js`): for 10 minutes after an activation (or until Keep) the page heartbeats to `localStorage` and to the service worker. A load of that revision that stopped heartbeating while visible without a clean `pagehide` is rolled back on the next load; the service worker rolls back and sends a visible window that has been silent for 20 s to `recovery.html?reason=unresponsive`. Limits: a fully hung renderer may only navigate after the browser intervenes; hidden tabs are never judged; a browser crash while visible counts as a failed run; a legitimately blocked main thread for 20 s during probation is treated as stuck. `app.ready` now waits until the composer is mounted (or 15 s) plus two animation frames and an idle callback.
- **Boot cover** (`browser-splash.js`, a classic script first in `<head>`; the build adds it to `index.html` and the service worker adds it to a served revision page that lacks it): a plain "SELF FORMING" page in the look tokens (`--paper`, `--ink`) covers the document so the shipped markup does not flash before the user's revision, plugins and conversation load. It is removed (short fade, none with `prefers-reduced-motion`) once plugin composition settled (`app.js` calls `__sfSplash.mark("composed")`) and the conversation is open (message box enabled); a startup error (`browser-main.js`), `?recovery` or a 15 s timeout reveal the page instead (the recovery bar sits above the cover). While the "open in another tab" notice waits for the user the clock is paused. Browser only: Android never loads it.
- Tests: `tests/browser-recovery-state.test.mjs`, `tests/browser-recovery-ui.test.mjs` (fake IndexedDB/DOM, from sources), `tests/browser-recovery-build.test.mjs` (assembled output). Real-browser smoke: `../build/browser-recovery/smoke.mjs`.

## Installed web-only plugins

The existing `plugins` agent tool and Settings → Plugins manage trusted installed web
packages through `core-plugin-management`; this is not a second plugin runtime or a
sandbox. Author a `plugin.json` plus `web/index.js` (exporting `setup(ctx)`) in the
shared `/workspace/plugins/<id>` filesystem, then use `plugins` with
`action: "install", path: "/workspace/plugins/<id>"`. Native facets and native calls
require Android and are rejected, never partially installed. Built-in IDs cannot be
overridden by the browser installer.

Code snapshots and selected/previous/enabled pointers live in the separate IndexedDB
**`self-forming-browser-plugins-v1`** database (version 1, `snapshots` and `selections`).
Workspace edits do not mutate installed code. Publication is atomic; a failed quota
write preserves the previous selection. Read-only SW serving still works if later
writes fail. Source validation and canonical hashes follow `docs/plugins.md` §9c.
Snapshots are retained, including disabled and previous revisions, for pages already
using them; there is currently no automatic snapshot garbage collection.

At a subpath deployment `/my/app/`, immutable ESM/CSS/assets are served at
`/my/app/assets/web/plugins/<id>/<hash>/web/...` (root deployment keeps
`/assets/web/plugins/...`). Missing or malformed installed resource requests never
fall back to the network or editable app files. Serving revalidates snapshot bounds
and hashes for each request; there is currently no verification cache.

Installation/selection does not activate code on the current page. Changes report
reload required; Settings → Plugins → Reload now uses the existing saved-session
close/reload pathway. Open **`?safe`** for the deployed recovery app without importing
external plugins; listing, disabling and rollback remain usable. It does not clear
chat, workspace, sign-in or plugin state. Plugin capabilities are advertised only
after a writable durable store and a controlling installed-serving SW handshake are
available; first-load control is awaited without a reload loop.

Focused nonvisual checks: `tests/browser-plugin-lifecycle.test.mjs`,
`tests/browser-plugin-store.test.mjs`, and `tests/plugin-ownership.test.mjs` (run each
in its own Node process). Lifecycle coverage includes agent-authored VFS packages,
real ESM setup through the installed client/runtime, relative imports, immutable old
bytes, update/disable/rollback, host reconstruction, safe recovery, source mutation,
quota failure and native rejection. Store tests use an instrumented IndexedDB API
double; they are **not** real-browser storage/ServiceWorker or visual acceptance.
A separate headless-Chromium smoke (not in the repository suite) verified the real
Service Worker/IndexedDB path: install, source edit not affecting the installed snapshot,
update, disable, rollback, `?safe` blocking and native-call rejection. Not visual acceptance.

Host version: `app-manifest.json` `hostVersion` is `<package version>-browser-<content hash>`, so every
deployment gets its own editable source folder and the service worker never serves a revision made
for an older deployment (which used to run stale editable plugin copies against a newer fixed host).
Edits applied to an older deployment stay in its folder under `/workspace/.self-forming/app/`.
