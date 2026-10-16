#!/bin/sh
# Assemble the browser edition (no Android host, no server code) into a static folder.
# Usage: scripts/build-browser.sh [output-dir]   (default: dist/browser)
# Inputs: the prebuilt Pi library and native-host.js from dist/app, the shared app
# modules from apps/common and the browser host from apps/browser.
# Serve the output over HTTPS or http://localhost from any static file server.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-"$ROOT/dist/browser"}")
APP="$ROOT/dist/app"
LIB="$ROOT/libs/cors-rot"
# Refuse output paths that would erase or overwrite source inputs.
for source in "$ROOT/apps" "$ROOT/plugins" "$APP" "$LIB"; do
  case "$source/" in "$OUT/"*) echo "Unsafe output directory: $OUT" >&2; exit 1 ;; esac
  case "$OUT/" in "$source/"*) echo "Output overlaps source: $OUT" >&2; exit 1 ;; esac
done
[ -f "$APP/native-host.js" ] && [ -d "$APP/library" ] || { echo "dist/app is missing (library/ and native-host.js are needed)" >&2; exit 1; }
# Git-excluded binaries (v86, Linux image, cors-rot WASM): download + verify when missing (SF_SKIP_FETCH=1 to skip).
sh "$ROOT/scripts/fetch-assets.sh"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$APP/library" "$OUT/library"
cp "$APP/native-host.js" "$APP/THIRD_PARTY_NOTICES.md" "$OUT/"

# Shared app modules.
for f in "$ROOT"/apps/common/*.js "$ROOT"/apps/common/*.css; do
  cp "$f" "$OUT/"
done
# Built-in plugins: plugins/<id>/web/** is served as builtin/<id>/web/** next to the app files, where the
# generated registry (apps/common/builtin-plugins.js) imports it. Not under plugins/: that path is reserved for
# installed plugins on Android (/assets/web/plugins/<id>/<hash>/).
"$ROOT/scripts/gen-builtins.sh" --check
for web in "$ROOT"/plugins/*/web; do
  [ -d "$web" ] || continue
  id=$(basename "$(dirname "$web")")
  mkdir -p "$OUT/builtin/$id"
  cp -R "$web" "$OUT/builtin/$id/web"
