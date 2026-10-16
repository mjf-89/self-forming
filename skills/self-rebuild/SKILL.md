---
name: self-rebuild
description: Rebuild and reinstall Self Forming itself (native Kotlin + web) on this phone with the Android SDK
---

# Rebuild Self Forming on this phone

Use this when a change needs more than `app_update` can do. Apply and show the web-layer steps first (small `app_update` increments), and keep a rollback path (the previous APK/revision, a commit) before installing a native build; delegate independent pieces to subagents but build and install yourself. `app_update` only swaps the web layer (the JS/HTML/CSS in the live web app). Rebuild the full APK for: Kotlin/Java changes, `AndroidManifest.xml` or new permissions, `packages/native-host` changes, new native bridge methods, Gradle/dependency changes. For web-only edits prefer `app_update`; it is much faster.

## Where things are

The app installs as `md.incept.selfforming`, with its own data and signing identity. Absolute paths below use its workspace, `/data/data/md.incept.selfforming/files/workspace`; use the equivalent workspace path in your current instructions if Android reports an alias.

- Source repository: `/data/data/md.incept.selfforming/files/workspace/self-forming`. The app unpacks it from its own APK on first launch (`SelfSource`, never overwriting your work). Its `dist/` (prebuilt web app, runtime payload, `source.zip`) is refreshed from every newly installed APK.
- Web source to edit: `apps/common/` in that repository. Kotlin: `apps/android/` (host) and `plugins/<id>/native/src/` (the built-in plugins' Kotlin, same package; manifest fragments in `plugins/<id>/native/manifest.xml`).
- Live web app (what the running app loads, edited with `app_update`): the `sourcePath` returned by `app_update` with action `info`. Keep it in sync with `apps/common`: after editing one, copy the same change to the other; otherwise the rebuilt APK or the live app loses it.
- Signing key: `/data/data/md.incept.selfforming/files/workspace/self-forming/.signing/` with `self-forming.p12` (PKCS12, alias `self-forming`) and the password in the file `password`. `build-apk.sh` uses this permanent signing identity automatically and refuses to build an installable update if it is missing. Never print, commit or send the key or the password. It is gitignored. If the folder is missing, restart the app: it restores `.signing/` from the APK. Do not generate a replacement key.
- This skill: `/data/data/md.incept.selfforming/files/workspace/self-forming/skills/self-rebuild/SKILL.md`.
- Toolchain install log: `/data/data/md.incept.selfforming/files/workspace/.self-forming/toolchain.log` (lock: `toolchain.lock` next to it).

## Self-check before building

```sh
ls -la /data/data/md.incept.selfforming/files/workspace/self-forming/.signing   # self-forming.p12 and password
pi-android status                                                                # JDK, Gradle, SDK + "Android platform ..." line
```

If `pi-android status` does not end with an `Android platform …, build tools …` line, the toolchain is not ready:

1. The app starts the install in the background at every start until it is done (the user accepted the Android SDK License by using the app). Check progress: `tail -n 5 .../workspace/.self-forming/toolchain.log` and `pgrep -f "pi-android install"`. It resumes after interruptions and reuses verified downloads; a few GiB and several minutes.
2. If nothing is running and the log shows a failure, run it yourself in the background: `(pi-android install --accept-licenses && pi-android doctor) > /data/data/md.incept.selfforming/files/workspace/.self-forming/toolchain.log 2>&1 < /dev/null &`, then poll with short commands.

## Steps

1. **Edit** the source (`apps/common` for web, `apps/android` for Kotlin) and sync the live web app (see above).
2. **Version.** `version` in `package.json` must equal `versionName` in `apps/android/app/build.gradle.kts` (`./build-all.sh` fails otherwise). **Increase `selfFormingVersionCode` in `apps/android/gradle.properties` by 1 for every APK you install**, or Android refuses it as not newer. Bump the version name when the web layer changes too, otherwise editable-app revisions of the old version mask the new UI.
3. **Build** in the background; one Bash call must not run for minutes:
   ```sh
   cd /data/data/md.incept.selfforming/files/workspace/self-forming
   (./build-all.sh > /tmp/rebuild.log 2>&1; echo "exit $?" >> /tmp/rebuild.log) &
   ```
   It takes 3–10 minutes; the first Gradle run (downloads dependencies) longer. Poll with short commands: `sleep 20; tail -n 5 /tmp/rebuild.log`. Finished when the log ends with `exit 0` (`exit` other than 0: read the errors above it, fix, rebuild).
3b. **Release variant (only for published APKs).** `./build-all.sh --release` builds the non-debuggable release APK, signed with the same key, at `apps/android/app/build/outputs/apk/release/app-release.apk`. On-phone rebuilds normally use the default debug build above.
4. **Signing.** Keep the public fingerprint file `apps/android/signing-certificate.sha256` present. `build-apk.sh` requires `.signing/`, signs with v2 + v3 (or v3 with the rotation `lineage.bin` if present), verifies the APK signature, and compares its signer certificate SHA-256 digest against that pinned fingerprint. The certificate name alone does not identify the key. If the key is missing or the fingerprint does not match, stop and restore the correct signing identity; do not bypass the check or distribute a debug-signed replacement.
5. **Keep the previous build** for recovery: copy the finished APK, e.g. `mkdir -p ../self-forming-apks && cp apps/android/app/build/outputs/apk/debug/app-debug.apk ../self-forming-apks/self-forming-<versionName>-<versionCode>.apk`. Do this for every build that works.
6. **Install** with the `app_install_apk` tool, path `self-forming/apps/android/app/build/outputs/apk/debug/app-debug.apk` (only this installed app's package is accepted). Tell the user first: Android shows a confirmation they must accept (the first time also "allow Self Forming to install unknown apps"; then call the tool again). Finish your reply before calling it: the app restarts after the install and the conversation is saved.
7. **Verify** in the next conversation turn: `cat /data/data/md.incept.selfforming/files/workspace/self-forming/dist/.installed-apk` starts with the new `versionName` (written by the app on the first start after the install), and the changed behaviour works. Report the result to the user.

## Recovery

- Broken web layer after the update: the user opens Android Settings → Apps → Self Forming and taps the gear (Self Forming settings), then "Restore previous version" (or "Restore original app"). Conversations and files are kept.
- Broken or crashing APK: install a compatible earlier APK again. Candidates: `/data/data/md.incept.selfforming/files/workspace/self-forming-apks/` (your saved builds), `self-forming/apps/android/app/build/outputs/` (the last build), or an APK from `mjf-89/self-forming` (check its SHA-256). Use `app_install_apk` if the app still runs; otherwise the user opens the APK file from the Files app.
- A lower `selfFormingVersionCode` cannot be installed over a higher one; fix forward with a higher code.

## Rules

- Do not touch other apps or install other packages; `app_install_apk` refuses them anyway.
- Never reveal `.signing/` contents. Anyone with the key can sign updates that inherit this app's data and permissions.
- Do not commit unless the user asks; if they do, ask for their git name and email first.
