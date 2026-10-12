# Runtime payload

Self Forming runs shell commands in a bundled Ubuntu 24.04 ARM64 root filesystem through Android PRoot.
Box64 runs supported x86-64 programs inside that environment. The build reuses a verified, pinned payload;
it does not rebuild Ubuntu, Box64 or PRoot for each APK.

## Contents

`scripts/fetch-runtime.sh` prepares `dist/runtime/`:

| Path | Purpose |
| --- | --- |
| `jniLibs/arm64-v8a/libproot.so`, `libproot-loader.so` | PRoot and its ELF loader, packaged as Android native libraries. |
| `assets/runtime/ubuntu-arm64-v8a.zip` | Ubuntu 24.04 root filesystem with Box64 and command-line tools. |
| `assets/runtime/ubuntu-arm64-v8a.json` | File, directory and link metadata, sizes and the root filesystem archive digest. |
| `assets/licenses/*` | Runtime component licenses. |

The runtime contains bash, git, curl, ripgrep, jq and core utilities. Java, Gradle and Android SDK components
install separately when needed; they are not included in this payload.

## Download and verification

The pin in `runtime-source.env` identifies a GitHub release asset through `RUNTIME_REPO`, `RUNTIME_TAG`,
`RUNTIME_ARCHIVE` and `RUNTIME_SHA256`. `RUNTIME_FORMAT=tar` selects the standalone runtime archive.
`RUNTIME_FORMAT=apk` also supports importing the runtime from an existing APK; in that format only ARM64
PRoot libraries, the root filesystem archive and manifest, and license files are copied. The APK's app
code, UI, embedded source, signing files and other ABIs are excluded.

For a one-time import, `RUNTIME_PIN_FILE=/path/to/checked-pin.env` selects a separate pin file without
changing the committed source. The same asset checksum and member checks apply.
An optional `RUNTIME_DOWNLOAD_URL` can supply a short-lived HTTPS asset URL for that import. This route
sends no repository authorization header and does not print the URL. The complete asset must still match
the pin's SHA-256. Keep signed URLs in temporary secrets, then remove them after the import.

The script verifies the entire downloaded asset before reading members. It streams each allowlisted member
into a temporary directory without extracting archive links or arbitrary paths, rejects duplicate members,
then checks the manifest's schema, distribution, release, ABI, size and root filesystem SHA-256. Only a
validated result replaces `dist/runtime/`. `.runtime-cache/` holds the downloaded asset between builds.

Run `scripts/fetch-runtime.sh [cache-dir]` with Bash, curl, jq, coreutils, and GNU tar installed. APK imports
also require unzip. These tools are available in the Ubuntu execution environment and the Linux CI image;
the fetch script needs neither Node.js nor Python. A private source repository needs `GH_TOKEN` with access
to its releases. CI can use its repository token when the runtime lives in the same repository.

## Packaging a standalone runtime

1. Prepare and verify the payload in `dist/runtime/`.
2. Run `scripts/package-runtime.sh /tmp/runtime-out` (requires Bash, jq, coreutils, GNU tar and gzip).
3. Attach `/tmp/runtime-out/self-forming-runtime-arm64-v8a.tar.gz` to a runtime release.
4. Set `RUNTIME_FORMAT=tar`, the release repository/tag, `RUNTIME_ARCHIVE=self-forming-runtime-arm64-v8a.tar.gz`,
   and the SHA-256 printed by the packaging script in `runtime-source.env`.
5. Run `scripts/fetch-runtime.sh` to verify the new pin before using it for APK builds.

The packager always uses the standalone runtime filename, even if the imported asset was an APK. It selects
only runtime libraries, the matching root filesystem archive and manifest, and regular license files.
Sorted members, fixed timestamps and ownership, and `gzip -n` make repeat packaging reproducible.

## Importing or transferring an existing asset

The manual `Import pinned ARM64 runtime` workflow accepts `source_format=apk` (the default) or
`source_format=tar`, together with the full asset's independently known `source_sha256`. Set the temporary
Actions secret `RUNTIME_IMPORT_URL` to a short-lived HTTPS URL for that single asset. The download sends
no repository token to that URL and does not log it; no cross-repository personal token is needed. Remove
the temporary secret after the import.

Both formats pass the same full-asset digest, allowed-member, license-file and rootfs-manifest checks in
`scripts/fetch-runtime.sh`. For a tar import with no `rebrand_from`, the workflow publishes the verified
download directly, byte for byte, with a generated `SHA256SUMS`. It does not run the packager on that path.
This preserves an existing pin when transferring the runtime to a new public repository. APK imports
and imports requesting rebranding package the verified extracted payload into a new standalone tar;
use the resulting checksum when updating the pin.

For initial public setup, use `source_format=tar`, `runtime_tag=runtime-ubuntu-24.04-2`, no rebranding,
and the SHA-256 committed in `runtime-source.env`. This works before that repository has a runtime
release, because the temporary URL supplies the source asset. See [release setup](release-ci.md).

The workflow refuses existing tags/releases and checks that the dispatched commit is still `main` before
publication. It creates the runtime release at that commit with `latest=false`, keeping the app's release
as the latest download.

The manual runtime workflow can also reuse the committed pin by leaving `source_sha256` blank; this
requires the pinned runtime release to exist already and ignores the source-format choice.
Its optional previous-identifier input runs `scripts/rebrand-runtime.py` before packaging: metadata paths
and their references are renamed, the rootfs manifest and archive digest are regenerated, and an exact
same-length PRoot fallback-path replacement preserves the executable layout. Unexpected binary matches
stop the migration. The final payload is scanned for the previous identifier before it can be published.
This migration runs only when preparing a new runtime, not on every APK build.
