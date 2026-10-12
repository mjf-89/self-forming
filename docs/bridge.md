# Native bridge reference

The Android host supplies upstream ExecutionEnv operations, SQLite, streamed HTTP and encrypted ChatGPT/Claude credential storage. Pi AI receives a Fetch-compatible native adapter for all supported model providers. Pi handles provider protocols and model events; Kotlin owns network connections.

The protocol adapters and authentication controllers live in packages/native-host/src. The packaged session and tool registration live in apps/on-device/session.js and native-tools.js. These application modules remain separate from the reusable upstream browser archive.

See [Ubuntu runtime](ubuntu-runtime.md) for packaging, loader selection and command behavior, and [validation](validation.md) for executed checks.

## Transport

`WebViewCompat.addWebMessageListener` exposes `PiNative` to the main frame at `https://appassets.androidplatform.net`. The packaged entry point is `/assets/web/index.html`. `createNativeBridge()` attaches one listener to `PiNative.onmessage` and sends JSON strings through `PiNative.postMessage`.

```json
{"id":"b1:1","method":"workspace.read","params":{"path":"demo-note.txt"}}
{"id":"b1:1","ok":true,"result":{"text":"Hello"}}
{"id":"b1:1","ok":false,"error":{"code":"NOT_FILE","message":"The path is not a regular workspace file"}}
```

Each request gets one success or failure reply. `null` represents a successful operation without a result. Calls may overlap; match replies by `id`, not arrival order. IDs must be nonempty, at most 160 characters and unique among pending requests. The host admits at most 256 pending operations. Each complete JSON envelope is limited to 4 MiB of UTF-8, including escaping and base64 overhead.

Malformed responses invalidate the JavaScript bridge. Ordinary operation errors reject that call with `NativeBridgeError.code` and `message`, with optional `path` and `spillPath`; they do not automatically close the bridge. The environment adapter converts native errors into upstream `FileError`/`ExecutionError` results. Do not retry uncertain mutations automatically. Example host error codes include `PATH_DENIED`, `TOO_LARGE`, `INVALID_HANDLE`, `DATABASE_BUSY`, `HTTP_TIMEOUT` and `ABORTED`; environment errors use upstream lowercase codes such as `not_found`, `permission_denied`, `spawn_error`, `timeout` and `aborted`.

## Methods

| Method | Parameters | Result |
| --- | --- | --- |
| `host.info` | `{}` | `{platform:"android", version:string, foreground:boolean, workspace:string, capabilities:{executionEnv:true, shell:"ubuntu-proot", editableApp:boolean}}` |
| `sqlite.open` | `{name}` | `{handle}` |
| `sqlite.exec` | `{handle, sql}` | `null`; multiple SQL statements allowed |
| `sqlite.run` | `{handle, sql, params}` | `null`; one statement |
| `sqlite.all` | `{handle, sql, params}` | Array of row objects; one statement |
| `sqlite.close` | `{handle}` | `null` |
| `workspace.list` | `{path}` | `[{name, path, directory, size}]`; size is bytes |
| `workspace.read` | `{path}` | `{text}` |
| `workspace.write` | `{path, text}` | `null` |

The `env.*` methods are documented below. Authentication methods are listed at the end.

## Editable application revisions

The fixed main-frame origin and entry URL are retained when loading edited code. `app.info` returns `{supported:true, sourcePath, revision, previousRevision?, hostVersion, notice?}`. The original revision is named `bundled`; hosts without a valid source manifest return `{supported:false}` and advertise `editableApp:false`.

| Method | Parameters | Result |
| --- | --- | --- |
| `app.info` | `{}` | Current revision information |
| `app.stage` | `{}` | `{revision}` for a complete validated snapshot of the draft |
| `app.activate` | `{revision}` | Updated information; persists selection without reloading |
| `app.ready` | `{revision}` | Updated information; acknowledges matching startup |
| `app.restore` | `{target:"previous"\|"original"}` | Updated information; selects working code without reloading |

The application must close its Harness and await native SQLite shutdown before activation/restore, then reload only after the host replies. The agent tool stages during execution, but activation waits until its successful result has been committed and the turn is idle. A new document acknowledges startup after reopening the saved conversation. Revision selection is pinned per document; fixed modules always come from the APK. Native recovery can select and reload even if JavaScript is broken. See [source layout, limits and recovery](editing-app.md).

## Activity lifecycle

After the page first contacts the bridge, Activity start/stop changes emit `{"event":"host.lifecycle","id":"host","foreground":true}` or `false`. `host.info.foreground` supplies the initial state, including when the page loads in the background. These events use the same document-scoped transport as other replies; a reset discards the old page's listener.

