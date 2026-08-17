#!/usr/bin/env bash
# ============================================================================
# Monthly restore drill. Installed on the VPS at /home/deploy/verify-backup.sh
# and run by the `txn-verify-backup.timer` systemd timer.
#
# WHY THIS EXISTS: a backup you have never restored is not a backup, it is a file
# you hope about. The nightly job checks the dump PARSES (`pg_restore -l`); this
# job proves it actually RESTORES and that the money data inside it is
# internally consistent. Most backup disasters are discovered at restore time,
# which is the worst possible moment to discover them.
#
# SAFETY — this cannot affect production:
#   * it restores into a THROWAWAY postgres container, never into txn_postgres
#     or txn_postgres_staging;
#   * that container runs with `--network none`, so it has no route to any live
#     database, the app, or the internet;
#   * it is destroyed on every exit path, including failure and interrupt (trap);
#   * it only ever READS the dump file.
#
# Cost: ~50 MB of disk and ~30 seconds, once a month.
# ============================================================================
set -uo pipefail

BACKUP_DIR=/home/deploy/backups
STATUS=/home/deploy/.drill-status
SCRATCH=txn_restore_drill
PG_IMAGE=postgres:16-alpine

cleanup() { docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# This drill deliberately sends NO Telegram message, pass or fail. A restore
# drill failing is important but never an emergency — the live system is fine and
# nothing is happening to clients this minute. It records its verdict here, and
# the daily healthcheck surfaces a failure as a notice. Telegram stays reserved
# for problems that are actually hurting people right now.
record() { echo "$1 $(date -u '+%Y-%m-%d')" > "$STATUS" 2>/dev/null || true; }

fail_drill() {
  echo "  DRILL FAILED: $*"
  record FAIL
  # Exit non-zero so `systemctl status` and the journal both show the failure.
  exit 1
}

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') restore drill"

DUMP=$(ls -1t "$BACKUP_DIR"/txn-*.dump 2>/dev/null | head -1)
[ -n "$DUMP" ] || fail_drill "no backup file found in $BACKUP_DIR"
echo "  dump: $DUMP ($(numfmt --to=iec "$(stat -c %s "$DUMP")"))"

cleanup
docker run -d --name "$SCRATCH" --network none \
  -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=verify "$PG_IMAGE" >/dev/null \
  || fail_drill "could not start the scratch postgres container"

for _ in $(seq 1 45); do
  docker exec "$SCRATCH" pg_isready -U postgres -q && break
  sleep 1
done
docker exec "$SCRATCH" pg_isready -U postgres -q || fail_drill "scratch postgres never became ready"

docker cp "$DUMP" "$SCRATCH:/tmp/r.dump" >/dev/null || fail_drill "could not copy the dump into the scratch container"

# --no-owner/--no-privileges: the drill verifies the DATA restores, and we don't
# want it to fail merely because the prod roles don't exist in a blank instance.
if ! docker exec "$SCRATCH" pg_restore -U postgres -d verify --no-owner --no-privileges /tmp/r.dump 2>/tmp/drill.err; then
  fail_drill "pg_restore reported errors: $(tail -3 /tmp/drill.err 2>/dev/null | tr '\n' ' ')"
fi

q() { docker exec "$SCRATCH" psql -U postgres -d verify -tAc "$1" 2>/dev/null | tr -d ' '; }

TXNS=$(q "SELECT count(*) FROM transactions;")
ENTRIES=$(q "SELECT count(*) FROM ledger_entries;")
echo "  restored: ${TXNS:-?} transactions, ${ENTRIES:-?} ledger entries"

[ "${TXNS:-0}" -gt 0 ] 2>/dev/null      || fail_drill "restored copy has no transactions — the dump is not usable"
[ "${ENTRIES:-0}" -gt 0 ] 2>/dev/null   || fail_drill "restored copy has no ledger entries — the dump is not usable"

# The strongest single assertion available: in a correct double-entry ledger the
# debits and the credits must cancel exactly. If a dump were silently truncated
# mid-table this would not come out to zero.
NET=$(q "SELECT COALESCE(sum(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries;")
case "$NET" in
  0|0.0|0.00000000|0.000000000000000000)
    echo "  ledger balances exactly (DEBIT - CREDIT = $NET)" ;;
  *)
    fail_drill "restored ledger does NOT balance (DEBIT - CREDIT = ${NET:-unreadable})" ;;
esac

record PASS
echo "=== drill passed — the backup is restorable and internally consistent"
exit 0
