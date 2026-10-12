#!/bin/bash
# Web layer without Bun/node_modules: start from the installed app's prebuilt dist/app (unpacked by the
# app on first launch) and overlay the plain JS/CSS/HTML from apps/on-device. Fixed modules
# (native-host.js, library/) are reused as-is; changing packages/native-host needs the full build (scripts/build.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/app/app-manifest.json ] || { echo "dist/app is missing; open the app once so it unpacks its prebuilt files." >&2; exit 1; }
version=$(jq -r .version package.json)
names=$(cd apps/on-device && ls *.js *.css *.html | jq -R . | jq -s 'sort')
# Drop editable files that no longer exist in apps/on-device (removed features) so they are not packaged.
for old in $(jq -r --argjson e "$names" '(.editableFiles - $e)[]' dist/app/app-manifest.json); do rm -f "dist/app/$old"; done
# Refuse to package a stylesheet or module that does not parse: a single syntax error (e.g. a line break inside a
# quoted url) makes the WebView drop the rest of the stylesheet and the app shows up unstyled.
bun=${BUN:-$(command -v bun || true)}
[ -n "$bun" ] || for candidate in ../devhub/bun ../bun-glibc/bun-linux-aarch64/bun; do [ -x "$candidate" ] && bun=$candidate && break; done
if [ -n "$bun" ]; then
  check=$(mktemp -d)
  for f in apps/on-device/*.css apps/on-device/*.js; do
    "$bun" build "$f" --outdir "$check" --external "*" >/dev/null 2>"$check/err" || { echo "Syntax error in $f:" >&2; tail -5 "$check/err" >&2; rm -rf "$check"; exit 1; }
  done
  rm -rf "$check"
else
  echo "Warning: no bun found; skipping the CSS/JS syntax check." >&2
fi
cp apps/on-device/*.js apps/on-device/*.css apps/on-device/*.html dist/app/
cp scripts/app-source-README.md dist/app/app-source-README.md
# Bundled fonts (SIL OFL) are fixed assets: copied as-is and listed as immutable so they are served from the APK.
rm -rf dist/app/fonts; cp -R apps/on-device/fonts dist/app/fonts
fonts=$(find apps/on-device/fonts -type f | sed 's|^apps/on-device/||' | jq -R . | jq -s 'sort')
jq --arg v "$version" --argjson e "$names" --argjson f "$fonts" '.hostVersion = $v | .editableFiles = $e | .immutableFiles = (((.immutableFiles // []) | map(select(startswith("fonts/") | not))) + $f | unique)' dist/app/app-manifest.json > dist/app/app-manifest.json.tmp
mv dist/app/app-manifest.json.tmp dist/app/app-manifest.json
echo "dist/app updated from apps/on-device ($(echo "$names" | jq length) editable files, host $version)."