On background, the application immediately seals and closes its Pi Harness, preserving unfinished tasks under upstream recovery rules before cancelling their transports. It reopens the same database and a fresh execution adapter on foreground, then resumes pending work when authentication is available. The native bridge and authentication controller stay alive during this transition so external-browser sign-in can finish. Open/close transitions are serialized; an old operation cannot update a newly opened session. Activity destruction or renderer loss still tears down the entire bridge. These notifications do not provide background execution or a shutdown callback guarantee on abrupt process death.

## SQLite values and ownership

Bindings and row values use `null`, finite numbers, strings, `{"$bytes":"base64"}` or `{"$bigint":"decimal integer"}`. The adapter converts the latter two to/from `Uint8Array` and `bigint`. Kotlin returns integers beyond JavaScript's safe integer range as tagged bigints; SQLite integers must fit signed 64 bits.

Database names match `[A-Za-z0-9_-]{1,64}`. Files live in the app's private no-backup directory. There is one owner per database file, at most eight open handles per host, and one process-wide SQLite worker. The host uses bundled SQLite with WAL and `synchronous=FULL`. Attachments, relocation and unlisted pragmas are rejected. Large query results must be paged to fit the bridge limit.

`openNativeDatabase()` implements Pi's asynchronous `SqliteDatabase` facade. Its `get()` selects the first row of `sqlite.all`; there is no separate `sqlite.get` wire method. Transaction callbacks stay in JavaScript:

1. Queue unrelated operations behind the transaction.
2. Send `BEGIN IMMEDIATE` and run callback operations on the same connection.
3. Invalidate the callback handle when it settles.
4. Await `COMMIT`, or await `ROLLBACK` before rejecting.

Rollback failure quarantines the handle and reports both errors. Bridge loss rejects pending/queued work; commits have no automatic timeout or replay. Page recreation closes old connections before new opens on the shared worker. Activity destruction or renderer failure also cancels model HTTP and environment work and closes databases. Handles cannot survive a document restart. These rules do not provide multi-Harness ownership of the same database.

## Execution environment

`openNativeExecutionEnv(bridge)` returns an implementation of the upstream `ExecutionEnv` interface. Its initial cwd/home is `filesDir/workspace`; temporary files and directories use `cacheDir/execution`. The environment's `cwd` can change within those namespaces. Relative paths, `~`, normalized absolute paths and parent components are resolved against cwd, then checked against the allowed roots. Operations that follow links require their resolved targets/ancestors to stay inside those roots; metadata/removal can inspect or remove a final link itself. `noFollow` on a binary reader refuses only a final symlink, matching upstream semantics.

These are filesystem API checks, **not a sandbox for shell commands**. Processes run with the app UID and permissions. A same-UID process can access app-private data and race pathname checks. The environment is intended for trusted agent work.

Filesystem calls made by the TypeScript adapter include `cwd`, an adapter-specific `owner`, and a `requestId` used for cancellation. Reader/writer/watcher handles are scoped to the current native host/document. Closing handles is idempotent; subsequent reads fail. `cleanup` releases handles, watches and commands owned by that adapter.

| Method | Operation-specific parameters | Result |
| --- | --- | --- |
| `env.info` | `{}` | `{id, cwd, home, temp}` |
| `env.absolutePath`, `env.canonicalPath` | `{path}` | Path string; canonical form resolves links |
| `env.joinPath` | `{parts:string[]}` | Normalized joined path string |
| `env.exists` | `{path}` | Boolean |
| `env.fileInfo` | `{path}` | `{name, path, kind, size, mtimeMs}` |
| `env.createDir` | `{path, recursive?}` | `null` |
| `env.remove` | `{path, recursive?, force?}` | `null`; namespace roots cannot be removed |
| `env.renameFile` | `{sourcePath, destinationPath}` | `null` |
| `env.truncateFile`, `env.flushFile` | `{path, size}` / `{path}` | `null` |
| `env.createTempDir` | `{prefix?}` | Absolute directory path |
| `env.createTempFile` | `{prefix?, suffix?}` | Absolute file path |
| `env.openBinaryReader` | `{path, noFollow?}` | `{id}` |
| `env.reader.info` | `{id}` | Metadata for the opened file, even after rename |
| `env.reader.read` | `{id, offset, length}` | `{data:base64}`; EOF may return fewer bytes |
| `env.openDirReader` | `{path}` | `{id}` |
| `env.reader.next` | `{id, maxEntries}` | `{entries:FileInfo[], done}` |
| `env.reader.close` | `{id}` | `null` |
| `env.openWriter` | `{path, append}` | `{id}`; creates parents, creates/truncates or appends |
| `env.writer.write` | `{id, data:base64}` | `null` |
| `env.writer.close` | `{id}` | `null` |
| `env.watch` | `{id, targets:[{path, recursive?, exclude?}]}` | `{id, mode:"polling"}` |
| `env.watch.close` | `{id}` | `null` |
| `env.cancel` | `{requestId}` | `null`; cancels a pending filesystem operation |
| `env.cleanup` | `{owner}` | `null` |

