#!/bin/sh
# Download upstream v86.wasm (copy/v86 "latest" release, built from the pinned commit 94faf3d6…) and verify
# its sha256 against the value pinned in apps/browser/vendor/v86/PROVENANCE.md. Used by CI only; the result is
# re-published in our own assets release so later builds never depend on the rolling upstream tag.
# Usage: scripts/fetch-v86-wasm.sh [dest]   (default apps/browser/vendor/v86/v86.wasm)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-$ROOT/apps/browser/vendor/v86/v86.wasm}
SHA=2fc5609ae837fcbc77147155de6f1014677ecab5369f5584ebc670e9d56e6510
URL=${V86_WASM_URL:-https://github.com/copy/v86/releases/download/latest/v86.wasm}
mkdir -p "$(dirname "$DEST")"
curl -fsSL --retry 3 -o "$DEST.part" "$URL"
if [ "$(sha256sum "$DEST.part" | cut -d' ' -f1)" != "$SHA" ]; then
  rm -f "$DEST.part"
  echo "v86.wasm from $URL does not match the pinned sha256 (upstream 'latest' moved?)." >&2
  echo "Fall back to the copy in our assets release (scripts/assets.lock) or re-pin after review." >&2
  exit 1
fi
mv "$DEST.part" "$DEST"
