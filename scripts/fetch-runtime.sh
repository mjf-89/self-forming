#!/bin/bash
# Reuse a pinned Ubuntu 24.04 + Box64 + PRoot payload from an APK or runtime tar.gz release asset.
# Only allowlisted runtime members are read; app code, source archives and signing files stay out.
# Usage: scripts/fetch-runtime.sh [cache-dir]     Optional: GH_TOKEN for a private repository.
set -euo pipefail
cd "$(dirname "$0")/.."
source "${RUNTIME_PIN_FILE:-runtime-source.env}"
ABI=arm64-v8a
format=${RUNTIME_FORMAT:-tar}
case "$format" in apk|tar) ;; *) echo "Unsupported RUNTIME_FORMAT: $format" >&2; exit 1;; esac
[[ $RUNTIME_ARCHIVE =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && $RUNTIME_SHA256 =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid runtime filename or SHA-256.' >&2; exit 1; }
cache=${1:-.runtime-cache}
mkdir -p "$cache"
archive="$cache/$RUNTIME_ARCHIVE"

verify() { printf '%s  %s\n' "$RUNTIME_SHA256" "$1" | sha256sum --check --status; }
if [[ -f $archive ]] && verify "$archive"; then
  echo "Using cached $RUNTIME_ARCHIVE"
else
  if [[ -n ${RUNTIME_DOWNLOAD_URL:-} ]]; then
    [[ $RUNTIME_DOWNLOAD_URL == https://* && $RUNTIME_DOWNLOAD_URL != *[$'\r\n\t ']* ]] || { echo 'Runtime download URL must use HTTPS.' >&2; exit 1; }
    echo "Downloading $RUNTIME_ARCHIVE from a supplied HTTPS source..."
    # Signed asset URLs are short-lived credentials: do not log them or forward the repository token.
    # Curl diagnostics can include the URL on failure, so report a generic error for this path.
    curl -fsSL --globoff --proto '=https' --proto-redir '=https' --retry 3 --max-time 1800 \
      -o "$archive.part" "$RUNTIME_DOWNLOAD_URL" 2>/dev/null || { echo 'Runtime download failed.' >&2; exit 1; }
  else
    echo "Downloading $RUNTIME_ARCHIVE from $RUNTIME_REPO $RUNTIME_TAG..."
    auth=(); [[ -n ${GH_TOKEN:-} ]] && auth=(-H "Authorization: Bearer $GH_TOKEN")
    # The API endpoint works for public and (with a token) private repositories.
    id=$(curl -fsS --proto '=https' --max-time 60 "${auth[@]}" "https://api.github.com/repos/$RUNTIME_REPO/releases/tags/$RUNTIME_TAG" \
      | jq -er --arg n "$RUNTIME_ARCHIVE" '[.assets[] | select(.name == $n) | .id] | if length == 1 then .[0] else error("Runtime release asset must be unique") end')
    [[ $id =~ ^[0-9]+$ ]] || { echo 'Invalid release asset ID.' >&2; exit 1; }
    curl -fSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 1800 "${auth[@]}" -H 'Accept: application/octet-stream' \
      -o "$archive.part" "https://api.github.com/repos/$RUNTIME_REPO/releases/assets/$id"
  fi
  verify "$archive.part" || { echo "Checksum mismatch for $RUNTIME_ARCHIVE" >&2; rm -f "$archive.part"; exit 1; }
  mv -f "$archive.part" "$archive"
fi

mkdir -p dist
stage=$(mktemp -d dist/.runtime-stage.XXXXXX)
trap 'rm -rf "$stage"' EXIT
if [[ $format == apk ]]; then
  unzip -Z1 "$archive" > "$stage/members"
else
  tar -tzf "$archive" > "$stage/members"
fi
declare -A seen=()
while IFS= read -r name; do
  target=$name
  if [[ $format == apk && $name =~ ^lib/arm64-v8a/libproot[A-Za-z0-9._-]*\.so$ ]]; then
    target="jniLibs/$ABI/${name##*/}"
  elif [[ $format == tar && $name =~ ^jniLibs/arm64-v8a/libproot[A-Za-z0-9._-]*\.so$ ]]; then
    :
  elif [[ $name == "assets/runtime/ubuntu-$ABI.zip" || $name == "assets/runtime/ubuntu-$ABI.json" ]]; then
    :
  elif [[ $name =~ ^assets/licenses/[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    :
  elif [[ $format == tar ]]; then
    # Older runtime archives include these directory entries. Other tar payload is a packaging error.
    case "$name" in jniLibs/|"jniLibs/$ABI/"|assets/|assets/runtime/|assets/licenses/) continue;; esac
    echo "Unexpected runtime archive member: $name" >&2; exit 1
  else
    continue # APK bytecode, app UI, embedded source, signing data and other ABIs are never extracted.
  fi
  [[ ! ${seen[$target]+present} ]] || { echo "Duplicate runtime member: $target" >&2; exit 1; }
  seen[$target]=1
  mkdir -p "$stage/$(dirname "$target")"
  # Stream the named member into a new regular file. Never let archive paths or links write to the filesystem.
  if [[ $format == apk ]]; then unzip -p "$archive" "$name" > "$stage/$target"
  else tar --no-wildcards -xOzf "$archive" -- "$name" > "$stage/$target"
  fi
  [[ -s $stage/$target ]] || { echo "Empty or non-regular runtime member: $target" >&2; exit 1; }
done < "$stage/members"
rm "$stage/members"
for f in "jniLibs/$ABI/libproot.so" "jniLibs/$ABI/libproot-loader.so" \
         "assets/runtime/ubuntu-$ABI.zip" "assets/runtime/ubuntu-$ABI.json"; do
  [[ -s $stage/$f ]] || { echo "Runtime archive is missing $f" >&2; exit 1; }
done
rootfs="$stage/assets/runtime/ubuntu-$ABI.zip"
rootfs_sha=$(sha256sum "$rootfs" | cut -d' ' -f1)
rootfs_bytes=$(stat -c %s "$rootfs")
jq -e --arg abi "$ABI" --arg sha "$rootfs_sha" --argjson bytes "$rootfs_bytes" \
  '.schema == 1 and .distro == "ubuntu" and .release == "24.04" and .abi == $abi and .sha256 == $sha and .compressedBytes == $bytes' \
  "$stage/assets/runtime/ubuntu-$ABI.json" > /dev/null || { echo 'Ubuntu runtime manifest/checksum mismatch.' >&2; exit 1; }
mkdir -p "$stage/assets/licenses"
chmod 0755 "$stage/jniLibs/$ABI"/*.so
out=dist/runtime
rm -rf "$out"
mv "$stage" "$out"
trap - EXIT
echo "Runtime ready in $out (from $RUNTIME_REPO $RUNTIME_TAG, $ABI):"
find "$out" -type f -printf '  %8s  %P\n' | sort -k2
