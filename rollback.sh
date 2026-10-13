#!/usr/bin/env bash
# ============================================================================
# Roll production back to the previous (or a specific) release.
#
#   ./rollback.sh            # revert to the last-known-good release (.deploy_previous)
#   ./rollback.sh <git-sha>  # revert to a specific pushed image tag
#
# Each deploy pins IMAGE_TAG to its commit SHA and records:
#   .deploy_current   — the SHA running now
#   .deploy_previous  — the SHA running before it (the rollback target)
#
# A rollback is an ordinary release of the older tag (./release.sh): the API
# that serves now keeps serving until the older one is healthy and Caddy sees
# it, then drains — no downtime, and if the older one won't start, nothing
# changes. (A tag from before job leases is never run beside another version:
# the release script then drains the current one first, Caddy holding requests
# for those seconds.) Then the web. Postgres, Redis and Caddy are untouched.
#
# NOTE: this reverts CODE, not the schema — `prisma migrate deploy` is
# forward-only and is NOT undone here. If the bad release shipped a destructive
# migration, restore the DB from a backup.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker-compose.prod.yml"
TARGET="${1:-$(cat .deploy_previous 2>/dev/null || true)}"

if [ -z "$TARGET" ]; then
  echo "No previous release recorded and no tag given."
  echo "Usage: ./rollback.sh <git-sha>"
  exit 1
fi

echo "==> Rolling back to: $TARGET"
IMAGE_TAG="$TARGET" docker compose -f "$COMPOSE" pull api-blue web </dev/null
./release.sh prod "$TARGET" </dev/null

# Make the rollback sticky (the next plain compose command sees this tag) and
# record it as the current version.
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$TARGET|" .env
echo "$TARGET" > .deploy_current
echo "==> Rolled back to $TARGET"
