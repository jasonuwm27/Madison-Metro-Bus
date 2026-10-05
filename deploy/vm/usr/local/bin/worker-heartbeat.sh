#!/usr/bin/env bash
#
# Heartbeat for a collector worker, based on DATA rather than on liveness.
#
#   worker-heartbeat.sh <SLUG> <env-file>
#
# WHY NOT PING FROM THE WORKER ITSELF
# A worker process can be perfectly alive and writing nothing: the database
# refusing connections, the upsert failing every poll, the feed returning
# garbage, a disk full. Systemd would report `active`, an in-process ping would
# fire happily, and the check would stay green while collection had stopped.
# That is the failure this exists to catch, so the signal has to come from the
# only thing that proves collection worked -- rows landing in the database.
#
# The query asks: has any observation been written in the last N minutes? The
# worker polls every 30s, so a threshold of 10 minutes is ~20 missed polls --
# comfortably past transient feed errors, well short of the 30-minute grace.
#
# Exit non-zero (and send /fail) when the answer is no, so healthchecks.io
# shows a failure immediately rather than waiting for the period to lapse.

set -uo pipefail

SLUG="${1:?usage: worker-heartbeat.sh <SLUG> <env-file>}"
ENVFILE="${2:?usage: worker-heartbeat.sh <SLUG> <env-file>}"
STALE_MINUTES="${STALE_MINUTES:-10}"

HC_ENV=/etc/bus-healthchecks.env
URL=""
if [[ -r "$HC_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$HC_ENV"
  VAR="HC_${SLUG}"
  URL="${!VAR:-}"
fi

# Clear any inherited DATABASE_URL BEFORE sourcing. Otherwise a value already
# exported in the caller's environment silently wins, and the heartbeat reports
# on the wrong database entirely -- which is exactly what happened when this
# was first tested against a deliberately-broken env file.
unset DATABASE_URL
# shellcheck disable=SC1090
set -a; source "$ENVFILE"; set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FAIL: ${ENVFILE} defines no DATABASE_URL" >&2
  exit 1
fi

PSQL=/usr/pgsql-17/bin/psql

# Rows written recently, and how stale the newest write is. last_seen_at is
# bumped on every upsert, including unchanged re-polls, so it tracks "the
# worker is successfully writing" rather than "new stops appeared".
READING="$(
  "$PSQL" "$DATABASE_URL" -tAc \
    "select count(*), coalesce(round(extract(epoch from now() - max(last_seen_at))/60)::int, 999999)
     from stop_time_observations
     where last_seen_at > now() - interval '${STALE_MINUTES} minutes'" 2>/dev/null
)" || READING=""

if [[ -z "$READING" ]]; then
  BODY="FAIL: could not query the database at all"
  STATUS=1
  RECENT=0
  AGE="unknown"
else
  RECENT="${READING%%|*}"
  AGE="${READING##*|}"
  if [[ "$RECENT" -gt 0 ]]; then
    BODY="ok: ${RECENT} rows written in the last ${STALE_MINUTES}m (newest ${AGE}m old)"
    STATUS=0
  else
    BODY="FAIL: process may be alive but NO rows written in ${STALE_MINUTES}m (newest ${AGE}m old)"
    STATUS=1
  fi
fi

if [[ -z "$URL" ]]; then
  echo "worker-heartbeat: no URL for ${SLUG}; unmonitored. ${BODY}" >&2
else
  SUFFIX=""
  [[ $STATUS -ne 0 ]] && SUFFIX="/fail"
  curl -fsS -m 15 --retry 3 --data-raw "$BODY" "${URL}${SUFFIX}" >/dev/null 2>&1 || true
fi

echo "$BODY"

# Explicit, and deliberately the last statement: a non-zero exit is what makes
# systemd mark the unit failed and what lets `systemctl start` surface the
# problem. Reporting FAIL in the body while exiting 0 would leave the unit
# looking successful in `systemctl show -p Result`.
exit "$STATUS"
