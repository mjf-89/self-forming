#!/bin/sh
# sf-secrets-version: 1
# sf-secrets: fetch the service secrets enabled for this command's scope from the Self Forming
# secret broker (SecretBroker.kt) and hand them to a shell. Installed by manage_server
# (servers.js) as <workspace>/.tools/bin/sf-secrets; the source is scripts/sf-secrets.sh.
#
#   sf-secrets --exports [--label TEXT] [--wait SECONDS]
#       stdout: one `export NAME='value'` line per delivered secret (single-quote escaped),
#       nothing else. Use: eval "$(sf-secrets --exports --label 'My server')"
#   sf-secrets --names [--label TEXT] [--wait SECONDS]
#       stdout: the delivered names only (never values), one per line.
#
# Needs SF_SECRETS_URL and SF_SECRETS_TOKEN (set by the app for terminal, server and agent
# commands). Without them it prints nothing and exits 0. --wait is how long the broker may
# wait for a fingerprint answer (default 20, broker maximum 120).
# Diagnostics go to stderr and never contain values. Names that were not delivered are
# reported as one stderr line starting with "sf-secrets: secrets unavailable: ".
# Exit status: 0 broker answered (some names may still be unavailable, see stderr);
# 1 secrets unavailable (reason on stderr); 2 usage error.
set -u

mode=
label=
wait=20
say() { printf 'sf-secrets: %s\n' "$*" >&2; }
unavailable() { say "secrets unavailable: $*"; exit 1; }
usage() { say "usage: sf-secrets --exports|--names [--label TEXT] [--wait SECONDS]"; exit 2; }

while [ $# -gt 0 ]; do
  case $1 in
    --exports) mode=exports ;;
    --names) mode=names ;;
    --label) [ $# -ge 2 ] || usage; label=$2; shift ;;
    --label=*) label=${1#--label=} ;;
    --wait) [ $# -ge 2 ] || usage; wait=$2; shift ;;
    --wait=*) wait=${1#--wait=} ;;
    -h|--help) mode=help ;;
    *) usage ;;
  esac
  shift
done
if [ "$mode" = help ]; then
  sed -n '3,20s/^# \{0,1\}//p' "$0" >&2
  exit 0
fi
[ -n "$mode" ] || usage
case $wait in
  ''|*[!0-9.]*|*.*.*|.) usage ;;
esac

# Not running under the app (or a scope without secrets): nothing to do.
[ -n "${SF_SECRETS_URL:-}" ] && [ -n "${SF_SECRETS_TOKEN:-}" ] || exit 0

command -v curl >/dev/null 2>&1 || unavailable "curl is not installed"
command -v jq >/dev/null 2>&1 || unavailable "jq is not installed"
case $SF_SECRETS_URL in
  http://127.0.0.1:[0-9]*|http://localhost:[0-9]*) ;;
  *) unavailable "SF_SECRETS_URL is not a loopback broker address" ;;
esac
case $SF_SECRETS_TOKEN in
  *[!A-Za-z0-9._~+/=-]*) unavailable "SF_SECRETS_TOKEN has an unexpected format" ;;
esac

query_label=$(printf '%s' "${label:-A Linux command}" | jq -sRr '@uri') || unavailable "could not encode the label"
url="${SF_SECRETS_URL%/}/v1/env?label=${query_label}&wait=${wait}"
max_time=$(awk -v w="$wait" 'BEGIN { w += 0; if (w > 120) w = 120; printf "%d", w + 15 }')

# The token goes through curl's config on stdin (printf is a shell builtin), never argv.
attempt=0
while :; do
  attempt=$((attempt + 1))
  answer=$(printf 'header = "Authorization: Bearer %s"\n' "$SF_SECRETS_TOKEN" |
    curl -sS -K - --max-time "$max_time" --connect-timeout 5 -w '\n%{http_code}' -- "$url" 2>/dev/null)
  code=$?
  status=${answer##*
}
  body=${answer%
*}
  if [ "$code" -ne 0 ]; then
    case $code in
      7) reason="the secret broker is not reachable at $SF_SECRETS_URL (was the app restarted? restart this process)" ;;
      28) reason="the secret broker did not answer within ${max_time}s" ;;
      *) reason="request to the secret broker failed (curl exit $code)" ;;
    esac
    [ "$code" -eq 7 ] && [ "$attempt" -lt 3 ] && { sleep 1; continue; }
    unavailable "$reason"
  fi
  case $status in
    200) break ;;
    503) [ "$attempt" -lt 3 ] && { sleep 1; continue; }; unavailable "the secret broker is busy (HTTP 503)" ;;
    401) unavailable "the secret broker refused the token (HTTP 401; the app was probably restarted since this process started: restart it)" ;;
    *) unavailable "the secret broker answered HTTP $status" ;;
  esac
done

# Validate the shape before printing anything, so stdout is all-or-nothing.
printf '%s' "$body" | jq -e '(.values | type == "object") and ([.values[] | type == "string"] | all)' >/dev/null 2>&1 ||
  unavailable "the secret broker sent an unexpected answer"

NAMES='[.values | keys[] | select(test("^[A-Za-z_][A-Za-z0-9_]*$"))]'
if [ "$mode" = exports ]; then
  out=$(printf '%s' "$body" | jq -r '.values | to_entries[] | select(.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) | "export \(.key)=\(.value | @sh)"') ||
    unavailable "could not format the secrets"
  [ -z "$out" ] || printf '%s\n' "$out"
  unset out
else
  printf '%s' "$body" | jq -r "$NAMES | .[]"
fi

delivered=$(printf '%s' "$body" | jq -r "$NAMES | join(\", \")")
skipped=$(printf '%s' "$body" | jq -r '[.values | keys[] | select(test("^[A-Za-z_][A-Za-z0-9_]*$") | not)] | length')
denied=$(printf '%s' "$body" | jq -r '[.denied[]? | strings] | join(", ")')
locked=$(printf '%s' "$body" | jq -r '[.locked[]? | strings] | join(", ")')
unset body answer
[ -n "$delivered" ] && say "delivered: $delivered" || say "no secrets are enabled for this scope"
[ "$skipped" = 0 ] || say "skipped $skipped secret(s) with names that are not shell variable names"
missing=
[ -z "$denied" ] || missing="declined or not answered in time: $denied"
[ -z "$locked" ] || missing="${missing:+$missing; }cannot be unlocked (no fingerprint or screen lock available): $locked"
[ -z "$missing" ] || say "secrets unavailable: $missing"
exit 0
