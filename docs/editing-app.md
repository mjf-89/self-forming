# Edit the app on the phone

Android keeps a readable copy of the app's JavaScript, HTML and CSS in the agent workspace. Ask the agent to change those files and apply the update. No compiler, npm install or APK rebuild runs on the phone. The stable Kotlin host, native bridge adapters and pinned upstream Pi browser modules still come from the APK.

For example:

> Change this app's accent colour to purple. Use app_update to find the editable source, edit the CSS, and apply the update.

The `app_update` tool has two actions. `info` returns the source directory and selected revision. `apply` stages the edited files and ends the current agent turn. After Pi saves that tool result and the turn becomes idle, the application closes its Harness and SQLite connection, selects the revision and reloads. The conversation and sign-in remain in native storage. The next prompt runs in the edited application. Applying is deliberately not replay-safe: an interrupted stage does not automatically activate an unreviewed snapshot on restart.

You can also open **Agent settings → Edit this app → Apply edits** while the agent is idle. If backgrounding interrupts an update before reload, return and apply the edits again. **Previous version** and **Original app** restore working code. The native **App recovery** button above the page remains available even if edited JavaScript fails to start. Recovery changes the code selection; it keeps conversations, credentials, workspace files and the editable draft.

## Files and loading

The editable source is `filesDir/workspace/.self-forming/app/<host-version>/`. Use the exact absolute `sourcePath` returned by `app_update` or shown under **Editable files**. It contains `index.html`, `app.css` and readable ES modules including `app.js`, `session.js`, `native-tools.js`, the conversation views and the update controller. These are ordinary JavaScript files, with relative imports. Add local modules and assets as needed; retain the initial required files. Use existing upstream exports through `./library/` and fixed native adapters through `./native-host.js`.

The desktop build transpiles the repository's TypeScript to this readable JavaScript once. It does not combine app code into an opaque bundle. The separate reusable browser archive continues to expose the exact upstream Pi APIs and does not contain the application controller.

The WebView URL stays `https://appassets.androidplatform.net/assets/web/index.html`. Kotlin serves a complete staged revision behind that URL, so the origin and relative imports remain stable. It never serves the live draft while files are being edited. Library files and `native-host.js` always come from APK assets. Revisions live under `noBackupFilesDir/web-app/<host-version>/revisions/`; the selected revision is persisted with an atomic file replacement. Each document keeps its own revision until reload.

Staging rejects symbolic links, path traversal, replacement of fixed modules, missing required files and oversized revisions. Limits are 256 files, 4 MiB per file and 16 MiB total. It records content hashes and validates them before activation. This checks a complete snapshot, not JavaScript correctness. A new revision must acknowledge successful application startup after reopening its saved session. Failure to do so within 30 seconds spent in the foreground restores a working revision; Activity recreation also rolls back unacknowledged startup.

Each APK host version has a separate draft and revision selection. Installing a newer APK starts its bundled app and seeds a fresh matching source directory; older edits remain in the workspace for manual migration. It does not run code written against an older host automatically.

## Boundaries

Kotlin changes, Android permissions, new native capabilities, the Alpine payload, native bridge adapters and upstream Pi upgrades still require an APK. This release adds no runtime package installer, browser compiler or background agent service.

Edited code has the same bridge access as the original application. This is trusted app development, not isolation for untrusted extensions. Restoring code does not undo file changes, network requests or other side effects that code has already performed. Startup acknowledgment catches failed boots, not every possible behavior bug. The native recovery button remains the fallback after a revision has acknowledged startup.
