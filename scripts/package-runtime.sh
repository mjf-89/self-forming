#!/bin/bash
# Package the verified runtime payload in dist/runtime/ (PRoot libraries, the Ubuntu 24.04 + Box64
# root filesystem archive with its manifest, and licenses) into a standalone runtime tar.gz.
# The archive is reproducible (sorted entries, fixed
# timestamps and owners), so the same payload always gives the same SHA-256.
# Usage: scripts/package-runtime.sh [output-dir]   (default: .runtime-build, which is gitignored)
# Prints the archive path and its SHA-256; put the hash in runtime-source.env as RUNTIME_SHA256.
set -euo pipefail
cd "$(dirname "$0")/.."
ABI=arm64-v8a
archive_name=self-forming-runtime-arm64-v8a.tar.gz
src=dist/runtime
out=${1:-.runtime-build}

parts=("jniLibs/$ABI/libproot.so" "jniLibs/$ABI/libproot-loader.so" \
       "assets/runtime/ubuntu-$ABI.zip" "assets/runtime/ubuntu-$ABI.json")
for f in "${parts[@]}"; do
  [[ -s $src/$f && ! -L $src/$f ]] || { echo "Missing regular file $src/$f: nothing to package." >&2; exit 1; }
done

shopt -s nullglob
for f in "$src/assets/licenses/"*; do
  name=${f##*/}
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -f $f && ! -L $f ]] || { echo "Invalid runtime license file: $f" >&2; exit 1; }
  parts+=("assets/licenses/$name")
done
rootfs_sha=$(sha256sum "$src/assets/runtime/ubuntu-$ABI.zip" | cut -d' ' -f1)
rootfs_bytes=$(stat -c %s "$src/assets/runtime/ubuntu-$ABI.zip")
jq -e --arg abi "$ABI" --arg sha "$rootfs_sha" --argjson bytes "$rootfs_bytes" \
  '.schema == 1 and .distro == "ubuntu" and .release == "24.04" and .abi == $abi and .sha256 == $sha and .compressedBytes == $bytes' \
  "$src/assets/runtime/ubuntu-$ABI.json" > /dev/null || { echo 'Ubuntu runtime manifest/checksum mismatch.' >&2; exit 1; }

mkdir -p "$out"
tmp="$out/$archive_name.part"
trap 'rm -f "$tmp"' EXIT
printf '%s\0' "${parts[@]}" | LC_ALL=C sort -z \
  | tar -C "$src" --null -T - --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX -cf - \
  | gzip -9n > "$tmp"
mv -f "$tmp" "$out/$archive_name"
trap - EXIT

echo "Archive: $out/$archive_name ($(stat -c %s "$out/$archive_name") bytes)"
sha256sum "$out/$archive_name" | cut -d' ' -f1
