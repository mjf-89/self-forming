#!/bin/sh
# Build the browser edition and publish it to the folder the local servers serve
# (build/browser-serve, outside dist/ so Android/APK builds that regenerate dist/ can't remove it).
# Updated IN PLACE (servers like busybox httpd keep the directory they started in): the build goes to
# a staging folder first and is copied over only when complete; files no longer in the build are removed.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVE=${SERVE:-"$ROOT/../build/browser-serve"}
STAGE="$SERVE.new"
rm -rf "$STAGE"
sh "$ROOT/scripts/build-browser.sh" "$STAGE"
[ -f "$STAGE/index.html" ] && [ -d "$STAGE/cors-rot" ] || { echo "publish: incomplete build, keeping the served copy" >&2; exit 1; }
mkdir -p "$SERVE"
cp -a "$STAGE/." "$SERVE/"
# Remove files that are no longer part of the build.
( cd "$SERVE" && find . -type f | sort ) > "$STAGE.served"
( cd "$STAGE" && find . -type f | sort ) > "$STAGE.built"
comm -23 "$STAGE.served" "$STAGE.built" | while IFS= read -r f; do rm -f "$SERVE/$f"; done
find "$SERVE" -depth -type d -empty -delete 2>/dev/null || true
rm -rf "$STAGE" "$STAGE.served" "$STAGE.built"
echo "Published to $SERVE"
