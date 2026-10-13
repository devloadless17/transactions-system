#!/usr/bin/env bash
#
# Zero-downtime release of the API (blue/green), then the web. Runs ON THE
# SERVER, in the deploy directory, beside the compose files and env files.
#
#   ./release.sh prod    [image tag]     # default tag: IMAGE_TAG from .env
#   ./release.sh staging [image tag]     # default tag: IMAGE_TAG from .env.staging
#   ./release.sh <prod|staging> status   # what runs where, and what Caddy sees
#
# The prod pipeline ships this file as release.sh and the staging pipeline as
# release-staging.sh, so each environment always runs the copy its own
# pipeline shipped (staging is usually a release ahead of prod).
#
# The API runs as two services, <api>-blue and <api>-green. Caddy lists both and
# sends every request to the first HEALTHY one (Caddyfile: lb_policy first). A
# release never stops the live version first:
#
#   1. The new version starts in the other colour, BESIDE the live one.
#   2. It must answer its health check, and Caddy's own health check must have
#      passed on it (the API reports that — proxyCheckedMsAgo — to a caller
#      inside its container). Only then can Caddy route to it.
#   3. The old colour drains: it answers 503 so Caddy moves to the new one
#      within a second, it finishes everything in flight, its background work
#      stops between items and gives back its leases, then it exits.
#   4. The new colour is watched for a few seconds; if it falls over, the
#      previous one is started again.
#   5. The web is swapped (Caddy holds its requests for the moment it restarts).
#
# If the new version never becomes healthy, or Caddy never sees it, it is
# stopped and the old one carries on: a failed release costs nothing.
#
# Background work (withdrawal auto-approval, Whish transfers, the Whish poller)
# must never run in two versions at once. Releases carrying the image label
# com.rivalpayments.blue-green coordinate through database leases, so:
#   overlap       both carry it: the two run side by side as above.
#   overlap-held  only the new one does (the switch-over from the single `api`
#                 container): this script holds the leases, so only the old one
#                 runs that work; traffic and the web move to the new one, and
#                 the old one is stopped between two Whish transfers, with
#                 nothing left calling it. Then the leases go to the new one.
#   sequential    the new one does not (a rollback to an older tag): never side
#                 by side — the old one drains completely first and Caddy holds
#                 requests until the new one is healthy.
#
# Every migration must suit the previous release too (it keeps serving after the
# migrations, and the two overlap): add first, stop using, drop in a later release.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "usage: $0 <prod|staging> [image tag | status]" >&2
  exit 2
}
ENVIRONMENT=${1:-}
case "$ENVIRONMENT" in
  prod)
    COMPOSE=(docker compose -f docker-compose.prod.yml)
    API=api API_CT=txn_api WEB=web WEB_CT=txn_web PG=postgres
    ;;
  staging)
    COMPOSE=(docker compose -p staging --env-file .env.staging -f docker-compose.staging.yml)
    API=api-staging API_CT=txn_api_staging WEB=web-staging WEB_CT=txn_web_staging PG=postgres-staging
    ;;
  *) usage ;;
esac
ACTION=release
if [ "${2:-}" = status ]; then
  ACTION=status
elif [ -n "${2:-}" ]; then
  export IMAGE_TAG="$2" # overrides the env file's IMAGE_TAG for every compose call
fi
LEGACY_CT=$API_CT # the single API container that blue/green replaced

