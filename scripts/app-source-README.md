# Editable Self Forming application

This directory contains readable JavaScript, HTML and CSS. Edit these files directly;
the phone does not need TypeScript, a package manager, Node.js, Bun or a build step.
The default application is packaged from apps/common/ in the repository: a single
chat screen with the conversation drawer (left) and a Settings dialog. There is no
home screen, file editor or terminal.

- app.js starts the UI; session.js owns the durable conversation and the agent's tools.
- index.html, app.css (shared base) and the plugins' CSS (builtin/<id>/web/*.css, bundled by builtin-styles.css; the look is the plugin look-*) define the interface without a UI framework.
- Other .js files are ordinary modules. Keep relative imports ending in .js.
- builtin/<id>/web/ holds the built-in plugins (plugins/<id>/ in the repository); builtin-plugins.js is their
  generated registry. These files import shared modules as ../../../name.js and the library as ../../../library/.
- app-session.js is a compatibility entrypoint that re-exports session.js.
- native-host.js and library/ are supplied by the installed APK. Import them
  normally; do not copy, edit or rebundle them into the application.

app-manifest.json lists the initial editableFiles and the fixed immutableFiles.
Keep every initial editable file; additional plain JavaScript modules and local
assets can be added here and are served from the applied revision. Fixed host
files and library/ cannot be replaced. Changes need to use the native capabilities
already provided by this APK. Kotlin, permissions and native libraries still need
an APK update. Upstream library and storage schema changes also stay with the APK.

How to change the app (agents):
1. app_update info -> sourcePath (this folder). Edit files here.
2. Check the edits, then call app_update apply alone as the final step. The app
   reloads by itself once the reply ends; nothing to background or reopen.
3. Applied revisions win over the APK's bundled web files while the host version
   stays the same. A new APK with the same version keeps showing the last applied
   revision: re-apply (after merging) or bump the version when rebuilding.

Activation uses a complete revision so an edit cannot mix old and new modules.
Keep saved conversation data outside these code revisions. A code rollback
does not reverse changes to workspace files or conversation data.

Changes here are not automatically copied to the repository (apps/common/ and plugins/ in
<workspace>/self-forming; scripts/sync-builtins.sh from-live <this folder> does it) nor committed to Git. Copy them there before rebuilding
the APK, or the rebuilt app (and every app built from it) loses them.
