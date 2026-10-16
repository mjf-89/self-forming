#!/bin/bash
# Assemble the Self Forming APK (debug by default) with the on-demand pi-android toolchain, then sign it with the
# Self Forming key (.signing/) so it updates the installed app in place. A rotation lineage
# (.signing/lineage.bin) is used when present; otherwise the key alone signs with v2 + v3.
# `--release` (or SELF_FORMING_BUILD=release) builds the published, non-debuggable variant with the same key.
set -euo pipefail
B=/opt/pi-android
export JAVA_HOME=$B/jdk ANDROID_HOME=$B/sdk ANDROID_SDK_ROOT=$B/sdk ANDROID_USER_HOME=$B/android-user-home \
  GRADLE_USER_HOME=$B/gradle-user-home BOX64_LD_LIBRARY_PATH=$B/x86_64/usr/lib/x86_64-linux-gnu
export PATH=$JAVA_HOME/bin:$B/gradle/bin:$PATH
root=$(cd "$(dirname "$0")" && pwd)
variant=${SELF_FORMING_BUILD:-debug}
[[ ${1:-} != --release ]] || variant=release
[[ $variant == debug || $variant == release ]] || { echo "Unknown build variant: $variant" >&2; exit 1; }
signing=$root/.signing
if [[ ! -f $signing/self-forming.p12 || ! -s $signing/password ]]; then
  echo "The permanent Self Forming signing key is missing from .signing/. Restore it before rebuilding an installable update." >&2
  exit 1
fi
cd "$root/apps/android"
gradle --no-daemon --console=plain -Dorg.gradle.jvmargs=-Xmx2g "assemble${variant^}"
if [[ $variant == release ]]; then
  # Without the Gradle env key the release APK is unsigned; it is signed below with the same .signing/ key.
  apk=app/build/outputs/apk/release/app-release.apk
  unsigned=app/build/outputs/apk/release/app-release-unsigned.apk
  [[ ! -f $unsigned ]] || mv -f "$unsigned" "$apk"
else
  apk=app/build/outputs/apk/debug/app-debug.apk
fi
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
if [[ -f $signing/lineage.bin ]]; then
  # v3 only: the lineage proves the rotation from an older key (Android 9+).
  "$tools/apksigner" sign --ks "$signing/self-forming.p12" --ks-key-alias self-forming --ks-pass "file:$signing/password" \
    --lineage "$signing/lineage.bin" --rotation-min-sdk-version 28 --min-sdk-version 28 \
    --v1-signing-enabled false --v2-signing-enabled false --out "$apk.signed" "$apk"
else
  "$tools/apksigner" sign --ks "$signing/self-forming.p12" --ks-key-alias self-forming --ks-pass "file:$signing/password" \
    --min-sdk-version 28 --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
    --out "$apk.signed" "$apk"
fi
"$tools/apksigner" verify --min-sdk-version 28 "$apk.signed"
certificate=$root/apps/android/signing-certificate.sha256
if [[ -f $certificate ]]; then
  expected=$(tr -d '[:space:]' < "$certificate" | tr '[:upper:]' '[:lower:]')
  actual=$("$tools/apksigner" verify --min-sdk-version 28 --print-certs "$apk.signed" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr '[:upper:]' '[:lower:]')
  [[ $expected =~ ^[0-9a-f]{64}$ && $actual == "$expected" ]] || { echo 'Signing certificate does not match the permanent signing key.' >&2; exit 1; }
fi
mv -f "$apk.signed" "$apk"
echo "Signed with the Self Forming key: $root/apps/android/$apk"
