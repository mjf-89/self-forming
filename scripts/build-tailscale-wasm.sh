#!/bin/sh
# Build the in-page Tailscale client WASM from a tailscale checkout.
#
# Produces libs/cors-rot/vendor/tailscale/{tailscale.wasm,wasm_exec.js} from the
# forked cmd/tsconnect/wasm (see third-party/tailscale/wasm_js.go.patch).
#
# Requirements:
#   - Go matching tailscale's go.mod `go` directive (>= the pinned version;
#     this spike used the official linux-arm64 Go 1.27.2 tarball).
#   - A tailscale checkout at $TS_SRC.
#
# Environment:
#   TS_SRC   path to the tailscale source tree (required)
#   GOROOT   path to the Go toolchain (optional if `go` is on PATH)
#   OUT_DIR  output directory (default: libs/cors-rot/vendor/tailscale)
set -eu

TS_SRC="${TS_SRC:?set TS_SRC to the tailscale checkout}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/libs/cors-rot/vendor/tailscale}"
PATCH="$REPO_ROOT/third-party/tailscale/wasm_js.go.patch"

if [ -n "${GOROOT:-}" ]; then
  PATH="$GOROOT/bin:$PATH"
fi
export PATH

echo "Go: $(go version)"
echo "tailscale commit: $(git -C "$TS_SRC" rev-parse HEAD 2>/dev/null || echo unknown)"

# Apply the glue patch if not already applied.
if ! git -C "$TS_SRC" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "Applying patch $PATCH"
  git -C "$TS_SRC" apply "$PATCH"
else
  echo "Patch already applied."
fi

mkdir -p "$OUT_DIR"

echo "Building tailscale.wasm (GOOS=js GOARCH=wasm)..."
( cd "$TS_SRC" && GOFLAGS=-mod=mod GOOS=js GOARCH=wasm go build \
    -o "$OUT_DIR/tailscale.wasm" ./cmd/tsconnect/wasm )

# Ship the wasm_exec.js that matches the toolchain.
WASM_EXEC="$(go env GOROOT)/lib/wasm/wasm_exec.js"
[ -f "$WASM_EXEC" ] || WASM_EXEC="$(go env GOROOT)/misc/wasm/wasm_exec.js"
cp "$WASM_EXEC" "$OUT_DIR/wasm_exec.js"
cp "$TS_SRC/LICENSE" "$OUT_DIR/LICENSE"

echo "Done. Sizes:"
ls -la "$OUT_DIR/tailscale.wasm" "$OUT_DIR/wasm_exec.js"
