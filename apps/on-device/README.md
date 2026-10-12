# Default application source

This is the production application packaged by `pnpm build` into `dist/app/` and then included in the Android APK.

It is the editable on-device JavaScript, HTML and CSS: one chat screen with the conversation drawer, a Settings dialog (models, secrets, background work, app editing) and the agent tools (files, Bash, servers, subagents, app updates).

## Development

Edit these plain browser modules and styles directly. Read the root `AGENTS.md` for design and safety guidelines. The build discovers top-level JavaScript modules and HTML/CSS assets automatically and lists them in `app-manifest.json` as editable files. `native-host.js` and `library/` are still fixed host-provided modules; do not copy or modify them here.

`app-session.js` must remain a simple re-export of `session.js`. The builder generates that compatibility facade. When changing core conversation behavior, update the applicable tests as well.

No credentials, keys, browser data, conversations, CLI binaries, dependency installs or other workspace content are shipped by this source directory. A fresh installation starts with empty personal data. In particular, the secret-storage key at `.pi-secrets/vault.key` is generated at runtime, outside application revisions.

## Validation

Run the repository build and tests with its supported Node.js/pnpm toolchain. Android packaging takes its assets from `dist/app/`; no separate override or manual snapshot copy is needed. A new APK still needs to be built and installed to test fresh-install behavior on a device.
