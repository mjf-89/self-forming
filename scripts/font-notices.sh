#!/bin/bash
# Append the bundled fonts' notice (SIL Open Font License 1.1) to dist/app/THIRD_PARTY_NOTICES.md. Safe to rerun.
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/app/THIRD_PARTY_NOTICES.md
[ -f "$out" ] || exit 0
tmp=$(mktemp)
awk '/^## Bundled fonts/ { exit } { print }' "$out" > "$tmp"
{
  printf '## Bundled fonts\n\n'
  printf 'Baskervville and EB Garamond are bundled in `fonts/` (variable TrueType, from github.com/google/fonts) and licensed under the SIL Open Font License 1.1. Nothing is loaded from the network. The licence texts are shipped next to the fonts (`fonts/OFL-*.txt`) and reproduced here.\n\n'
  for f in apps/common/fonts/OFL-*.txt; do
    printf '### %s\n\n```\n' "$(basename "$f" .txt | sed 's/^OFL-//')"
    cat "$f"; printf '\n```\n\n'
  done
} >> "$tmp"
mv -f "$tmp" "$out"
