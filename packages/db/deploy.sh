#!/bin/sh
# ============================================================================
# Production deploy: apply migrations, rotate the runtime RLS role password,
# optionally seed. Run as a one-shot container from the API image (which carries
# the Prisma CLI, tsx, the schema and the generated client) — see the `migrate`
# service in docker-compose.prod.yml.
#
#   docker compose -f docker-compose.prod.yml run --rm migrate
#
# Required env:
#   DATABASE_MIGRATIONS_URL   superuser connection (owns tables, bypasses RLS)
#   POSTGRES_PASSWORD_RLS     new password for the runtime RLS role
# Optional env:
#   POSTGRES_USER_RLS         RLS role name (default: txn_app_rls)
#   SEED_DATABASE             "true" to run the seed (first deploy only)
#   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD   initial super admin (seed)
# ============================================================================
set -eu

: "${DATABASE_MIGRATIONS_URL:?DATABASE_MIGRATIONS_URL is required}"
: "${POSTGRES_PASSWORD_RLS:?POSTGRES_PASSWORD_RLS is required}"
RLS_USER="${POSTGRES_USER_RLS:-txn_app_rls}"

# Run from packages/db so pnpm resolves the Prisma schema + scripts here.
cd "$(dirname "$0")"

# Prisma CLI + the seed connect as the migrations (superuser) role.
export DATABASE_URL="$DATABASE_MIGRATIONS_URL"

echo "==> Applying migrations (prisma migrate deploy)"
pnpm exec prisma migrate deploy

# Migration 0003 creates the runtime RLS role with a committed dev password.
# Rotate it to the real secret: production env-validation refuses to boot the API
# if DATABASE_URL still contains the dev password. Idempotent — safe every deploy.
# Single quotes in the password are escaped (doubled) for the SQL literal.
echo "==> Rotating ${RLS_USER} role password"
ESCAPED_PW=$(printf '%s' "$POSTGRES_PASSWORD_RLS" | sed "s/'/''/g")
printf "ALTER ROLE %s WITH PASSWORD '%s';" "$RLS_USER" "$ESCAPED_PW" \
  | pnpm exec prisma db execute --url "$DATABASE_MIGRATIONS_URL" --stdin

if [ "${SEED_DATABASE:-false}" = "true" ]; then
  echo "==> Seeding database (SEED_DATABASE=true)"
  pnpm exec tsx prisma/seed.ts
else
  echo "==> Skipping seed (set SEED_DATABASE=true for the first deploy)"
fi

echo "==> Deploy migrate step complete."
