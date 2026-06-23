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
#
# Bound how long any migration statement WAITS to acquire a lock (lock_timeout).
# `migrate deploy` runs while the OLD api is still serving money writes, so a
# plain CREATE INDEX / backfill UPDATE that can't get its lock should error out
# fast rather than queue behind a writer and then block every INSERT/UPDATE on the
# table for the whole build. Large-table indexes should STILL be built CONCURRENTLY
# out-of-band first (see docs/DEPLOYMENT.md) — the `IF NOT EXISTS` migrations then
# no-op. (If the connector ignores the `options` param this is simply a no-op, so
# it can never break a deploy.)
case "$DATABASE_MIGRATIONS_URL" in
  *\?*) _opt_sep='&' ;;
  *)    _opt_sep='?' ;;
esac
export DATABASE_URL="${DATABASE_MIGRATIONS_URL}${_opt_sep}options=-c%20lock_timeout%3D5000"

echo "==> Applying migrations (prisma migrate deploy, lock_timeout=5s)"
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

# Whish SANDBOX shares ONE upstream account across environments (dev, staging,
# manual Postman tests). Whish treats externalId as a PERMANENT idempotency key —
# it remembers every id ever used, even after we WIPE our DB. A per-DB autoincrement
# (or the seed's epoch base, which manual `date +%s` tests also occupy) then
# re-issues ids already burned on the account, so Whish returns the existing empty
# record and the app reports "Whish did not return a collect URL". Push the
# externalId sequence into a high, time-advancing band (now-epoch + 7e9): manual
# epoch tests never reach it (epoch hits 7e9 in ~2192), and because it climbs with
# wall-clock it always lands above anything used before a DB wipe — so sandbox links
# always mint fresh. GREATEST(.., current max) keeps it monotonic within a DB.
# Gated on WHISH_ALLOW_SANDBOX, so the LIVE prod account (flag false, ids not
# shared) is NEVER touched. Best-effort: a failure here can't fail the deploy and
# self-heals on the next one.
if [ "${WHISH_ALLOW_SANDBOX:-false}" = "true" ]; then
  echo "==> Whish sandbox: raising whish_payments_external_id_seq above the shared-account / wiped-DB collision range"
  pnpm exec prisma db execute --url "$DATABASE_MIGRATIONS_URL" --stdin <<'SQL' || echo "WARN: whish externalId seq bump failed (non-fatal); will retry next deploy"
DO $$ BEGIN
  PERFORM setval('public.whish_payments_external_id_seq',
    GREATEST(
      (SELECT floor(extract(epoch from now()))::bigint + 7000000000),
      (SELECT COALESCE(MAX(external_id), 0) FROM whish_payments)
    ), true);
END $$;
SQL
fi

echo "==> Deploy migrate step complete."
