#!/bin/sh
# Download the Git-excluded binaries listed in scripts/assets.lock and verify their sha256.
# Files that are already present and correct are left alone; a wrong file is replaced.
# Usage: scripts/fetch-assets.sh [--check]     (--check: only verify, exit 1 if anything is missing/wrong)
# Env:   ASSETS_BASE   override the release download base URL (e.g. file:///path/to/folder or a mirror)
#        SF_SKIP_FETCH=1  do nothing (offline builds with the files already in place)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK="$ROOT/scripts/assets.lock"
[ "${SF_SKIP_FETCH:-}" = 1 ] && exit 0
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
REPO=$(awk -F'\t' '$1=="@release"{print $2}' "$LOCK"); TAG=$(awk -F'\t' '$1=="@release"{print $3}' "$LOCK")
BASE=${ASSETS_BASE:-"https://github.com/$REPO/releases/download/$TAG"}
CR_URL=$(awk -F'\t' '$1=="@cors-rot"{print $2}' "$LOCK"); CR_SHA=$(awk -F'\t' '$1=="@cors-rot"{print $3}' "$LOCK")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
bad=0; CR_READY=0
ok() { [ -f "$2" ] && [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$1" ]; }
get() { curl -fsSL --retry 3 -o "$2" "$1"; }
while IFS="	" read -r sha size dest src; do
  case "$sha" in ''|'#'*|'@'*) continue ;; esac
  target="$ROOT/$dest"
  ok "$sha" "$target" && continue
  if [ $CHECK = 1 ]; then echo "missing or wrong: $dest" >&2; bad=1; continue; fi
  mkdir -p "$(dirname "$target")"
  case "$src" in
    release:*)
      echo "fetching $dest"
      get "$BASE/${src#release:}" "$TMP/dl" ;;
    cors-rot:*)
      if [ $CR_READY = 0 ]; then
        echo "fetching cors-rot-vendor.tar.gz"
        get "$CR_URL" "$TMP/cr.tgz"
        [ "$(sha256sum "$TMP/cr.tgz" | cut -d' ' -f1)" = "$CR_SHA" ] || { echo "cors-rot tarball checksum mismatch" >&2; exit 1; }
        mkdir "$TMP/cr"; tar -xzf "$TMP/cr.tgz" -C "$TMP/cr"; CR_READY=1
      fi
      cp "$TMP/cr/${src#cors-rot:}" "$TMP/dl" ;;
    *) echo "bad source in assets.lock: $src" >&2; exit 1 ;;
  esac
  ok "$sha" "$TMP/dl" || { echo "checksum mismatch for $dest" >&2; exit 1; }
  mv "$TMP/dl" "$target"
done < "$LOCK"
[ $bad = 0 ] || exit 1