done
cp "$ROOT"/apps/browser/*.js "$OUT/"
cp "$ROOT/apps/browser/network-smoke.html" "$OUT/"
# Installable web app (PWA): manifest + icons.
cp "$ROOT/apps/browser/manifest.webmanifest" "$OUT/"
# Snapshot nested browser dependencies; never move or clean the source trees.
for directory in vendor icons; do
  if [ -d "$ROOT/apps/browser/$directory" ]; then
    cp -R "$ROOT/apps/browser/$directory" "$OUT/$directory"
  fi
done

# The cors-rot networking library (source-only): copied next to the app so its imports resolve as
# ./cors-rot/*. It is a fixed deployment resource, not an editable app file (nested, so it is left
# out of app-manifest.json below). Tests are not shipped; the demo page is.
cp -R "$LIB" "$OUT/cors-rot"
rm -rf "$OUT/cors-rot/tests"
# App files import the library as ../../libs/cors-rot/* from source; rewrite to the deployed path.
for f in "$OUT"/browser-*.js "$OUT/network-smoke.html"; do
  [ -f "$f" ] && sed -i 's#\.\./\.\./libs/cors-rot/#./cors-rot/#g' "$f"
done
# Browser bootstrap reaches owning bundled entries (source differs from served layout).
sed -i -e 's#../../plugins/#./builtin/#g' -e 's#../common/plugin-runtime.js#./plugin-runtime.js#g' "$OUT/browser-network.js"
sed -i 's#../../plugins/#./builtin/#g' "$OUT/network-smoke.html"
sed -i 's#../../plugins/#./builtin/#g' "$OUT/browser-host.js"
# Fixed bootstrap imports its owning bundled backend; no host re-export twin.
sed -i 's#../../plugins/#./builtin/#g' "$OUT/browser-main.js"
# Fixed recovery page (never in editableFiles; see apps/browser/README.md "Recovery").
cp "$ROOT/apps/browser/recovery.html" "$OUT/"
sed -i 's#../../plugins/#./builtin/#g' "$OUT/browser-recovery.js"
# Git/Buffer remain fixed deployment vendor assets, not editable plugin payload.
for f in "$OUT"/builtin/core-git/web/browser-git.js "$OUT"/builtin/core-git/web/browser-buffer-global.js; do
  sed -i 's#../../../apps/browser/vendor/#../../../vendor/#g' "$f"
done
! grep -q 'createCorsRot' "$OUT/browser-host.js" || { echo "browser host still owns cors-rot" >&2; exit 1; }
[ -f "$OUT/cors-rot/snowflake-proxy.html" ] || { echo "cors-rot/snowflake-proxy.html missing from output" >&2; exit 1; }

# Content-Security-Policy as a <meta> (static hosts such as GitHub Pages cannot set headers). Same shape as the
# Android WebView policy, plus what the browser edition needs: blob: workers (v86, JavaScript tool) and any
# https:/wss: endpoint (model APIs, Tor/Tailscale relays, user-chosen servers; routing is decided by the app).
# No frame-ancestors/report directives: <meta> ignores them. No cross-origin isolation is required (no SharedArrayBuffer).
CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; manifest-src 'self'; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"

# Same page, but it starts the in-page browser host instead of app.js directly.
# Also link the web app manifest and touch icon so browsers offer "Install app".
sed -e 's#<script type="module" src="./app.js"></script>#<script type="module" src="./browser-main.js"></script>#' \
    -e 's#<meta charset="UTF-8" />#<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="'"$CSP"'" />\n    <script src="./browser-splash.js"></script>#' \
    -e 's#</head>#    <link rel="manifest" href="./manifest.webmanifest" />\n    <link rel="icon" href="./icons/favicon.svg" type="image/svg+xml" />\n    <link rel="icon" href="./icons/icon-192.png" />\n    <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />\n  </head>#' \
  "$ROOT/apps/common/index.html" > "$OUT/index.html"
grep -q 'src="./browser-main.js"' "$OUT/index.html" || { echo "index.html: app.js script tag not found" >&2; exit 1; }
grep -q 'rel="manifest"' "$OUT/index.html" || { echo "index.html: head not found (manifest link)" >&2; exit 1; }
grep -q 'browser-splash.js' "$OUT/index.html" || { echo "index.html: charset meta not found (boot splash script)" >&2; exit 1; }

# SF_STRIP_MAPS=1 (public deploy): leave out the source maps (about 11 MB).
[ "${SF_STRIP_MAPS:-}" != 1 ] || find "$OUT" -name "*.map" -type f -delete

VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
# Each deployment is its own browser host version: the service worker serves an edited revision only
# for the host version it was made for, and the editable source folder is seeded per version. With a
# plain package version, a redeploy kept serving revisions (and seeding) from an OLDER deployment, so
# stale editable plugin copies (net routes, chat, ...) ran against a newer fixed host. The build id is
# a content hash of the deployed files, so identical builds keep their revisions.
BUILD=$(cd "$OUT" && find . -type f ! -name app-manifest.json -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)
{
  printf '{\n  "format": 1,\n  "hostVersion": "%s-browser-%s",\n  "editableFiles": [' "$VERSION" "$BUILD"
  first=1
  for f in "$OUT"/*.js "$OUT"/*.css "$OUT"/*.html; do
    name=$(basename "$f")
    case "$name" in browser-*.js|sw.js|native-host.js|network-smoke.html|recovery.html|manifest.webmanifest) continue ;; esac
    [ $first = 1 ] && first=0 || printf ','
    printf '\n    "%s"' "$name"
  done
  # The built-in plugin files are editable too (nested names; the registry imports them).
  for name in $(cd "$OUT" && find builtin -type f | LC_ALL=C sort); do
    # Exact installer/integrity/store/serving recovery modules, execution backend and
    # provider callback adapters deploy with the host, not editable revisions.
    case "$name" in builtin/core-plugin-management/web/browser-plugin-host.js|builtin/core-plugin-management/web/browser-plugin-package.js|builtin/core-plugin-management/web/browser-plugin-store.js|builtin/core-plugin-management/web/browser-plugin-serving.js|builtin/core-execution/web/browser/*|builtin/exec-js/web/browser/*|builtin/exec-linux/web/browser/*|builtin/core-providers-chatgpt/web/browser-oauth.js|builtin/core-providers-claude/web/browser-auth.js) continue ;; esac
    printf ',\n    "%s"' "$name"
  done
  printf '\n  ],\n  "builtinIds": ['
  separator=''
  for web in "$ROOT"/plugins/*/web; do
    [ -d "$web" ] || continue
    printf '%s"%s"' "$separator" "$(basename "$(dirname "$web")")"
    separator=','
  done
  printf ']\n}\n'
} > "$OUT/app-manifest.json"

echo "Browser edition: $OUT ($(du -sh "$OUT" | cut -f1)), version $VERSION-browser-$BUILD"