log() { echo "==> $(date +%T.%3N) $*"; }
fail() {
  echo "::error::$*" >&2
  exit 1
}
other() { if [ "$1" = blue ]; then echo green; else echo blue; fi; }
ct() { echo "${API_CT}_$1"; }  # container of a colour
svc() { echo "${API}-$1"; }    # compose service of a colour
running() { [ "$(docker container inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = true ]; }
ct_label() { docker container inspect -f "{{index .Config.Labels \"com.rivalpayments.$2\"}}" "$1" 2>/dev/null || true; }
img_label() { docker image inspect -f "{{index .Config.Labels \"com.rivalpayments.$2\"}}" "$1" 2>/dev/null || true; }
ct_image() { docker container inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || echo '-'; }
# The API's health body when it answers 200 (asked from INSIDE its container).
health_body() { docker exec "$1" wget -qO- -T 3 http://127.0.0.1:3001/v1/health 2>/dev/null; }
serving() { running "$1" && health_body "$1" >/dev/null; }
# Has Caddy's own health check passed on it within the last 2.5s?
caddy_sees() {
  local ago
  ago=$(health_body "$1" | sed -n 's/.*"proxyCheckedMsAgo":\([0-9][0-9]*\).*/\1/p')
  [ -n "$ago" ] && [ "$ago" -lt 2500 ]
}
# A release that drains on SIGTERM exits in seconds; an older one gets 10s.
stop_timeout() { if [ "$(ct_label "$1" graceful-drain)" = 1 ]; then echo 60; else echo 10; fi; }
stop_ct() { # <container>: graceful stop (the container stays, for a quick restart)
  local t
  t=$(stop_timeout "$1")
  log "Draining $1 (SIGTERM; it finishes what it is doing, up to ${t}s)"
  docker stop -t "$t" "$1" >/dev/null
}
wait_until() { # <seconds> <description> <command...>
  local secs=$1 what=$2
  shift 2
  local deadline=$((SECONDS + secs))
  until "$@"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "   gave up waiting for: $what (${secs}s)" >&2
      return 1
    fi
    sleep 1
  done
}

status() {
  for c in blue green; do
    local name state
    name=$(ct "$c")
    if serving "$name"; then
      state="serving"
      caddy_sees "$name" && state="$state, Caddy sees it healthy" || state="$state, NOT yet seen by Caddy"
    elif running "$name"; then
      state="running, not healthy"
    elif docker container inspect "$name" >/dev/null 2>&1; then
      state="stopped"
    else
      state="absent"
    fi
    printf '  %-6s %-24s %-10s %s\n' "$c" "$name" "$state" "$(ct_image "$name")"
  done
  if docker container inspect "$LEGACY_CT" >/dev/null 2>&1; then
    printf '  legacy %-24s %s %s\n' "$LEGACY_CT" "$(running "$LEGACY_CT" && echo running || echo stopped)" "$(ct_image "$LEGACY_CT")"
  fi
}
if [ "$ACTION" = status ]; then
  echo "API ($ENVIRONMENT):"
  status
  exit 0
fi

# One release at a time per environment (a second one waits, then gives up).
exec 9>".release-$ENVIRONMENT.lock"
flock -w 900 9 || fail "Another $ENVIRONMENT release is still running; not starting a second one."

# The image every API colour is defined with right now (IMAGE_TAG).
IMAGE=$("${COMPOSE[@]}" config --images 2>/dev/null | grep -m1 '/transactions-api:' || true)
[ -n "$IMAGE" ] || fail "Could not resolve the API image from the compose file."
docker image inspect "$IMAGE" >/dev/null 2>&1 || "${COMPOSE[@]}" pull --quiet "$(svc blue)" </dev/null \
  || fail "Could not pull $IMAGE. Nothing was changed."

# The live colour is the one Caddy routes to: blue when blue serves, else green.
if serving "$(ct blue)"; then TARGET=green; else TARGET=blue; fi
TARGET_CT=$(ct "$TARGET")
PREVIOUS=() # running API containers to drain: the other colour, the legacy one
running "$(ct "$(other "$TARGET")")" && PREVIOUS+=("$(ct "$(other "$TARGET")")")
running "$LEGACY_CT" && PREVIOUS+=("$LEGACY_CT")
running "$TARGET_CT" && log "$TARGET_CT is running but not live; it is replaced by the new release"

# How the two versions may meet. Only a release that takes job leases (label
# com.rivalpayments.blue-green) may run beside another; when the one going away
# predates them, this script holds those leases itself, so for the whole
# overlap only the old one does background work.
TARGET_AWARE=no
[ "$(img_label "$IMAGE" blue-green)" = 1 ] && TARGET_AWARE=yes
OLD_AWARE=yes
for old in "${PREVIOUS[@]}"; do
  [ "$(ct_label "$old" blue-green)" = 1 ] || OLD_AWARE=no
done
if [ "$TARGET_AWARE" = no ]; then
  MODE=sequential # the new release ignores leases: never beside another version
elif [ "$OLD_AWARE" = yes ]; then
  MODE=overlap
else
  MODE=overlap-held
fi
log "Release $IMAGE to $(svc "$TARGET") (live now: ${PREVIOUS[*]:-none}; mode: $MODE)"

# --- database helpers (psql inside the Postgres container, as its owner) -----
# The leases the API's background work takes (src/database/job-lease.service.ts:
# withdrawal auto-approval, every Whish W2W send, the Whish payment poller).
HELD_LEASES=(withdrawal-auto-approval whish-w2w-send whish-reconciliation)
RELEASE_HOLDER="release:$ENVIRONMENT:$$"
LEASES_HELD=no
# shellcheck disable=SC2016 # $POSTGRES_* expand inside the Postgres container
db() { "${COMPOSE[@]}" exec -T "$PG" sh -c 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<<"$1"; }
take_lease() { # <name>: true once this release holds it (free, run out, or ours)
  db "INSERT INTO job_leases (name, holder, acquired_at, renewed_at, expires_at)
      VALUES ('$1', '$RELEASE_HOLDER', now(), now(), now() + interval '15 minutes')
      ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, acquired_at = now(),
        renewed_at = now(), expires_at = EXCLUDED.expires_at
      WHERE job_leases.holder = EXCLUDED.holder OR job_leases.expires_at <= now()
      RETURNING holder;" 2>/dev/null | grep -q .
}
hold_leases() {
  for name in "${HELD_LEASES[@]}"; do
    wait_until 120 "the $name lease (a run in progress gives it back)" take_lease "$name" \
      || fail "Could not take the $name lease. Nothing was changed."
  done
  LEASES_HELD=yes
  log "Holding the background-work leases: only the live release runs those jobs until it is gone"
}
release_leases() {
  [ "$LEASES_HELD" = yes ] || return 0
  db "UPDATE job_leases SET expires_at = now() WHERE holder = '$RELEASE_HOLDER' AND expires_at > now();" >/dev/null 2>&1 \
    && log "Gave the background-work leases back" \
    || echo "::warning::Could not give the leases back; they run out on their own within 15 minutes." >&2
  LEASES_HELD=no
}
trap release_leases EXIT # whatever happens, never keep the jobs paused
# A Whish transfer is in flight while its row is PENDING (written just before
# the call to Whish). An old release that cannot drain is only stopped between
# transfers, never in the middle of one.
no_transfer_in_flight() {
  [ "$(db "SELECT count(*) FROM whish_transfers WHERE status = 'PENDING' AND created_at > now() - interval '2 minutes';" 2>/dev/null)" = 0 ]
}

# --- the new release -----------------------------------------------------------
start_target() {
  "${COMPOSE[@]}" up -d --no-deps --force-recreate "$(svc "$TARGET")" </dev/null
}
target_failed() { # <reason>: never leave a broken release in place
  "${COMPOSE[@]}" logs --tail 80 "$(svc "$TARGET")" </dev/null || true
  docker stop -t 60 "$TARGET_CT" >/dev/null 2>&1 || true
  fail "$1"
}
crash_looping() { [ "$(docker container inspect -f '{{.RestartCount}}' "$TARGET_CT" 2>/dev/null || echo 0)" -ge 2 ]; }
target_up() { # healthy, or fail fast if it keeps crashing on start
  if crash_looping; then
    echo "   $TARGET_CT keeps crashing on start" >&2
    return 2
  fi
  serving "$TARGET_CT"
}
wait_target_healthy() {
  local deadline=$((SECONDS + 180)) rc
  while :; do
    target_up && return 0
    rc=$?
    [ "$rc" -eq 2 ] && return 1
    [ "$SECONDS" -ge "$deadline" ] && { echo "   gave up waiting for $TARGET_CT to answer its health check (180s)" >&2; return 1; }
    sleep 1
  done
}
# Is the target ready for traffic, as Caddy sees it? A release older than the
# blue-green label can't say, so it gets Caddy's health interval with margin.
caddy_ready() {
  if [ "$TARGET_AWARE" = yes ]; then
    wait_until 60 "Caddy's health check to pass on $TARGET_CT" caddy_sees "$TARGET_CT"
  else
    sleep 3
  fi
}
web_healthy() { [ "$(docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$WEB_CT" 2>/dev/null || true)" = healthy ]; }
WEB_DONE=no
swap_web() {
  log "Swapping the web"
  "${COMPOSE[@]}" up -d --no-deps "$WEB" </dev/null
  wait_until 180 "$WEB_CT to become healthy" web_healthy || {
    "${COMPOSE[@]}" logs --tail 80 "$WEB" </dev/null || true
    fail "The new web release is unhealthy (the API release is live and fine). Roll the web back."
  }
  WEB_DONE=yes
}

case "$MODE" in
  overlap)
    log "Starting $(svc "$TARGET") beside the live API"
    start_target
    wait_target_healthy \
      || target_failed "The new release never became healthy. Nothing was switched: the live API kept serving."
    caddy_ready \
      || target_failed "Caddy never saw the new release healthy (is the Caddyfile with the colour upstreams loaded?). Nothing was switched: the live API kept serving."
    serving "$TARGET_CT" || target_failed "The new release stopped answering. Nothing was switched."
    for old in "${PREVIOUS[@]}"; do stop_ct "$old"; done
    ;;
  overlap-held)
    # The live release predates leases: hold them for it, start the new one
    # beside it, move the traffic and the web over, and only then stop it —
    # between two Whish transfers, with nothing left calling it.
    hold_leases
    log "Starting $(svc "$TARGET") beside the live API (its background work waits for the leases)"
    start_target
    wait_target_healthy \
      || target_failed "The new release never became healthy. Nothing was switched: the live API kept serving."
    caddy_ready \
      || target_failed "Caddy never saw the new release healthy (is the Caddyfile with the colour upstreams loaded?). Nothing was switched: the live API kept serving."
    serving "$TARGET_CT" || target_failed "The new release stopped answering. Nothing was switched."
    swap_web # the new web calls the new API (api-pool), so nothing calls the old one now
    wait_until 60 "no Whish transfer in flight" no_transfer_in_flight \
      || echo "::warning::A Whish transfer row stayed PENDING for a minute; stopping the old API anyway (crash recovery holds such a row for review)." >&2
    for old in "${PREVIOUS[@]}"; do stop_ct "$old"; done
    release_leases
    ;;
  sequential)
    log "No overlap (the new release takes no job leases): the old API drains first, Caddy holds new requests meanwhile"
    for old in "${PREVIOUS[@]}"; do stop_ct "$old"; done
    start_target
    if ! wait_target_healthy || ! caddy_ready; then
      "${COMPOSE[@]}" logs --tail 80 "$(svc "$TARGET")" </dev/null || true
      docker stop -t 60 "$TARGET_CT" >/dev/null 2>&1 || true
      for old in "${PREVIOUS[@]}"; do docker start "$old" >/dev/null 2>&1 || true; done
      fail "The new release never became healthy; the previous API was started again. Check it, then run the release again."
    fi
    ;;
esac

# Watch the new colour for a few seconds now that it carries all the traffic.
# If it falls over (two failed checks in a row, not one blip), bring back the
# previous version: its container was stopped, not removed.
misses=0
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  if serving "$TARGET_CT"; then misses=0; else misses=$((misses + 1)); fi
  if [ "$misses" -ge 2 ]; then
    log "$TARGET_CT stopped answering right after the switch; starting the previous API again"
    for old in "${PREVIOUS[@]}"; do docker start "$old" >/dev/null 2>&1 || true; done
    target_failed "The new release failed right after taking traffic; the previous API was started again."
  fi
done
log "$(svc "$TARGET") is live"

[ "$WEB_DONE" = yes ] || swap_web

# The single API container blue/green replaced: nothing routes to it any more
# (Caddy prefers the colours, and the new web calls api-pool), so remove it.
if docker container inspect "$LEGACY_CT" >/dev/null 2>&1; then
  running "$LEGACY_CT" && stop_ct "$LEGACY_CT"
  docker rm "$LEGACY_CT" >/dev/null
  log "Removed the single-container API ($LEGACY_CT)"
fi

log "Released. API ($ENVIRONMENT):"
status
