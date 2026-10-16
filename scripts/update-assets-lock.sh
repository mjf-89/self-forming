#!/bin/sh
# After the "Browser assets" workflow published release <tag>, point scripts/assets.lock at it:
# new @release tag + the sha256/size of every release:* entry, taken from the release's MANIFEST file
# (lines "sha256 bytes name", written by CI). Review the diff and commit it.
# Usage: scripts/update-assets-lock.sh assets-vX.Y.Z
set -eu
TAG=${1:?usage: update-assets-lock.sh <release tag>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCK="$ROOT/scripts/assets.lock"
REPO=$(awk -F'\t' '$1=="@release"{print $2}' "$LOCK")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 -o "$TMP/MANIFEST" "https://github.com/$REPO/releases/download/$TAG/MANIFEST"
awk -F'\t' -v OFS='\t' -v tag="$TAG" -v mf="$TMP/MANIFEST" '
  BEGIN { while ((getline l < mf) > 0) { split(l, a, " "); sha[a[3]] = a[1]; size[a[3]] = a[2] } }
  $1 == "@release" { $3 = tag; print; next }
  $4 ~ /^release:/ {
    n = substr($4, 9)
    if (!(n in sha)) { print "not in release MANIFEST: " n > "/dev/stderr"; bad = 1; print; next }
    $1 = sha[n]; $2 = size[n]; print; next }
  { print }
  END { exit bad }' "$LOCK" > "$TMP/lock"
cat "$TMP/lock" > "$LOCK"
echo "assets.lock now points at $TAG"
