#!/usr/bin/env bash
#
# Wrap a scheduled job so its success, failure and duration are reported to a
# healthchecks.io endpoint.
#
#   healthcheck-wrap.sh <SLUG> <command...>
#
# The endpoint URL is read from /etc/bus-healthchecks.env as HC_<SLUG>, so URLs
# live in one root-owned 600 file rather than being scattered through unit
# definitions (systemd unit files are world-readable, and a ping URL is a
# capability -- anyone holding it can silence your alerts).
#
# WHY WRAP RATHER THAN PING FROM THE APP
# A job that dies before it starts -- a broken unit file, a missing binary, a
# failed `git pull` leaving a syntax error -- never reaches application code,
# so an in-app ping would stay silent about exactly the failures that matter
# most. Wrapping at the systemd level means the absence of a ping is itself the
# alert: healthchecks.io fires when it hears nothing within the grace period.
#
# Sends /start before, then /fail with output on error or a plain ping on
# success. Failure output is redacted -- these commands take DATABASE_URL as an
# argument, and a crash dump would otherwise post the password to a third party.

set -uo pipefail

SLUG="${1:?usage: healthcheck-wrap.sh <SLUG> <command...>}"
shift

ENV_FILE=/etc/bus-healthchecks.env
URL=""
if [[ -r "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  VAR="HC_${SLUG}"
  URL="${!VAR:-}"
fi

redact() {
  sed -E \
    -e 's#(postgres(ql)?://[^:]+:)[^@]*(@)#\1<redacted>\3#g' \
    -e 's#(password=)[^ &]*#\1<redacted>#gI' \
    -e 's#(token[^ ]{0,3} *[:=] *)[^ ,}]*#\1<redacted>#gI'
}

ping() {
  local suffix="$1" body="${2:-}"
  [[ -z "$URL" ]] && return 0
  # Never let a monitoring failure fail the job it is monitoring.
  if [[ -n "$body" ]]; then
    curl -fsS -m 15 --retry 3 --data-raw "$body" "${URL}${suffix}" >/dev/null 2>&1 || true
  else
    curl -fsS -m 15 --retry 3 "${URL}${suffix}" >/dev/null 2>&1 || true
  fi
}

if [[ -z "$URL" ]]; then
  echo "healthcheck-wrap: no URL configured for ${SLUG}; running unmonitored" >&2
fi

ping "/start"

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

START=$(date +%s)
"$@" > >(tee "$OUTPUT_FILE") 2> >(tee -a "$OUTPUT_FILE" >&2)
STATUS=$?
ELAPSED=$(( $(date +%s) - START ))

# Last 8KB only: healthchecks.io truncates at 10KB, and the tail holds the
# error while the head holds startup noise.
BODY="$(tail -c 8000 "$OUTPUT_FILE" | redact)"

if [[ $STATUS -eq 0 ]]; then
  ping "" "ok in ${ELAPSED}s"$'\n'"${BODY}"
else
  ping "/fail" "FAILED exit=${STATUS} after ${ELAPSED}s"$'\n'"${BODY}"
fi

exit $STATUS
