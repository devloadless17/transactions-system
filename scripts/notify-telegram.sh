#!/usr/bin/env bash
# ============================================================================
# Send an ops alert to the Telegram chat the API already uses for load/payout
# notifications. Installed on the VPS at /home/deploy/notify-telegram.sh.
#
#   notify-telegram.sh "message text"
#
# Exists so the backup and healthcheck units share ONE place that knows how to
# reach a human, rather than each re-implementing curl + credential handling.
# Credentials are read from the server-side .env (rendered by the deploy workflow
# from GitHub secrets) and are never echoed.
#
# Always exits 0 — on purpose. This is the alerting path, and a failure to send
# an alert must not itself become a unit failure, which would trigger another
# alert attempt and loop. Failures are written to the journal instead.
# ============================================================================
set -uo pipefail

ENV_FILE=/home/deploy/transactions-system/.env
MSG=${1:?usage: notify-telegram.sh <message>}

TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)

if [ -z "${TOKEN:-}" ] || [ -z "${CHAT:-}" ]; then
  echo "notify: Telegram not configured in $ENV_FILE — message NOT sent: $MSG" >&2
  exit 0
fi

if ! curl -sS --max-time 15 -o /dev/null \
  -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=${MSG}" \
  --data-urlencode "disable_web_page_preview=true"; then
  echo "notify: Telegram send failed (message lost): $MSG" >&2
fi

exit 0
