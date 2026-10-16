#!/usr/bin/env bash
# Standalone M1 compiler. No Gradle, downloads, installation, or resident process.
set -euo pipefail
export LC_ALL=C
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
WORKSPACE=$(dirname "$REPO")
die() { printf 'plugin: %s\n' "$*" >&2; exit 1; }
usage() { echo 'Usage: scripts/plugin.sh new|build|check <path-or-id>'; }
[[ $# == 2 ]] || { usage >&2; exit 2; }
action=$1; target=$2
case "$action" in new|build|check) ;; *) usage >&2; exit 2;; esac
for tool in jq sha256sum find sort realpath flock unzip zip; do command -v "$tool" >/dev/null || die "Missing tool: $tool"; done
if [[ $target != */* ]]; then target="$WORKSPACE/plugins/$target"; fi
if [[ $action == new ]]; then
  id=$(basename -- "$target")
  [[ $id =~ ^[a-z][a-z0-9-]{1,63}$ ]] || die 'ID must match [a-z][a-z0-9-]{1,63}'
  [[ ! -e $target && ! -L $target ]] || die 'Refusing to overwrite an existing path'
  mkdir -p -- "$(dirname -- "$target")"
  tmp=$(mktemp -d "$(dirname -- "$target")/.plugin-new.XXXXXX")
  trap 'rm -rf -- "$tmp"' EXIT
  cp -R "$REPO/examples/plugins/counter/." "$tmp/"
  jq --arg id "$id" '.id=$id | .name=$id | .provides=[{id:($id+".value"),version:1}]' "$tmp/plugin.json" > "$tmp/plugin.json.tmp"
  mv "$tmp/plugin.json.tmp" "$tmp/plugin.json"
  sed -i "s/counter.value/$id.value/" "$tmp/web/index.js"
  mv -T -- "$tmp" "$target"
  echo "Created $target (counter starter; customize its name and services)."
  exit
fi
[[ -d $target && ! -L $target ]] || die "Not a plugin directory: $target"
root=$(realpath -e -- "$target")
# Reject symlinks, special files and ambiguous record delimiters, including sources.
validate_tree() {
  local dir=$1 p
  [[ -z $(find "$dir" -type l -print -quit) ]] || die 'Symlinks are not allowed'
  [[ -z $(find "$dir" ! -type f ! -type d -print -quit) ]] || die 'Special files are not allowed'
  [[ -z $(find "$dir" \( -name $'*\n*' -o -name $'*\r*' -o -name '*\\*' \) -print -quit) ]] || die 'Invalid path characters' 
}
validate_manifest() {
  local dir=$1
  [[ -f $dir/plugin.json ]] || die 'Missing plugin.json'
  (( $(stat -c %s "$dir/plugin.json") <= 1048576 )) || die 'Manifest exceeds 1 MiB'
  jq -e '
    def path($prefix): type=="string" and startswith($prefix) and
      (split("/") | all(. != "" and . != "." and . != "..")) and
      (explode | all(. >= 32 and . != 92));
    def contracts: type=="array" and all(.[]; type=="object" and
      (.id|type=="string" and length<=256 and test("\\S") and (explode|all(.>=32))) and
      (.version|type=="number" and .>0 and .<=2147483647 and floor==.)) and
      ((map([.id,.version])|unique|length)==length);
    type=="object" and (.id|type=="string" and test("^[a-z][a-z0-9-]{1,63}$")) and
    (.name|type=="string" and length<=256 and test("\\S")) and (.version|type=="string" and length<=256 and test("\\S")) and
    .api==1 and (.reload=="scope" or .reload=="page" or .reload=="restart") and
    ((if has("provides") then .provides else [] end)|contracts) and
    ((if has("requires") then .requires else [] end)|contracts) and
    ((if has("uses") then .uses else [] end)|contracts) and
    (has("web") or has("native")) and
    ((has("web")|not) or (.web|type=="object" and (.entry|path("web/")))) and
    ((has("native")|not) or (.reload=="restart" and (.native|type=="object" and
      .jar=="native/module.jar" and (.class|type=="string" and test("^[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)+$")))))
  ' "$dir/plugin.json" >/dev/null || die 'Invalid M1 manifest (requires api:1, facets, reload and versioned contract arrays; native jar must be native/module.jar)'
  if jq -e 'has("web")' "$dir/plugin.json" >/dev/null; then
    [[ -f $dir/$(jq -r .web.entry "$dir/plugin.json") ]] || die 'Missing web entry'
  fi
}
# Agent Skills ship inside the web facet, web/skills/<name>/SKILL.md (+ scripts/,
# references/, assets/): web/** is what this script and the Android host hash, snapshot
# and serve. A top-level skills/ would be silently left out of the revision, so it is
# refused. Frontmatter: name equal to the folder, a nonempty description (<= 1024).
validate_skills() {
  local dir=$1 skill name front fname fdesc
  [[ ! -e $dir/skills ]] || die 'skills/ is not shipped: put each skill in web/skills/<name>/SKILL.md'
  [[ -e $dir/web/skills ]] || return 0
  [[ -d $dir/web/skills ]] || die 'web/skills must be a directory'
  [[ -z $(find "$dir/web/skills" -mindepth 1 -maxdepth 1 ! -type d -print -quit) ]] || die 'web/skills/ may only contain skill folders'
  while IFS= read -r -d '' skill; do
    name=${skill##*/}
    [[ $name =~ ^[a-z0-9]+(-[a-z0-9]+)*$ && ${#name} -le 64 ]] || die "Invalid skill folder name: $name (lowercase letters, digits, single hyphens)"
    [[ -f $skill/SKILL.md ]] || die "Skill $name has no SKILL.md"
    [[ $(head -n 1 "$skill/SKILL.md" | tr -d '\r\357\273\277') == '---' ]] || die "Skill $name: SKILL.md must start with YAML frontmatter (---)"
    front=$(awk 'NR == 1 { next } /^---[[:space:]]*\r?$/ { closed = 1; exit } { print } END { if (!closed) exit 3 }' "$skill/SKILL.md") || die "Skill $name: frontmatter is not closed with ---"
    fname=$(printf '%s\n' "$front" | sed -n 's/^name:[[:space:]]*//p' | head -n 1 | sed "s/[[:space:]]*\r\{0,1\}\$//; s/^[\"']\(.*\)[\"']\$/\1/")
    fdesc=$(printf '%s\n' "$front" | sed -n 's/^description:[[:space:]]*//p' | head -n 1 | sed "s/[[:space:]]*\r\{0,1\}\$//; s/^[\"']\(.*\)[\"']\$/\1/")
    [[ $fname == "$name" ]] || die "Skill $name: frontmatter name is '${fname}', expected '$name'"
    [[ -n $fdesc ]] || die "Skill $name: frontmatter needs a description"
    (( ${#fdesc} <= 1024 )) || die "Skill $name: description exceeds 1024 characters"
  done < <(find "$dir/web/skills" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
}
# Sorted canonical records, only shipped files (or compiler inputs when requested).
records() {
  local dir=$1 mode=$2 p rel digest
  while IFS= read -r -d '' p; do
    rel=${p#"$dir/"}
    case "$rel" in
      plugin.json|web/*) ;;
      native/src/*) [[ $mode == inputs ]] || continue;;
      native/module.jar) [[ $mode == shipped ]] || continue;;
      *) continue;;
    esac
    digest=$(sha256sum "$p"); digest=${digest%% *}
    printf '%s\0%s\n' "$rel" "$digest"
  done < <(find "$dir" -type f -print0 | sort -z)
}
check_package() {
  local dir=$1 count bytes
  validate_tree "$dir"; validate_manifest "$dir"; validate_skills "$dir"
  read -r count bytes < <(cd "$dir"; find . -type f \( -path './plugin.json' -o -path './web/*' -o -path './native/module.jar' \) -printf '%s\n' | awk '{n++; b+=$1} END {printf "%d %.0f\n", n, b}')
  (( count <= 4096 && bytes <= 67108864 )) || die 'Shipped package exceeds 4096 files or 64 MiB'
  if jq -e 'has("native")' "$dir/plugin.json" >/dev/null; then
    [[ -f $dir/native/module.jar ]] || die 'Missing native/module.jar; run build first'
    unzip -tqq "$dir/native/module.jar" || die 'Invalid dex jar'
    unzip -Z1 "$dir/native/module.jar" | grep -x classes.dex >/dev/null || die 'Jar has no classes.dex'
  fi
}
validate_tree "$root"; validate_manifest "$root"
if [[ $action == check ]]; then
  check_package "$root"
  echo "Valid M1 package: $(records "$root" shipped | sha256sum | cut -d' ' -f1)"
  exit
fi
mkdir -p "$root/out/plugin-build"
exec 9>"$root/out/plugin-build/lock"
flock -n 9 || die 'Another build is active for this source directory'
stage=$(mktemp -d "$root/out/plugin-build/.stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
records "$root" inputs > "$stage/inputs.before"
mkdir -p "$stage/package/native"
cp "$root/plugin.json" "$stage/package/"
[[ ! -d $root/web ]] || cp -R "$root/web" "$stage/package/"
[[ ! -d $root/native/src ]] || cp -R "$root/native/src" "$stage/package/native/"
records "$stage/package" inputs > "$stage/inputs.copy"
cmp -s "$stage/inputs.before" "$stage/inputs.copy" || die 'Inputs changed while staging; retry'
if jq -e 'has("native")' "$stage/package/plugin.json" >/dev/null; then
  sdk="$REPO/apps/android/app/src/main/java/md/incept/selfforming/plugin/PluginApi.kt"
  [[ -f $sdk ]] || die "Needs native helper: missing single-source SDK $sdk"
  export JAVA_HOME=${JAVA_HOME:-/opt/pi-android/jdk}
  export PATH="$JAVA_HOME/bin:$PATH"
  kh=${PLUGIN_KOTLIN_HOME:-$WORKSPACE/plugin-bench/tools/kotlinc}
  android=${PLUGIN_ANDROID_JAR:-/opt/pi-android/sdk/platforms/android-36/android.jar}
  d8=${PLUGIN_D8_JAR:-/opt/pi-android/sdk/build-tools/36.0.0/lib/d8.jar}
  stdlib="$kh/lib/kotlin-stdlib.jar"
  for f in "$kh/bin/kotlinc" "$android" "$d8" "$stdlib"; do [[ -f $f ]] || die "Missing installed tool: $f (see skills/plugins/SKILL.md)"; done
  "$kh/bin/kotlinc" -version 2>&1 | grep -q 'kotlinc-jvm 2.2.20 ' || die 'Requires Kotlin compiler 2.2.20'
  cp "$sdk" "$stage/PluginApi.kt"
  start=$SECONDS
  "$kh/bin/kotlinc" -jvm-target 17 -no-stdlib -no-reflect -classpath "$android:$stdlib" -d "$stage/host-api.jar" "$stage/PluginApi.kt"
  echo "SDK compile: $((SECONDS-start))s"
  mapfile -d '' sources < <(find "$stage/package/native/src" -type f -name '*.kt' -print0 | sort -z)
  (( ${#sources[@]} > 0 )) || die 'No native/src/**/*.kt files'
  start=$SECONDS
  "$kh/bin/kotlinc" -jvm-target 17 -no-stdlib -no-reflect -classpath "$android:$stage/host-api.jar:$stdlib" -d "$stage/plugin.jar" "${sources[@]}"
  echo "Plugin compile: $((SECONDS-start))s"
  klass=$(jq -r .native.class "$stage/package/plugin.json"); klass=${klass//.//}
  unzip -Z1 "$stage/plugin.jar" | grep -Fx "$klass.class" >/dev/null || die 'Declared native entry class missing'
  # Input is ONLY plugin.jar; host SDK, platform and stdlib are classpath, never bundled.
  start=$SECONDS
  java -cp "$d8" com.android.tools.r8.D8 --release --min-api 28 --lib "$android" --classpath "$stage/host-api.jar" --classpath "$stdlib" --output "$stage/dex.jar" "$stage/plugin.jar"
  echo "D8: $((SECONDS-start))s"
  mkdir "$stage/dex"
  unzip -q "$stage/dex.jar" -d "$stage/dex"
  find "$stage/dex" -type f -exec touch -t 198001010000.00 {} +
  (cd "$stage/dex"; find . -type f -printf '%P\n' | sort | zip -q -X ../package/native/module.jar -@)
  cmp -s "$sdk" "$stage/PluginApi.kt" || die 'SDK changed during build; retry'
fi
check_package "$stage/package"
validate_tree "$root"
records "$root" inputs > "$stage/inputs.after"
cmp -s "$stage/inputs.before" "$stage/inputs.after" || die 'Inputs changed during build; previous output preserved'
# The only generated shipped output is replaced by one atomic rename on this filesystem.
# All validation/compilation stages above must succeed before touching it.
if [[ -f $stage/package/native/module.jar ]]; then
  mkdir -p "$root/native"
  mv -f "$stage/package/native/module.jar" "$root/native/module.jar"
fi
# Preserve SDK jar, JVM classes and staged inputs for inspection in ignored out/.
result="${stage/.stage./build.}"
mv -- "$stage" "$result"
trap - EXIT
echo "Built $root"
echo "Build artifacts: $result"
echo "Revision: $(records "$root" shipped | sha256sum | cut -d' ' -f1)"
