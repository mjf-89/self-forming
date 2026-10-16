#!/usr/bin/env bash
# Replace libs/cors-rot by a pinned copy of github.com/mjf-89/cors-rot at <commit-or-ref>.
# libs/cors-rot is NEVER edited by hand: run this script, review the diff, commit.
# Usage: scripts/update-cors-rot.sh <commit-or-ref> [release-tag]
# GH_TOKEN is optional (the repo is public; a token only raises API rate limits) and is passed through the environment only.
# Layout: upstream src/* -> libs/cors-rot/*, plus tests/, demo/, README.md, LICENSE, docs/reference.md, and the licence notices
# shipped in the release tarball (THIRD_PARTY_NOTICES.md, third_party/) for the bundled WASM.
# WASM/webtor artifacts: the upstream release asset cors-rot-vendor.tar.gz (what upstream's
# scripts/fetch-vendor.sh downloads), taken from a release whose build inputs (build/, workflow) are
# identical to the pinned commit; verified against the release .sha256 and the per-file checksums
# in the BUILD.txt files, and the patch checksums there against the patches in the pinned commit.
set -euo pipefail
REF=${1:?usage: $0 <commit-or-ref> [release-tag]}
TAGARG=${2:-}
REPO=mjf-89/cors-rot
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=$HERE/libs/cors-rot
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AUTH=()
if [ -n "${GH_TOKEN:-}" ]; then
  B64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $B64"
  AUTH=(-H "Authorization: Bearer $GH_TOKEN")
fi
export GIT_TERMINAL_PROMPT=0
SRC=$TMP/src
git clone -q "https://github.com/$REPO" "$SRC"
COMMIT=$(git -C "$SRC" rev-parse --verify "$REF^{commit}")
git -C "$SRC" checkout -q "$COMMIT"

# pick the release whose build inputs equal the pinned commit's
TAG=
if [ -n "$TAGARG" ]; then TAG=$TAGARG; else
  for t in $(git -C "$SRC" tag -l 'v*' --sort=-v:refname); do
    if git -C "$SRC" diff --quiet "$t" "$COMMIT" -- build .github/workflows; then TAG=$t; break; fi
  done
fi
[ -n "$TAG" ] || { echo "no release has build inputs identical to $COMMIT" >&2; exit 1; }
git -C "$SRC" diff --quiet "$TAG" "$COMMIT" -- build .github/workflows || { echo "release $TAG differs in build inputs" >&2; exit 1; }
API=https://api.github.com/repos/$REPO/releases/tags/$TAG
curl -fsSL "${AUTH[@]}" "$API" > "$TMP/rel.json"
REL=$TMP/rel; mkdir "$REL"
for name in cors-rot-vendor.tar.gz cors-rot-vendor.tar.gz.sha256; do
  id=$(jq -r --arg n "$name" '.assets[]|select(.name==$n).id' "$TMP/rel.json")
  curl -fsSL "${AUTH[@]}" -H "Accept: application/octet-stream" -o "$REL/$name" \
    "https://api.github.com/repos/$REPO/releases/assets/$id"
done
( cd "$REL" && sha256sum -c cors-rot-vendor.tar.gz.sha256 >/dev/null ) || { echo "tarball checksum mismatch" >&2; exit 1; }
TARSHA=$(cut -d' ' -f1 "$REL/cors-rot-vendor.tar.gz.sha256")
mkdir "$REL/x"; tar -xzf "$REL/cors-rot-vendor.tar.gz" -C "$REL/x"

# verify per-file checksums listed in BUILD.txt (files relative to that vendor dir; patches vs git)
for v in webtor tailscale; do
  d=$REL/x/src/vendor/$v
  while read -r sum f; do
    [ -n "$f" ] || continue
    case $f in build/*) p=$SRC/$f ;; *) p=$d/$f ;; esac
    [ "$(sha256sum "$p" | cut -d' ' -f1)" = "$sum" ] || { echo "checksum mismatch: $v/$f" >&2; exit 1; }
  done < <(grep -E '^[0-9a-f]{64}  ' "$d/BUILD.txt")
done

# assemble
OUT=$TMP/out; mkdir "$OUT"
cp -r "$SRC"/src/. "$OUT"/
cp -r "$SRC/tests" "$SRC/demo" "$OUT"/
# docs: only the reference; upstream docs/tor-client-*.md are development records (read them in the upstream repo)
mkdir -p "$OUT/docs" && cp "$SRC/docs/reference.md" "$OUT/docs"/
cp "$SRC/README.md" "$SRC/LICENSE" "$OUT"/
cp -r "$REL"/x/src/vendor/. "$OUT/vendor"/
for n in THIRD_PARTY_NOTICES.md third_party; do [ ! -e "$REL/x/$n" ] || cp -r "$REL/x/$n" "$OUT"/; done
# flat layout: tests/demo import ../src/x.js upstream, ../x.js here (only change made to upstream files)
sed -i "s#\.\./src/#../#g" "$OUT"/tests/*.mjs "$OUT"/demo/index.html
rm -rf "$DEST"; mkdir -p "$(dirname "$DEST")"; cp -r "$OUT" "$DEST"

# lock
cd "$DEST"
{
  printf '{\n  "repo": "https://github.com/%s",\n  "commit": "%s",\n' "$REPO" "$COMMIT"
  printf '  "layout": "upstream src/* -> libs/cors-rot/*; tests/ and demo/ with ../src/ rewritten to ../ (only edit); docs/reference.md, README.md, LICENSE as upstream",\n'
  printf '  "artifacts": {\n    "source": "release %s asset cors-rot-vendor.tar.gz (src/vendor/{webtor,tailscale}), built from build/ identical to the pinned commit",\n' "$TAG"
  printf '    "tarballSha256": "%s",\n    "verified": "tarball .sha256 + per-file checksums and patch checksums in vendor/*/BUILD.txt"\n  },\n' "$TARSHA"
  printf '  "files": [\n'
  find . -type f ! -name UPSTREAM.lock | LC_ALL=C sort | sed 's|^\./||' | while read -r f; do
    printf '    {"path": "%s", "sha256": "%s"},\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
  done | sed '$ s/,$//'
  printf '  ]\n}\n'
} > UPSTREAM.lock
jq -e . UPSTREAM.lock >/dev/null
echo "libs/cors-rot pinned to $COMMIT (artifacts: $TAG)"
