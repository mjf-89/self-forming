# Android host

The app runs the upstream pi harness in Android System WebView, with native SQLite, files and streaming HTTP. ChatGPT and Claude keep separate encrypted credential stores. Commands use a bundled Ubuntu filesystem through Android PRoot and its custom ELF loader; ARM64 phones also include Box64. The agent gets upstream `read`, `write`, `edit`, and `bash` tools, plus `app_update` to stage changes to its own readable JavaScript/HTML/CSS. Git/curl/rg/jq are normal Bash commands. Java, Gradle and Android build tools install on demand through `pi-android` into persistent storage.

## Build

Use JDK 17, Gradle 8.13, SDK 36. Run the browser build at the repository root, then fetch the runtime payload into `dist/runtime/`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
scripts/fetch-runtime.sh   # pinned runtime archive, see docs/runtime.md
scripts/font-notices.sh
scripts/pack-source.sh    # include editable source and the dedicated signing key when configured
cd apps/android
gradle :app:testDebugUnitTest :app:assembleDebug   # or :app:assembleRelease (not debuggable; ../../build-apk.sh --release signs it)
```

Runtime outputs stay out of Git. There is no checked-in Gradle wrapper binary.

The APK is `app/build/outputs/apk/debug/app-debug.apk`, labelled **Self Forming**. Its application ID and Kotlin namespace are `md.incept.selfforming`. VersionCode comes from `selfFormingVersionCode` in `gradle.properties`, minSdk is 28 and targetSdk is 36. Distributed APKs use a permanent key (alias `self-forming`); without signing configuration the Gradle debug key is used only for local tests. Existing installations with this application ID require the same signing identity to accept updates. See [signing](../../docs/android-signing.md).

## Native surface

- `MainActivity` admits messages only from the trusted selected app main frame, prevents external navigation and direct WebView networking, and applies system/keyboard insets once. Activity start/stop events let the UI reopen/pause its Pi Harness while keeping browser sign-in alive.
- `WebAppStore` seeds version-specific source files in the workspace, stages complete revisions, retains the previous app and rolls back unacknowledged startup. Immutable host/upstream modules stay in the APK. The native recovery row remains usable without working JavaScript. See [editable applications](../../docs/editing-app.md).
- `NativeBridge` dispatches app revisions, environment, SQLite, legacy workspace, model HTTP and authentication operations. Git/curl/connection methods are removed.
- `NativeExecutionEnv` preserves upstream files, binary readers/writers, polling watchers, output streaming/spilling, timeouts and cancellation. Its shell launch delegates to `UbuntuRuntime`.
- `UbuntuRuntime` installs the ABI-specific, digest-verified ZIP and restores file modes and links, including merged `/usr`. It binds existing workspace/temp paths, persistent `/opt/pi-android`, private `/dev/shm`, `/dev`, `/proc`, and current Android DNS. Bash strings and literal argv arrays run through PRoot; Android's ambient environment is not passed to the guest. On ARM64 the tracer dispatches x86-64 ELF programs through guest Box64.
- Kotlin `ProcessBuilder` launches PRoot and streams stdout/stderr; the app has no custom C/JNI launcher or CMake build. CI-built `libproot.so` and `libproot-loader.so` are extracted by Android into `nativeLibraryDir`. No executable loader is extracted to writable storage. PRoot is patched for kernel-enforced tracee cleanup on tracer death.
- `SqliteStore` serializes native connections across Activity recreation; bundled SQLite supports the upstream schema. Transactions and cleanup retain their existing semantics.
- Model, catalog and authentication requests share the native Fetch adapter with disk-backed uploads, pull-based responses and no total HTTP body cap. CLI curl uses Ubuntu certificates separately. No production OkHttp or libgit2 remains.
- `NativeAuth` and `AuthStore` retain browser OAuth, the loopback listener, the temporary sign-in service and Android Keystore storage.

See [runtime](../../docs/runtime.md) and [bridge protocol](../../docs/bridge.md) for limits. PRoot does not isolate untrusted code from the app's Android UID.

## Tests

```sh
gradle :app:testDebugUnitTest          # JVM tests
gradle :app:connectedDebugAndroidTest  # instrumentation, needs a device or emulator
```

Instrumentation checks the packaged loader against writable-path `execve` restrictions, nested binaries/scripts, installed CLI programs, Git local workflows, binary curl upload/download, TLS, detached-child cancellation, the upstream environment suite in WebView, SQLite, Keystore, sign-in lifecycle and keyboard layout. A compiled arm64 payload is not proof of behavior on a physical arm64 phone.
