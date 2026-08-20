#!/usr/bin/env bash
# ============================================================================
# Daily Postgres backup for the PRODUCTION transactions DB.
#
# Installed on the VPS at /home/deploy/backup-db.sh and run daily at 00:00
# Asia/Beirut by the `txn-db-backup.timer` systemd timer (units live in
# /etc/systemd/system/). A systemd timer rather than cron because Ubuntu's vixie
# cron has no CRON_TZ, so a cron line can only be pinned to UTC and would drift an
# hour each time Lebanon changes DST; systemd's `OnCalendar=... Asia/Beirut` stays
# at local midnight year-round.
#
# This script is NOT shipped by the deploy workflow (which only scp's the compose
# files + Caddyfile); this copy lives in the repo so it is reviewable and
# reinstallable rather than being a server-only snowflake. If you change it here,
# re-copy it to the server:
#
#   scp scripts/backup-db.sh deploy@<vps>:/home/deploy/backup-db.sh
#
# Operating it on the server:
#   systemctl list-timers txn-db-backup.timer     # when it next runs / last ran
#   systemctl start txn-db-backup.service         # take a backup right now
#   journalctl -u txn-db-backup.service -n 20     # did the last run succeed?
#   tail /home/deploy/backups/backup.log          # what it actually did
#
# RESTORING (destructive — never run against a healthy prod DB):
#   docker cp /home/deploy/backups/txn-<date>.dump txn_postgres:/tmp/r.dump
#   docker exec txn_postgres pg_restore -U <POSTGRES_USER> -d <POSTGRES_DB> \
#     --clean --if-exists /tmp/r.dump
# To inspect a dump without restoring anything: `pg_restore -l /tmp/r.dump`.
#
# ---------------------------------------------------------------------------
# Retention: keeps the newest $KEEP dump(s) and deletes the rest. The new dump is
# written to a .partial file, VERIFIED, and only then moved into place — the old
# backup is not deleted until a good new one exists, so there is never a moment
# with zero backups on disk, and a failed/corrupt dump can never overwrite the
# last known-good one.
#
# KEEP=1 means "one backup, replaced daily" (what was asked for). The DB dumps to
# roughly 4 MB, so KEEP=7 (a week of history) costs ~25 MB on a disk with 88 GB
# free. A week of history is what protects you from damage you don't notice the
# same day — with KEEP=1, a bad Monday silently becomes your only copy by Tuesday.
# Change the single number below if you want that.
# ---------------------------------------------------------------------------
#
# pg_dump is a read-only operation against the live DB; it does not lock writers
# and does not modify any data.
# ============================================================================
set -euo pipefail

KEEP=1
DIR=/home/deploy/backups
ENV_FILE=/home/deploy/transactions-system/.env
CONTAINER=txn_postgres

mkdir -p "$DIR"
# Trim the log BEFORE redirecting into it — doing it at the end would leave this
# run's stdout pointing at the replaced (unlinked) inode, silently losing the
# very lines that say whether the backup worked.
if [ -f "$DIR/backup.log" ]; then
  tail -n 500 "$DIR/backup.log" > "$DIR/backup.log.trim" && mv -f "$DIR/backup.log.trim" "$DIR/backup.log"
fi
# Everything from here on is logged; cron mail is not configured on this box, so
# the log file is the only record of what happened.
exec >>"$DIR/backup.log" 2>&1

fail() { echo "  FAILED: $*  (previous backup left untouched)"; exit 1; }

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') backup starting"

# Credentials live only in the server-side .env, rendered by the deploy workflow
# from GitHub secrets. Read them rather than hardcoding anything here.
[ -r "$ENV_FILE" ] || fail "cannot read $ENV_FILE"
PG_USER=$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
PG_DB=$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$PG_USER" ] && [ -n "$PG_DB" ] || fail "POSTGRES_USER/POSTGRES_DB missing from $ENV_FILE"

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || fail "$CONTAINER is not running"

# Stamp in the SCHEDULE's timezone, not UTC: the timer fires at 00:00
# Asia/Beirut, which is still "yesterday" in UTC — a UTC stamp would name every
# nightly dump with the previous day's date and mislead an operator mid-incident.
STAMP=$(TZ=Asia/Beirut date '+%Y-%m-%d')
TMP="$DIR/.txn-$STAMP.dump.partial"
OUT="$DIR/txn-$STAMP.dump"
IN_CONTAINER=/tmp/txn-backup.dump

# -Fc = custom format: compressed, and restorable selectively with pg_restore.
# Dump INSIDE the container so the verify step below can use the matching
# pg_restore binary (the host has no postgres client tools installed).
docker exec "$CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -f "$IN_CONTAINER" \
  || fail "pg_dump errored"

# Verify before trusting it: pg_restore -l parses the archive's table of contents,
# so a truncated, empty or corrupt dump fails HERE rather than silently becoming
# your only backup and being discovered on the day you actually need it.
docker exec "$CONTAINER" pg_restore -l "$IN_CONTAINER" >/dev/null 2>&1 \
  || { docker exec "$CONTAINER" rm -f "$IN_CONTAINER"; fail "dump did not verify"; }

docker cp "$CONTAINER:$IN_CONTAINER" "$TMP" || fail "could not copy dump out of the container"
docker exec "$CONTAINER" rm -f "$IN_CONTAINER" || true

SIZE=$(stat -c %s "$TMP")
[ "$SIZE" -gt 100000 ] || { rm -f "$TMP"; fail "dump suspiciously small (${SIZE} bytes)"; }

# Atomic within the same filesystem: the backup becomes visible under its real
# name in one step, never half-written.
mv -f "$TMP" "$OUT"
echo "  wrote $OUT ($(numfmt --to=iec "$SIZE"))"

# Only now that a verified new backup exists do we drop the old ones.
ls -1t "$DIR"/txn-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" && echo "  pruned $old"
done

echo "  done — $(ls -1 "$DIR"/txn-*.dump 2>/dev/null | wc -l) backup(s) on disk"
