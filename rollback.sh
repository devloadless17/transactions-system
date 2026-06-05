#!/bin/sh
# ============================================================================
# Roll the production stack back to the previous (or a specific) release.
#
#   ./rollback.sh            # revert to the last-known-good release (.deploy_previous)
#   ./rollback.sh <git-sha>  # revert to a specific pushed image tag
#
# Each deploy pins IMAGE_TAG to its commit SHA and records:
#   .deploy_current   — the SHA running now
#   .deploy_previous  — the SHA running before it (the rollback target)
#
# Only api + web are recreated (`--no-deps`); postgres/redis/caddy keep running,
# so the database and its volume are never touched. NOTE: this reverts CODE, not
# the schema — `prisma migrate deploy` is forward-only and is NOT undone here. If
# the bad release shipped a destructive migration, restore the DB from a backup.
# ============================================================================
set -eu
cd "$(dirname "$0")"

COMPOSE="docker-compose.prod.yml"
TARGET="${1:-$(cat .deploy_previous 2>/dev/null || true)}"

if [ -z "$TARGET" ]; then
  echo "No previous release recorded and no tag given."
  echo "Usage: ./rollback.sh <git-sha>"
  exit 1
fi

echo "==> Rolling back api + web to: $TARGET"
IMAGE_TAG="$TARGET" docker compose -f "$COMPOSE" pull api web
IMAGE_TAG="$TARGET" docker compose -f "$COMPOSE" up -d --no-deps --force-recreate api web

# Make the rollback sticky so the next plain `up -d` doesn't jump back to the bad
# release, and record it as the current version.
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$TARGET|" .env
echo "$TARGET" > .deploy_current

echo "==> Waiting for API health"
RETRIES=0; MAX=45
until [ "$RETRIES" -ge "$MAX" ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' txn_api 2>/dev/null || echo "starting")
  [ "$STATUS" = "healthy" ] && { echo "API is healthy!"; break; }
  RETRIES=$((RETRIES + 1)); echo "  ...($RETRIES/$MAX) status=$STATUS"; sleep 4
done

docker compose -f "$COMPOSE" ps
