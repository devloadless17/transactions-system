#!/usr/bin/env bash
# ============================================================================
# Daily production watchdog. Installed on the VPS at /home/deploy/healthcheck.sh
# and run by the `txn-healthcheck.timer` systemd timer.
#
# TWO SEVERITY TIERS — this matters, read it before adding a check:
#
#   URGENT  -> sends Telegram. Reserved for "clients are affected right now, or
#              will be within days unless someone acts": the site is down, a prod
#              container is down, TLS renewal has actually failed, the disk is
#              about to stop Postgres accepting writes, or backups have been dead
#              for a week. Telegram is the same chat that carries real load/payout
#              requests, so anything that is merely untidy MUST NOT go there —
#              an ops channel people learn to ignore protects nobody.
#
#   NOTICE  -> journal + /home/deploy/ops-status.txt only. Never Telegram.
#              Things worth knowing at your convenience.
#
# Read-only: it inspects containers, reads cert files and does one HTTPS GET of
# the public site. It never restarts, writes to, or reconfigures anything.
#
#   /home/deploy/healthcheck.sh          # normal run
#   /home/deploy/healthcheck.sh --test   # force one Telegram message, to prove
#                                        # the urgent path actually works
#   cat /home/deploy/ops-status.txt      # last result, any time, no Telegram
# ============================================================================
set -uo pipefail

NOTIFY=/home/deploy/notify-telegram.sh
BACKUP_DIR=/home/deploy/backups
STATUS_FILE=/home/deploy/ops-status.txt
CADDY=txn_caddy
PUBLIC_URL=https://portal.rivalpayments.com/

# Caddy renews ~30 days before expiry, so under 21 days means renewal has been
# FAILING for days — not merely "due soon". That gap is what stops this from
# crying wolf every month, and makes the alert trustworthy when it does fire.
CERT_URGENT_DAYS=21
DISK_URGENT_PCT=90
DISK_NOTICE_PCT=85
BACKUP_NOTICE_H=48
BACKUP_URGENT_H=168          # 7 days: the nightly job is properly dead, not late
EXPECTED_CONTAINERS="txn_postgres txn_redis txn_api txn_web txn_caddy"

URGENT=()
NOTICES=()
urgent() { echo "  URGENT $*"; URGENT+=("$*"); }
notice() { echo "  notice $*"; NOTICES+=("$*"); }
ok()     { echo "  ok     $*"; }

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') healthcheck"

# --- 1. containers (down = transactions are not being processed) -------------
for c in $EXPECTED_CONTAINERS; do
  running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo "missing")
  if [ "$running" != "true" ]; then
    urgent "container $c is not running ($running)"
    continue
  fi
  # `.State.Health` is absent on containers without a healthcheck (caddy); the
  # template yields "none" there, which is not a failure.
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null)
  case "$health" in
    healthy|none) ok "container $c up ($health)" ;;
    starting)     notice "container $c is still starting" ;;
    *)            urgent "container $c is $health" ;;
  esac
done

# --- 2. TLS certificates (the original worry) --------------------------------
# Read what Caddy actually holds. Checking the public URL with openssl would show
# Cloudflare's cert for the proxied domain instead, which says nothing about
# whether Caddy's own renewal is working.
now=$(date +%s)
certs=$(docker exec "$CADDY" find /data/caddy/certificates -name '*.crt' 2>/dev/null)
if [ -z "$certs" ]; then
  urgent "no TLS certificates found in $CADDY — renewal machinery may be broken"
else
  for crt in $certs; do
    name=$(basename "$crt" .crt)
    end=$(docker exec "$CADDY" cat "$crt" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "$end" ]; then notice "could not read expiry of cert $name"; continue; fi
    # Guard the date parse too: an unparseable enddate would make the command
    # substitution empty and the arithmetic degrade to (-now)/86400 ≈ -20700d,
    # firing a nonsense URGENT instead of the notice this deserves.
    end_s=$(date -d "$end" +%s 2>/dev/null) || end_s=""
    if [ -z "$end_s" ]; then notice "could not parse expiry date '$end' of cert $name"; continue; fi
    days=$(( (end_s - now) / 86400 ))
    if [ "$days" -lt "$CERT_URGENT_DAYS" ]; then
      urgent "TLS cert $name expires in ${days}d — automatic renewal is NOT working"
    else
      ok "TLS cert $name valid ${days}d"
    fi
  done
fi

