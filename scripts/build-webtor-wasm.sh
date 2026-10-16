#!/usr/bin/env bash
# Rebuild only from the reviewed pinned source + patch. No downloads, installs,
# cloned replacement trees, unsafe prebuilt fallback, or background processes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${WEBTOR_SOURCE:-"$ROOT/../build/webtor-rs"}
PATCH="$ROOT/third-party/webtor-rs/browser-streams-security.patch"
PIN=cba29fb44970f4be37ebe7ce85bd50690d66413d
MODE=${1:-production}
case "$MODE" in production|--smoke) ;; *) echo 'Usage: build-webtor-wasm.sh [--smoke]' >&2; exit 2;; esac
export CARGO_HOME=${CARGO_HOME:-/opt/rust/cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-/opt/rust/rustup}
export PATH="$CARGO_HOME/bin:$PATH"
export CC_wasm32_unknown_unknown=${CC_wasm32_unknown_unknown:-clang}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
# Never auto-install a missing toolchain or CLI. These must already exist.
for tool in cargo rustc rustup wasm-bindgen clang timeout git; do command -v "$tool" >/dev/null; done
[[ $(wasm-bindgen --version) == 'wasm-bindgen 0.2.106' ]] || { echo 'Expected wasm-bindgen 0.2.106' >&2; exit 1; }
cd "$SOURCE"
[[ $(git rev-parse HEAD) == "$PIN" ]] || { echo 'Wrong upstream revision; refusing build' >&2; exit 1; }
rustup run nightly-2026-01-05 rustc --version
if git diff --quiet && git diff --cached --quiet; then
  git apply --check "$PATCH"
  git apply "$PATCH"
else
  # A recovering agent may already have applied the patch. Require the exact
  # reviewed tracked diff, not merely a patch that could be reversed.
  cmp <(git diff --binary HEAD) "$PATCH" || { echo 'Source has unreviewed tracked edits; export/review patch first' >&2; exit 1; }
fi
# Do not accept additional Rust/build configuration files outside the diff.
if git ls-files --others --exclude-standard | grep -E '(^|/)(Cargo\.(toml|lock)|build\.rs|config(\.toml)?|[^/]+\.rs)$' >/dev/null; then
  echo 'Untracked build/Rust source present; refusing build' >&2; exit 1
fi
FEATURES=()
DEST="$ROOT/libs/cors-rot/vendor/webtor"
if [[ "$MODE" == --smoke ]]; then
  FEATURES=(--features recovery-smoke)
  DEST="$SOURCE/target/recovery-smoke"
fi
LOG="$SOURCE/recovery-${MODE#--}-build.log"
# Foreground and bounded; interrupted/failed commands never publish an artifact.
if ! timeout --signal=TERM --kill-after=10s 240s cargo +nightly-2026-01-05 build \
  --offline --locked --release --target wasm32-unknown-unknown -p webtor-wasm "${FEATURES[@]}" >"$LOG" 2>&1; then
  tail -80 "$LOG" >&2; echo 'Build failed/timed out; existing bundle was NOT replaced' >&2; exit 1
fi
tail -15 "$LOG"
mkdir -p "$(dirname "$DEST")"
STAGE=$(mktemp -d "$(dirname "$DEST")/.webtor-build.XXXXXXXX")
trap 'rm -rf "$STAGE"' EXIT
# Preserve documentation/licenses, never silently use their old binary.
if [[ -d "$DEST" ]]; then cp -a "$DEST/." "$STAGE/"; fi
rm -rf "$STAGE/snippets"
rm -f "$STAGE"/webtor_wasm{.js,.d.ts,_bg.wasm,_bg.wasm.d.ts}
timeout --signal=TERM --kill-after=10s 90s wasm-bindgen --target web --out-name webtor_wasm \
  --out-dir "$STAGE" target/wasm32-unknown-unknown/release/webtor_wasm.wasm
printf '{"name":"@self-forming/webtor-wasm","private":true,"type":"module","version":"0.5.7-recovery.1"}\n' > "$STAGE/package.json"
if [[ "$MODE" != --smoke ]]; then
  # Production exports must match the reviewed allowlist exactly (JS glue and wasm export table).
  # A new export, test-only or not, fails the build until the allowlist is reviewed and updated.
  ALLOW="$ROOT/third-party/webtor-rs/production-exports"
  cmp <(grep -oE '^export (async )?(function|class|const|let) [A-Za-z0-9_]+|^export \{[^}]*\}' "$STAGE/webtor_wasm.js" | sort) "$ALLOW.js.txt" \
    || { echo 'Production JS exports differ from reviewed allowlist' >&2; exit 1; }
  cmp <(grep -oE 'export const [a-zA-Z0-9_]+' "$STAGE/webtor_wasm_bg.wasm.d.ts" | sort) "$ALLOW.wasm.txt" \
    || { echo 'Production wasm exports differ from reviewed allowlist' >&2; exit 1; }
fi
{
  printf 'upstream %s\nmode %s\n' "$PIN" "$MODE"
  rustc +nightly-2026-01-05 --version
  wasm-bindgen --version
  sha256sum "$PATCH" Cargo.lock
  (cd "$STAGE" && sha256sum webtor_wasm.js webtor_wasm_bg.wasm && find snippets -type f -print0 | sort -z | xargs -0 sha256sum)
} > "$STAGE/BUILD.txt"
mkdir -p "$DEST"
# Build complete before publication. Caller must not serve/update concurrently.
rm -rf "$DEST/snippets"
cp -a "$STAGE/." "$DEST/"
printf 'Built %s from reviewed source (%s). Security gate is unchanged.\n' "$DEST" "$MODE"
