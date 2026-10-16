#!/bin/bash
# Web layer without Bun/node_modules: start from the installed app's prebuilt dist/app (unpacked by the
# app on first launch) and overlay the plain JS/CSS/HTML from apps/common. Fixed modules
# (native-host.js, library/) are reused as-is; changing packages/native-host needs the full build (scripts/build.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/app/app-manifest.json ] || { echo "dist/app is missing; open the app once so it unpacks its prebuilt files." >&2; exit 1; }
version=$(jq -r .version package.json)
# The generated built-in plugin registry (apps/common/builtin-plugins.js) must match plugins/*/plugin.json.
scripts/gen-builtins.sh --check
# Built-in plugins: plugins/<id>/web/** is served as builtin/<id>/web/** next to the app files (the registry
# imports ./builtin/<id>/web/index.js). Not under plugins/: /assets/web/plugins/<id>/<hash>/ belongs to installed plugins.
builtin=$(cd plugins && find */web -type f | LC_ALL=C sort | sed 's#^\([^/]*\)/#builtin/\1/#')
names=$( (cd apps/common && ls *.js *.css *.html; printf '%s\n' "$builtin") | jq -R . | jq -s 'sort')
# Drop editable files that no longer exist in apps/common (removed features) so they are not packaged.
for old in $(jq -r --argjson e "$names" '(.editableFiles - $e)[]' dist/app/app-manifest.json); do rm -f "dist/app/$old"; done
# Refuse to package a stylesheet or module that does not parse: a single syntax error (e.g. a line break inside a
# quoted url) makes the WebView drop the rest of the stylesheet and the app shows up unstyled.
bun=${BUN:-$(command -v bun || true)}
[ -n "$bun" ] || for candidate in ../devhub/bun ../bun-glibc/bun-linux-aarch64/bun; do [ -x "$candidate" ] && bun=$candidate && break; done
if [ -n "$bun" ]; then
  check=$(mktemp -d)
  for f in apps/common/*.css apps/common/*.js plugins/*/web/*.js; do
    "$bun" build "$f" --outdir "$check" --external "*" >/dev/null 2>"$check/err" || { echo "Syntax error in $f:" >&2; tail -5 "$check/err" >&2; rm -rf "$check"; exit 1; }
  done
  rm -rf "$check"
else
  echo "Warning: no bun found; skipping the CSS/JS syntax check." >&2
fi
cp apps/common/*.js apps/common/*.css apps/common/*.html dist/app/
rm -rf dist/app/builtin
for f in $(cd plugins && find */web -type f); do
  target="dist/app/builtin/${f%%/*}/${f#*/}"
  mkdir -p "$(dirname "$target")"; cp "plugins/$f" "$target"
done
cp scripts/app-source-README.md dist/app/app-source-README.md
# Bundled fonts (SIL OFL) are fixed assets: copied as-is and listed as immutable so they are served from the APK.
rm -rf dist/app/fonts; cp -R apps/common/fonts dist/app/fonts
fonts=$(find apps/common/fonts -type f | sed 's|^apps/common/||' | jq -R . | jq -s 'sort')
# libs/cors-rot (N3) is a fixed asset too: the net-tor / net-tailscale plugins import it as ../../../cors-rot/index.js
# (served as cors-rot/ next to the app files, ~43 MB with the Tailscale and Tor WASM; tests/ and demo/ are left out).
rm -rf dist/app/cors-rot; cp -R libs/cors-rot dist/app/cors-rot; rm -rf dist/app/cors-rot/tests dist/app/cors-rot/demo
corsrot=$(cd dist/app && find cors-rot -type f | LC_ALL=C sort | jq -R . | jq -s '.')
jq --arg v "$version" --argjson e "$names" --argjson f "$fonts" --argjson c "$corsrot" '.hostVersion = $v | .editableFiles = $e | .immutableFiles = (((.immutableFiles // []) | map(select((startswith("fonts/") or startswith("cors-rot/")) | not))) + $f + $c | unique)' dist/app/app-manifest.json > dist/app/app-manifest.json.tmp
mv dist/app/app-manifest.json.tmp dist/app/app-manifest.json
echo "dist/app updated from apps/common ($(echo "$names" | jq length) editable files, host $version)."
