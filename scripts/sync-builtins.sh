#!/bin/bash
# Keeps the live editable app source (the `sourcePath` of app_update info) and the repository in step now that
# the web layer is two trees: apps/common/* (flat app files) and plugins/<id>/web/** (built-in plugins), the latter
# served and edited as builtin/<id>/web/** inside sourcePath (docs/plugins.md §3a).
#   scripts/sync-builtins.sh to-live   <sourcePath>   repository -> sourcePath (then: app_update apply)
#   scripts/sync-builtins.sh from-live <sourcePath>   sourcePath -> repository (before building the APK)
# to-live replaces the top-level app files and the whole builtin/ tree and removes files that no longer exist in
# the repository (e.g. the old core-provider-*.js). app_update accepts subdirectories, at most 256 files
# in total, 4 MiB per file and 16 MiB per revision; this script refuses to go over those limits.
# plugin.json is not part of sourcePath; after a manifest change run scripts/gen-builtins.sh and copy
# apps/common/builtin-plugins.js too (to-live does, from-live reports it).
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:-}; live=${2:-}
[[ ( $action == to-live || $action == from-live ) && -d $live ]] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
live=$(cd "$live" && pwd -P)
here=$(pwd -P)
[[ $live != "$here" && $live != "$here"/* ]] || { echo "sync-builtins: $live is inside the repository" >&2; exit 1; }
shopt -s nullglob

case $action in
  to-live)
    scripts/gen-builtins.sh --check
    stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
    cp apps/common/*.js apps/common/*.css apps/common/*.html "$stage/"
    for web in plugins/*/web; do
      id=$(basename "$(dirname "$web")")
      mkdir -p "$stage/builtin/$id"; cp -R "$web" "$stage/builtin/$id/web"
    done
    files=$(find "$stage" -type f | wc -l)
    size=$(find "$stage" -type f -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')
    big=$(find "$stage" -type f -size +4194304c | head -1)
    (( files <= 256 )) || { echo "sync-builtins: $files files exceed app_update's 256-file limit" >&2; exit 1; }
    (( size <= 16777216 )) || { echo "sync-builtins: $size bytes exceed app_update's 16 MiB limit" >&2; exit 1; }
    [[ -z $big ]] || { echo "sync-builtins: $big is over 4 MiB" >&2; exit 1; }
    # Files that are in sourcePath but not in the new set (only app files and builtin/ are managed).
    # The installed APK lists editableFiles that every revision must contain (WebAppStore.kt); keep those
    # even when the repo no longer has them (inert leftovers until an APK with the new layout is installed).
    required=$(jq -r '.editableFiles[]?' "$here/dist/app/app-manifest.json" 2>/dev/null || true)
    for f in "$live"/*.js "$live"/*.css "$live"/*.html; do
      b=$(basename "$f")
      [[ -e $stage/$b ]] && continue
      if grep -qxF -- "$b" <<< "$required"; then echo "kept $b (required by the installed APK)"; continue; fi
      rm -f "$f"; echo "removed $b"
    done
    rm -rf "$live/builtin"
    cp -R "$stage"/. "$live"/
    echo "sync-builtins: $files files copied to $live ($size bytes)"
    ;;
  from-live)
    [[ -d $live/builtin ]] || { echo "sync-builtins: $live/builtin is missing; nothing to copy back" >&2; exit 1; }
    for f in "$live"/*.js "$live"/*.css "$live"/*.html; do cp "$f" apps/common/; done
    for web in "$live"/builtin/*/web; do
      id=$(basename "$(dirname "$web")")
      [[ -f plugins/$id/plugin.json ]] || { echo "sync-builtins: builtin/$id has no plugins/$id/plugin.json; create the package there first" >&2; exit 1; }
      rm -rf "plugins/$id/web"; cp -R "$web" "plugins/$id/web"
    done
    for f in apps/common/*.js; do [[ -e $live/$(basename "$f") ]] || echo "note: apps/common/$(basename "$f") is not in sourcePath"; done
    scripts/gen-builtins.sh --check || echo "note: run scripts/gen-builtins.sh (manifests changed or a plugin was added)"
    echo "sync-builtins: copied the app files and the built-in plugin web files from $live"
    ;;
esac
