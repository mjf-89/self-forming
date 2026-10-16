# Release pipeline

The public repository is `mjf-89/self-forming`. **Self Forming** uses application ID `md.incept.selfforming` and the `selfforming` sign-in return scheme.

`Self Forming release` runs on pushes to `main`, pull requests and manual dispatch. One ARM64 job installs locked dependencies, runs type checking and the fast JavaScript tests, builds web assets, restores the checksum-pinned runtime, runs Android JVM tests and builds the APK. No emulator, Docker, runtime compilation or duplicated web build runs on the normal path. Dependency, runtime and Gradle caches speed up subsequent runs.

## First repository setup

The source is prepared for this public repository; preparing or committing it does not upload runtime assets or configure Actions secrets. Before the first successful distribution build:

1. Configure temporary Actions secret `RUNTIME_IMPORT_URL` with a short-lived HTTPS URL granting access to the one verified runtime tar asset. Run `Import pinned ARM64 runtime` on `main` with `source_format=tar`, `source_sha256=8940716a5faf1c5d27bde5cf5b82a5151d1523296b5f3e27408c08eecf0a8ae1`, `runtime_tag=runtime-ubuntu-24.04-2`, and no `rebrand_from`. The workflow verifies the download and its runtime members, then publishes the exact downloaded bytes as `self-forming-runtime-arm64-v8a.tar.gz`, plus `SHA256SUMS`. It does not repackage that tar, so `runtime-source.env` remains valid. Remove `RUNTIME_IMPORT_URL` afterward. The single-asset URL needs no cross-repository personal token and is not logged. A cold APK build cannot download the runtime until this release exists.
2. Configure Actions secrets `SELF_FORMING_KEYSTORE_BASE64` and `SELF_FORMING_KEYSTORE_PASSWORD` from the permanent PKCS#12 identity whose public fingerprint is committed in `apps/android/signing-certificate.sha256`. Keep alias `self-forming`. Git commits do not transfer repository secrets.
3. Run the release workflow after these prerequisites exist. Main builds fail if signing secrets are absent; pull requests build an unsigned release APK and do not publish it. Published APKs are `assembleRelease` (not debuggable), signed with that same key so installed apps keep updating in place; Gradle fails without `selfFormingVersionCode`.

The runtime is public and needs no cross-repository credential. CI uses its scoped repository token; local builds can fetch the public asset without a token. An existing app with the same application ID but a different signing certificate cannot be updated by these APKs.

## Checked downloads

The permanent key is temporarily restored to `.signing` so the embedded source can rebuild and sign the app on the device. Git metadata, host credentials and unrelated private files are excluded from that snapshot. The runner removes its temporary key files after the build. Pull requests never restore signing secrets.

The checked downloads are `self-forming-<version>-arm64.apk`, the independent upstream browser bundle, a verification report and `SHA256SUMS`. The publish job requires a public repository, verifies the build still matches `main`, and creates `v<package version>` as a normal release using the exact checked artifacts. Existing releases are left unchanged. For the next release bump `package.json`, Android `versionName`, `selfFormingVersionCode`, and add `docs/releases/<version>.md`. These committed versions also ship in the embedded source.

The APK deliberately includes its self-rebuild signing key and password. Anyone who downloads it can extract that identity and sign a compatible update. The certificate check preserves build consistency; it does not distinguish an official build from another build signed with that extracted key. Source archives generated from Git do not contain the key.

## Runtime maintenance

The manual `Import pinned ARM64 runtime` workflow accepts a verified APK (`source_format=apk`, the default) or standalone runtime tar (`source_format=tar`). For either import, temporarily configure `RUNTIME_IMPORT_URL` with a short-lived download URL and supply its independently known `source_sha256`. The workflow checks the full asset digest, extracts only allowed runtime files and licenses, and verifies the rootfs manifest before publishing. A tar import without rebranding preserves the original archive bytes. APK imports and rebranding package the resulting runtime into a new tar. Remove the temporary URL secret afterward and update `runtime-source.env` if the output checksum changes.

Leaving the source hash blank reuses and packages the currently pinned runtime, so that route requires the pinned public asset to exist already; `source_format` is ignored in this mode. The optional previous-identifier input migrates inherited runtime metadata to Self Forming naming and checks the complete payload before publishing a new runtime tag. Existing tags and releases are never overwritten. The release targets the dispatched `main` commit, refuses to publish if `main` has advanced, and is not marked as the latest app release. This step is independent of normal APK builds.

Fast checks do not replace a device test. Before sharing a release, check sign-in return, self-update, interruption/reopen, subagent completion and server recovery on an ARM64 Android device.
