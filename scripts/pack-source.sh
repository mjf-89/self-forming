#!/bin/bash
# Pack a source snapshot, never Git history or local build/auth state, into the APK.
# An optional, explicit self-update signing identity is deliberately included; no other .signing files are.
# Also works from the history-free snapshot unpacked by an installed app, without Git or Node/Python.
set -euo pipefail
cd "$(dirname "$0")/.."
out=apps/android/app/build/generated/selfSource/self-source
mkdir -p "$out"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
roots=(.github apps docs examples packages plugins scripts skills tests third-party)
root_files=(.gitattributes .gitignore AGENTS.md INCEPT.md LICENSE README.md package.json pnpm-lock.yaml pnpm-workspace.yaml runtime-source.env tsconfig.json build-all.sh build-apk.sh)

# Files selected by Git still pass the same boundary checks as a Git-free snapshot. Force-adding a
# credential, cache or previous source archive must not make it part of the installed source.
allowed_source() {
  local path=$1 lower=${1,,} rest=${1#*/} name=${1##*/}
  case "$path" in
    .gitattributes|.gitignore|AGENTS.md|INCEPT.md|LICENSE|README.md|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|runtime-source.env|tsconfig.json|build-all.sh|build-apk.sh) return 0 ;;
    .github/*|apps/*|docs/*|examples/*|packages/*|plugins/*|scripts/*|skills/*|tests/*|third-party/*) ;;
    *) return 1 ;;
  esac
  # No hidden state below source roots (the root .github itself is explicitly allowed).
  [[ ! "$rest" =~ (^|/)\.[^/]+/ ]] || return 1
  case "/$lower/" in
    */node_modules/*|*/dist/*|*/build/*|*/out/*|*/artifacts/*|*/test-results/*|*/__pycache__/*|*/vendor/*|*/credentials/*|*/secrets/*|*/private/*|*/backups/*|*/backup/*|*/cache/*|*/tmp/*|*/temp/*) return 1 ;;
  esac
  case "${name,,}" in
    .gitignore) return 0 ;;
    .*|local.properties|*credential*|*token*.json|*token*.yaml|*token*.yml|*secret*.json|*secret*.yaml|*secret*.yml|*keys.json|*password*|auth*.json|oauth*.json|token|secret) return 1 ;;
  esac
  # This published certificate contains no private key. Other PEM files remain excluded.
  [[ "$path" != apps/android/signing-certificate.pem ]] || return 0
  case "$lower" in
    *.js|*.mjs|*.cjs|*.ts|*.tsx|*.jsx|*.kt|*.kts|*.java|*.c|*.cpp|*.h|*.xml|*.gradle|*.properties|*.json|*.md|*.sh|*.py|*.sha256|*.yml|*.yaml|*.toml|*.txt|*.css|*.html|*.svg|*.png|*.jpg|*.jpeg|*.webp|*.gif|*.ttf|*.woff|*.woff2|*.otf|*.license) return 0 ;;
  esac
  return 1
}

# jar follows file links: reject both a symlink file and a symlink directory in its path.
regular_file() {
  local path=$1 part prefix=""
  [[ -f "$path" && "$path" != /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  local -a parts
  IFS=/ read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != . && "$part" != .. ]] || return 1
    prefix=${prefix:+$prefix/}$part
    [[ ! -L "$prefix" ]] || return 1
  done
}

repo=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -n "$repo" && "$(cd "$repo" && pwd -P)" == "$(pwd -P)" ]]; then
  git ls-files --cached --others --exclude-standard -z -- "${root_files[@]}" "${roots[@]}" > "$temporary/candidates"
else
  # find does not follow symlink directories. The subsequent filter excludes generated/private files.
  : > "$temporary/candidates"
  for path in "${root_files[@]}" "${roots[@]}"; do
    [[ ! -e "$path" ]] || find "$path" -type f -print0 >> "$temporary/candidates"
  done
fi
sort -zu "$temporary/candidates" > "$temporary/sorted"
: > "$temporary/selected"
while IFS= read -r -d '' path; do
  if allowed_source "$path" && regular_file "$path"; then printf '%s\0' "$path" >> "$temporary/selected"; fi
done < "$temporary/sorted"

# The APK's self-update identity is an explicit product feature, distinct from CI credentials.
# Require a complete pair, and permit only these exact files (including no symlink parents).
if [[ -e .signing/self-forming.p12 || -e .signing/password || -e .signing/lineage.bin ]]; then
  for path in .signing/self-forming.p12 .signing/password; do
    regular_file "$path" || { echo "Incomplete or linked self-update signing identity: $path" >&2; exit 1; }
    printf '%s\0' "$path" >> "$temporary/selected"
  done
  if [[ -e .signing/lineage.bin ]]; then
    regular_file .signing/lineage.bin || { echo 'Linked signing lineage is not allowed.' >&2; exit 1; }
    printf '%s\0' .signing/lineage.bin >> "$temporary/selected"
  fi
fi

# Quote argument-file entries: spaces, quotes and backslashes in valid source filenames stay literal.
: > "$temporary/list"
while IFS= read -r -d '' path; do
  escaped=${path//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf '"%s"\n' "$escaped" >> "$temporary/list"
done < "$temporary/selected"
[[ -s "$temporary/list" ]] || { echo 'No source files selected.' >&2; exit 1; }
# The JDK's jar tool is present wherever the APK is built; it writes a plain ZIP with --no-manifest.
jar --create --no-manifest --file "$out/source.zip.tmp" @"$temporary/list"
mv -f "$out/source.zip.tmp" "$out/source.zip"
echo "Packed $(wc -c < "$out/source.zip") bytes of source into $out/source.zip"
