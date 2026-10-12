# Self Forming

**An Android app you shape by chatting with an agent.** Describe what you need, and the agent changes the app
itself to match. It is powered by [pi-durable](https://github.com/earendil-works/pi) from the open-source
pi project.

Self Forming opens directly into the **chat**, with Settings and the conversation tree available when needed.

## Features

- **Chat.** Talk to the agent in plain language. Its thinking and tool calls appear as quiet, collapsible
  rows. Sign in with ChatGPT or Claude Code, or use an OpenAI API key, from the in-chat Settings.
- **Conversation tree with subagents.** Conversations are durable and can branch. The agent can hand work to
  subagents, and their results come back into the conversation.
- **Background replies.** A reply keeps running when you leave the app or lock the screen, and is waiting
  when you return.
- **Self-editing.** The agent can edit the app's own readable JavaScript, HTML and CSS and apply the change.
  The previous version is kept; a failed start rolls back automatically. You can also restore the previous or
  the original app from Android Settings → Apps → Self Forming → gear icon. Conversations, sign-in and files
  are kept.
- **A real Linux shell.** Commands run in a bundled Ubuntu 24.04 environment (PRoot, plus Box64 on ARM64)
  with git, curl, ripgrep and jq. Java, Gradle and the Android SDK can be installed on demand, so the app
  can rebuild itself on the phone.

Download the ARM64 Android APK from [GitHub Releases](https://github.com/mjf-89/self-forming/releases). Android 9 or later is required.

## Build

Requirements: JDK 17, Gradle 8.13, Android SDK 36, Node.js 24 and pnpm.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build                       # web app → dist/app
scripts/fetch-runtime.sh         # runtime → dist/runtime
scripts/pack-source.sh           # clean source → embedded rebuild archive
cd apps/android && gradle assembleDebug
```

The APK is `apps/android/app/build/outputs/apk/debug/app-debug.apk`. The application ID is
`md.incept.selfforming`.

The web build clears `dist/`, so fetch the runtime afterwards. `package.json` `version` and the Android
`versionName` must match (`build-all.sh` checks this).

### Runtime

The Ubuntu/PRoot/Box64 payload is not rebuilt. `scripts/fetch-runtime.sh` downloads a pinned archive from a
GitHub release (`runtime-source.env`), verifies its SHA-256 and unpacks it into `dist/runtime/`. Set
`GH_TOKEN` if the release repository is private. `scripts/package-runtime.sh` creates the archive. See
[docs/runtime.md](docs/runtime.md).

### Signing

The release pipeline uses a permanent dedicated key and refuses to publish with an automatically generated debug key. Each new version is published once after fast web checks, Android JVM tests and APK verification pass. Runtime compilation and emulator tests are not part of the regular build. See [release CI](docs/release-ci.md).

Gradle builds are signed with the Gradle debug key unless configured. APKs built with `./build-all.sh` are signed afterwards by `build-apk.sh` with the key in `.signing/` (see below). To use your own key set
`SELF_FORMING_KEYSTORE_PATH` and `SELF_FORMING_KEYSTORE_PASSWORD` (PKCS#12, alias `self-forming`). See
[docs/android-signing.md](docs/android-signing.md).

### Building on the phone

The APK carries its own source and unpacks it to `workspace/self-forming` on first launch. After
`pi-android install --accept-licenses`, the agent can run `./build-all.sh` there (it uses `scripts/web-lite.sh`
when Bun and `node_modules` are missing) and install the result over the running app. Because the source,
including the `.signing/` key, is inside the APK (see Security and signing below). The agent follows the skill [skills/self-rebuild/SKILL.md](skills/self-rebuild/SKILL.md); the Android build tools start installing in the background on the first start, and by using Self Forming you accept the [Android SDK License](https://developer.android.com/studio/terms) that install accepts for you.

## Security and signing

The dedicated signing key for `md.incept.selfforming` (`.signing/self-forming.p12`, alias `self-forming`, password in
`.signing/password`) ships **inside APKs on purpose** (`assets/self-source/source.zip`), so the
app can rebuild and update itself on the phone. This is an experiment, not a secure distribution scheme:

- Anyone who has an APK can extract the key and sign an update that Android installs over the app. Such an
  APK inherits the app's data (secrets, conversations, sign-ins) and every permission the user granted it.
- Install Self Forming only from the official GitHub releases and check the APK's SHA-256 against the value
  published with the release (`sha256sum self-forming.apk`). Do not install APKs from other sources, even if
  they claim to be Self Forming updates.
- Do not reuse this key for anything else. `.signing/` is gitignored; if you fork this project, generate
  your own key with `keytool` (PKCS12, alias `self-forming`, RSA 4096) and decide whether to ship it.
- `build-apk.sh` signs (v3, Android 9+) with the key alone, or with a rotation lineage if `.signing/lineage.bin` exists.

## Documentation

- [AGENTS.md](AGENTS.md): design and implementation guidelines for the agent and contributors.
- [docs/editing-app.md](docs/editing-app.md), [docs/bridge.md](docs/bridge.md),
  [docs/durability.md](docs/durability.md), [docs/model-access.md](docs/model-access.md).
- [apps/android/README.md](apps/android/README.md): the native host.

## Credits

Self Forming is built on [pi](https://github.com/earendil-works/pi) by Earendil Works and Mario Zechner,
specifically `pi-ai`, `pi-durable` and `chord`, which provide the agent harness, model access and durable
conversations. Third-party licenses are in [third-party/](third-party/) and
[dist/app/THIRD_PARTY_NOTICES.md](dist/app/THIRD_PARTY_NOTICES.md) after a build.

## License

MIT. Copyright (c) 2026 Marco Jacopo Ferrarotti and Self Forming contributors. See [LICENSE](LICENSE).
