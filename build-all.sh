#!/bin/bash
# Full local package: web app -> runtime -> Android APK (signed with .signing/). `--release`: non-debuggable release APK.
# With Bun and node_modules: full web build and pinned runtime download.
# Without them (inside the installed app): reuse the prebuilt dist/ that the app unpacked.
set -euo pipefail
cd "$(dirname "$0")"
bun=${BUN:-../bun-glibc/bun-linux-aarch64/bun}
if [ -x "$bun" ] && [ -d node_modules ]; then
  echo "== Web app (full build)"; "$bun" scripts/build.mjs
  echo "== Runtime"; scripts/fetch-runtime.sh
else
  echo "== Web app (prebuilt fixed modules + apps/common)"; scripts/web-lite.sh
  [ -f dist/runtime/jniLibs/arm64-v8a/libproot.so ] || { echo "== Runtime"; scripts/fetch-runtime.sh; }
fi
scripts/font-notices.sh
v=$(jq -r .version package.json); m=$(jq -r .hostVersion dist/app/app-manifest.json)
[ "$v" = "$m" ] || { echo "Manifest hostVersion $m != package $v" >&2; exit 1; }
grep -q "versionName = \"$v\"" apps/android/app/build.gradle.kts || { echo "Android versionName != $v" >&2; exit 1; }
echo "== Source"; PATH=/opt/pi-android/jdk/bin:$PATH scripts/pack-source.sh
echo "== APK"; exec ./build-apk.sh "$@"
