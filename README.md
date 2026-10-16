# Self Forming

**An app you shape by talking to it.** Tell it what you need (a recipe book, a trip planner, a shop counter) and an AI
agent changes the app itself to fit. It runs on your Android phone, or in a browser tab.

> **Experimental.** Self Forming is a research project. The agent can edit the app's own code and run commands, things
> can break, and the app may change under you. Don't rely on it for anything important yet, and keep your own backups.

## Try it

**In a browser (nothing to install):** <https://demo.selfforming.incept.md>. Everything runs inside the page; your chats
stay in your browser. Some model providers block browsers, so signing in may take an extra step (the app guides you).

**On Android (the full version, with a real Linux shell):**

1. On your phone, open the [latest release](https://github.com/mjf-89/self-forming/releases/latest) and download
   the APK file (about 75–90 MB). Optionally compare its SHA-256 with `SHA256SUMS` on the same page.
2. Open the file. Android will ask to allow installs from this source ("unknown sources" / "install unknown apps").
   Allow it for your browser or file manager only for this install. Self Forming is not on Google Play.
3. Open **Self Forming**, tap the model name at the bottom to sign in, and start chatting.

Needs Android 9 or later and a 64-bit ARM phone (most phones from the last years).

## What it costs

Self Forming itself is free. The AI that powers it is not: you need **your own account or key** with a model provider, such
as a ChatGPT or Claude subscription, or an OpenAI API key. Usage is billed or limited by that provider. Sign-in happens
in the app's Settings; keys are stored encrypted on the device.

## What it does

- **Chat** with an agent in plain language. Its thinking and tool use show as quiet, collapsible rows.
- **Keeps working in the background:** a reply continues if you lock the screen.
- **Conversations branch**, and the agent can hand work to helper agents.
- **Reshapes itself:** it edits the app's own pages and applies the change. The previous version is kept, a failed
  start rolls back automatically, and Android Settings → Apps → Self Forming has a restore option. Your chats are kept.
- **Linux tools on Android:** commands run in a bundled Ubuntu environment (git, curl, ripgrep, jq…).

### The Android build tools

To rebuild itself, the app can download the Java, Gradle and Android SDK build tools (a few hundred MB, installed on
the phone in the background after the first start). By using Self Forming you accept the
[Android SDK licence](https://developer.android.com/studio/terms) on their behalf. Everyday use needs none of this;
only changes to the app's native (Kotlin) layer do.

## About the signing key (please read)

Self Forming can rebuild and update itself on your phone. To make that possible, every Self Forming APK
contains its own signing key. This is an experiment, and it has one important consequence:

- Anyone who has a Self Forming APK can extract that key and make an APK that Android accepts as an
  "update". Such an app would get everything Self Forming has: your conversations, sign-ins, saved
  secrets and the permissions you granted.
- So **only install Self Forming APKs from the official release page**
  (https://github.com/mjf-89/self-forming/releases) and check the SHA-256 against the `SHA256SUMS`
  file published there. Never install a "Self Forming update" that reaches you any other way.
- Updates the app builds for itself on your phone are fine: they never leave your device.

## Privacy

Self Forming has no servers of its own and no analytics. Your conversations, files and keys stay on your device. What
leaves it:

- **Messages and files you ask the agent to read**, sent to the model provider you chose (OpenAI, Anthropic, …), under
  that provider's terms.
- **Anything the agent fetches or installs on your request** (web pages, git repositories, downloads), and the one-time
  download of the build tools above.
- **Tor, Snowflake and Tailscale** traffic only if you turn those network routes on in Settings. Tor and Snowflake are
  experimental and no anonymity guarantee is made.

Because the agent can run commands and edit its own code, only give it access (including Secrets in Settings) that you
are comfortable with.

## For developers

Plain browser JavaScript modules, no framework. Requirements for a full build: JDK 17, Gradle 8.13, Android SDK 36,
Node.js 24, pnpm. The quick path is `pnpm install --frozen-lockfile --ignore-scripts && pnpm build`, then
`scripts/fetch-runtime.sh`, then Gradle in `apps/android`; details are in [docs/](docs/):

- [AGENTS.md](AGENTS.md): design and implementation guidelines.
- [docs/editing-app.md](docs/editing-app.md), [docs/plugins.md](docs/plugins.md), [docs/bridge.md](docs/bridge.md),
  [docs/durability.md](docs/durability.md), [docs/model-access.md](docs/model-access.md), [docs/runtime.md](docs/runtime.md).
- [docs/android-signing.md](docs/android-signing.md) and [docs/release-ci.md](docs/release-ci.md): signing and releases.
- [apps/android/README.md](apps/android/README.md), [apps/browser/README.md](apps/browser/README.md).

## Credits and licences

Built on [pi](https://github.com/earendil-works/pi) by Earendil Works and Mario Zechner (`pi-ai`, `pi-durable`, `chord`).
Third-party components and their licences are indexed in [THIRD_PARTY.md](THIRD_PARTY.md); the browser Linux image's GPL
source offer is [docs/gpl-source-offer.md](docs/gpl-source-offer.md).

MIT. Copyright (c) 2026 Marco Jacopo Ferrarotti and Self Forming contributors. See [LICENSE](LICENSE).