The adapter builds whole-file reads, line readers, line scanning, directory listing and writes from these primitives. File contents cross the bridge in 256 KiB chunks. Native read chunks are capped at 512 KiB; the adapter caps whole-file/range reads at 256 MiB and directory pages at 256 entries. Filesystem handles are capped at 128. Writes can be partially visible after an interruption and are not atomic with the Pi database; flush explicitly when durable filesystem synchronization is required.

Watches compare metadata every 150 ms, report `mode:"polling"`, and emit `env.watch` events with `{paths:[...]}`, `{overflow:true}` or `{error:{code,message,path?}}`. They support recursive targets, hidden/name exclusions, missing targets and replacement, including changes made through shell commands. Limits are 32 watchers and approximately 20,000 entries per snapshot. More than 512 changed paths become an overflow notification. Polling can miss transient changes between snapshots; it is not a filesystem event journal.

### Commands

`env.exec` receives `{id, owner, command, cwd, baseCwd, env, inheritEnv, timeout?, spill?}`. `command` is either a string passed to `/bin/bash -c` inside Ubuntu/PRoot, or an argv array executed directly without shell parsing. `cwd` resolves against `baseCwd`; it must be inside the workspace or temporary namespace. `env` adds/replaces guest environment variables. The host supplies Ubuntu `PATH`, workspace `HOME` and `TMPDIR`; Android ambient variables are never inherited, regardless of `inheritEnv`. `timeout` is in seconds. Stdin is closed: commands must be noninteractive.

Kotlin `ProcessBuilder` launches PRoot and captures separate stdout/stderr streams:

```json
{"event":"env.output","id":"env:12","stream":"stdout","data":"aGVsbG8K"}
```

The adapter decodes UTF-8 across chunk boundaries and calls upstream `onOutput`. Completion returns `{exitCode, spillPath?}` after output delivery. Optional `spill:{afterBytes,afterLines}` retains full combined output on disk once a threshold is exceeded; failures may also include its path. The environment sends all output chunks rather than omitting an output window; the upstream shell tool keeps its bounded model-visible tail.

Command strings execute in Ubuntu Bash; argv arrays run without shell parsing. Both are launched through the installed PRoot loader. Cancellation and timeout terminate the tracer and its guest descendants. At most eight commands run concurrently. Side effects already completed are not rolled back. See [Ubuntu runtime](ubuntu-runtime.md) for environment variables, paths, network settings and available commands.

## Legacy workspace adapter

Paths are relative to `filesDir/workspace`; `""` lists its root. Forward slashes are required. Absolute paths, drive prefixes, `..`, NUL and symbolic links are rejected; the host also limits paths to 4,096 characters. Reads require regular files and valid UTF-8. Writes create parent directories and replace the file contents. Text reads and writes are limited to 1 MiB; listings to 4,096 entries. Filesystem work runs on a separate serial worker.

The `workspace.*` methods remain for the demonstration/compatibility path. Android's normal tools now use `ExecutionEnv`; this narrower policy does not describe `env.*`. The demo write tool is unsafe to replay; read/list are replay-safe. File writes and conversation commits remain separate operations.

## Model networking

`createNativeFetch(bridge)` supplies OpenAI API-key, ChatGPT subscription and Claude subscription requests, model discovery and OAuth HTTP. It does not patch global fetch or change upstream exports. The same adapter can use the development host's RPC connection. Native adapters remain outside the upstream browser archive.

| Method | Parameters | Result |
| --- | --- | --- |
| `http.open` | `{requestId, url, method, headers:[[name,value]], hasBody}` | `null`; reserves a document-owned request |
| `http.write` | `{requestId, data}` | `null`; acknowledges a base64 upload chunk |
| `http.send` | `{requestId}` | `{status, statusText, headers:[[name,value]], url}` after native response headers arrive |
| `http.read` | `{requestId}` | `{data, done}`; one base64 response chunk or EOF |
| `http.cancel` | `{requestId}` | `null`; cancels upload, connection and pending reads |

Each data chunk contains at most 64 KiB decoded bytes. Uploads are written sequentially to private temporary files, then sent with a 64-bit Content-Length. Response reads follow `ReadableStream` demand. There is no cumulative upload or download size cap, no full-body Kotlin buffer, and no queue of pushed stream events. The existing 4 MiB bridge limit applies to individual envelopes, not complete HTTP bodies. Up to eight HTTP requests may be active, with one outstanding operation per request. Cancellation runs independently of blocked I/O. Completion and teardown release files and connections; crash leftovers are discarded at the next transport initialization.