# --- 3. backup freshness -----------------------------------------------------
newest=$(ls -1t "$BACKUP_DIR"/txn-*.dump 2>/dev/null | head -1)
if [ -z "$newest" ]; then
  urgent "no database backup exists at all in $BACKUP_DIR"
else
  age_h=$(( ( now - $(stat -c %Y "$newest") ) / 3600 ))
  size=$(stat -c %s "$newest")
  if   [ "$age_h" -gt "$BACKUP_URGENT_H" ]; then urgent "newest DB backup is ${age_h}h old — the nightly backup has been dead for over a week"
  elif [ "$age_h" -gt "$BACKUP_NOTICE_H" ]; then notice "newest DB backup is ${age_h}h old — last night's run did not happen"
  elif [ "$size" -lt 100000 ];              then notice "newest DB backup is only ${size} bytes — suspiciously small"
  else ok "DB backup ${age_h}h old ($(numfmt --to=iec "$size"))"
  fi
fi

# --- 4. disk (Postgres stops accepting writes on a full disk) ----------------
pct=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
if   [ "$pct" -ge "$DISK_URGENT_PCT" ]; then urgent "disk ${pct}% full on / — Postgres will stop accepting writes"
elif [ "$pct" -ge "$DISK_NOTICE_PCT" ]; then notice "disk ${pct}% used on / — worth clearing space soon"
else ok "disk ${pct}% used"
fi

# --- 5. public site — the client's-eye view, through Cloudflare --------------
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" 2>/dev/null || echo 000)
case "$code" in
  2*|3*) ok "public site responded $code" ;;
  *)     urgent "public site returned $code — clients cannot reach the dashboard" ;;
esac

# --- 6. brute-force protection ---------------------------------------------
# Password + root SSH login are intentionally enabled here ("never locked out"),
# which is only safe while fail2ban is actually running. If it dies, nothing
# announces it and the box quietly reverts to unprotected. Notice, not urgent:
# it weakens defence rather than breaking anything for clients today.
if systemctl is-active --quiet fail2ban; then
  banned=$(fail2ban-client status sshd 2>/dev/null | awk -F: '/Currently banned/{gsub(/[^0-9]/,"",$2); print $2}')
  ok "fail2ban active (${banned:-0} IP(s) currently banned)"
else
  notice "fail2ban is NOT running — SSH brute-force protection is off"
fi

# --- 7. carry forward the monthly restore drill's verdict --------------------
# The drill never messages Telegram itself; it leaves its result here so it is
# surfaced as a notice rather than as an interruption.
if [ -f /home/deploy/.drill-status ]; then
  read -r drill_state drill_when < /home/deploy/.drill-status || true
  if [ "${drill_state:-}" = "FAIL" ]; then
    notice "last backup restore drill FAILED (${drill_when:-unknown}) — run /home/deploy/verify-backup.sh"
  else
    ok "last restore drill passed (${drill_when:-unknown})"
  fi
fi

# --- report ------------------------------------------------------------------
{
  echo "last healthcheck: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "urgent: ${#URGENT[@]}   notices: ${#NOTICES[@]}"
  [ "${#URGENT[@]}"  -gt 0 ] && printf 'URGENT: %s\n' "${URGENT[@]}"
  [ "${#NOTICES[@]}" -gt 0 ] && printf 'notice: %s\n' "${NOTICES[@]}"
  true
} > "$STATUS_FILE" 2>/dev/null

if [ "${1:-}" = "--test" ]; then
  "$NOTIFY" "$(printf 'TEST — transactions VPS alerting works.\n\nThis is the ONLY kind of message this watchdog sends, and normally only for urgent problems (site down, container down, TLS renewal failing, disk full).\n\nRight now: %d urgent, %d notice(s).' "${#URGENT[@]}" "${#NOTICES[@]}")"
  echo "  (test alert sent)"
  exit 0
fi

if [ "${#URGENT[@]}" -gt 0 ]; then
  body=$(printf -- '- %s\n' "${URGENT[@]}")
  "$NOTIFY" "$(printf 'PRODUCTION ALERT (%d urgent):\n\n%s\nServer: %s\nDetail: journalctl -u txn-healthcheck -n 40' \
    "${#URGENT[@]}" "$body" "$(hostname)")"
  echo "=== ${#URGENT[@]} urgent — Telegram alert sent"
else
  echo "=== no urgent problems — no Telegram sent (${#NOTICES[@]} notice(s) logged)"
fi

# Always exit 0: problems have already been reported through the right channel,
# and the unit's OnFailure= hook is reserved for this script crashing before it
# can report anything. One problem, one alert.
exit 0