Only the supported OpenAI/Anthropic model endpoints and exact sign-in URLs are accepted. HTTPS is required and redirects are rejected. Native HTTP manages framing and excludes browser-origin headers, cookies and browser-only direct-access flags. Provider authentication and upstream User-Agent headers remain intact. Error diagnostics are sanitized and bounded before entering durable history; that display bound does not cap transport body size. See [model access](model-access.md).

## Credentials and trusted code

The former `credentials.*`, `git.*` and `curl.*` methods and their adapters have been removed. Git and curl run as ordinary Bash commands. Old tool-credential records are retained on disk but unused; there is no automatic export into plaintext CLI configuration.

OpenAI API keys are supplied for an explicit send/resume and released afterward. ChatGPT and Claude OAuth credentials use separate encrypted host records. Credentials do not enter Pi SQLite, local storage or transcripts. HTTP authorization headers remain in memory and are not written into temporary uploads. OAuth exchanges can contain credentials in their temporary body; those private files are deleted after sending or cancellation and are never exposed as workspace files. Error responses are sanitized before Pi can persist them.

The privileged WebView loads packaged assets or a selected complete app revision. External top-level navigation is blocked, while permitted model endpoints and loopback pages can use browser networking. Safe DOM rendering prevents model output from becoming executable app code. This remains a trusted-app boundary: editable main-frame code can use native tools and access credentials; encryption does not isolate them from code running under the same app identity.

The Android UI automatically resumes saved unfinished offline runs and signed-in ChatGPT/Claude runs once saved authentication is restored or sign-in succeeds. API-key resume requires the key again and an explicit Resume. Stop clears the pending run. This startup policy is app-only: `openAppSession` still restores paused and exposes explicit `resume()`. No bridge method keeps JavaScript running after Android suspends or destroys the WebView. The ordinary browser development app uses memory storage and memory files; reloading it discards both. See [durability](durability.md).

## Authentication host

| Method | Parameters | Result |
| --- | --- | --- |
| `auth.info` | `{}` | `{hostId:"urn:uuid:...", storage:"encrypted"}` (development host: `"memory"`) |
| `auth.load` | `{provider?}` | Saved controller record or `null` |
| `auth.save` | `{provider?, record}` | `null`; maximum 64 KiB JSON |
| `auth.clear` | `{provider?}` | `null`; removes credential record, retains host ID |
| `auth.listen` | `{state}` | `{attemptId, redirectUri}`; binds an ephemeral IPv4 loopback port |
| `auth.open` | `{attemptId, url}` | `null`; validates and opens OpenAI authorization in the external browser |
| `auth.wait` | `{attemptId}` | `{url}`; the validated callback URL |
| `auth.cancel` | `{attemptId}` | `null`; cancels pending wait and releases the listener |

Each attempt lasts at most five minutes. The listener requires GET `/auth/callback`, exact `127.0.0.1:port` Host, matching state, and a code or OAuth error. Invalid callbacks leave the attempt pending. Both browser launch and callback validate the attempt's exact redirect URI; callbacks never reflect code/state in HTML or logs. Reset and teardown cancel listeners. Kotlin authentication work runs separately from the UI and SQLite workers.

`createChatGPTAuth` adapts upstream Pi's current ChatGPT OAuth protocol, uses Web Crypto for PKCE/randomness and JOSE for ID-token signature checks, verifies OpenAI issuer/audience/nonce/expiry/subject and direct-token scope, serializes refreshes and retains account/client mapping on sign-out. Android encrypts its record with AES-GCM and an Android Keystore key in `noBackupFilesDir`. The app's stable host UUID is stored separately. The app remembers one registration at a time; new-account credentials replace it only after validation.

The desktop development server implements authentication and streaming HTTP RPC under `/__pi/auth`, requiring the exact loopback Host/Origin plus a non-simple custom request header. Its endpoint policy matches Android. Auth records stay in server memory; the non-secret installation UUID is saved to ignored `.local/host-id`. Uploads use temporary files that are removed after use. The browser opens a separate sign-in window; Android launches the system browser. The browser archive and packaged app contain no Node server.

`provider` is `chatgpt` (the default for compatibility) or `claude`; records and encryption aliases are separate. Claude uses upstream Pi's PKCE copy-code flow: `auth.openExternal` opens the validated Claude authorization URL and the user pastes the returned code. Code exchange and refresh use `http.*` through the same native Fetch adapter as model requests.

| Method | Parameters | Result |
| --- | --- | --- |
| `auth.openExternal` | `{provider:"claude", url}` | Opens the validated external authorization page |

The old bounded `auth.request` and `auth.request.cancel` methods are removed. Authentication HTTP no longer has a separate body-size ceiling. Validation of credential records and protocol fields remains in the authentication controllers.
