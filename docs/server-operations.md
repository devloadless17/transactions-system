# Server operations

What runs on the VPS outside the app itself: TLS, backups, and the watchdog.
Everything here is **server-side state** — `git push origin main:production` deploys
the app but does **not** update any of it. After editing a script in `scripts/`,
copy it to the server by hand (command in each script's header).

Server: `187.77.177.127` (`srv1731249`), app user `deploy`, app dir
`/home/deploy/transactions-system`, ops scripts in `/home/deploy`.

---

## TLS — you never renew anything

Let's Encrypt certs last 90 days and **Caddy renews them automatically**, weeks
before expiry, with no cron and no action from you. This is not theory: the
`portal.rivalpayments.com` cert was reissued on 2026-08-03 while Caddy had been
running untouched for seven weeks.

There are two separate certificates and confusing them wastes hours:

|                                                | Who issues it                      | Who renews it        | How to see it                                            |
| ---------------------------------------------- | ---------------------------------- | -------------------- | -------------------------------------------------------- |
| What clients see on `portal.rivalpayments.com` | **Cloudflare** (domain is proxied) | Cloudflare, forever  | browser padlock, or `curl -I` shows `server: cloudflare` |
| Caddy → origin leg, and all of staging         | Let's Encrypt via Caddy            | Caddy, automatically | inside the container (below)                             |

```bash
# What Caddy actually holds and when it expires:
docker exec txn_caddy find /data/caddy/certificates -name '*.crt'
docker exec txn_caddy cat <path-from-above> | openssl x509 -noout -subject -dates

# When Caddy has SCHEDULED the next renewal (ACME ARI), not just when it expires:
docker logs txn_caddy 2>&1 | grep "renewal information" | tail -2
date -u -d @<selected_time-from-the-log>
```

Running `openssl s_client` against the prod domain from outside shows you
**Cloudflare's** cert and tells you nothing about Caddy's. Use the commands above.

Renewal only breaks if one of four things breaks: DNS stops pointing here, ports
80/443 stop being reachable, Caddy stops running, or the `caddy_data` volume is
destroyed. The watchdog checks the outcome of all four daily.

---

## Backups

|           |                                                           |
| --------- | --------------------------------------------------------- |
| Script    | `scripts/backup-db.sh` → `/home/deploy/backup-db.sh`      |
| Schedule  | every day **00:00 Asia/Beirut** (`txn-db-backup.timer`)   |
| Output    | `/home/deploy/backups/txn-<date>.dump` (~4 MB)            |
| Retention | **1** — replaced daily (`KEEP=` at the top of the script) |
| Log       | `/home/deploy/backups/backup.log`                         |

The new dump is written to a `.partial`, verified with `pg_restore -l`, size-checked,
and only _then_ replaces the old one. A failed dump can never destroy the last good
backup. **Preserve that ordering in any edit.**

```bash
systemctl list-timers txn-db-backup.timer     # when it next runs / last ran
systemctl start txn-db-backup.service         # take a backup right now
tail /home/deploy/backups/backup.log          # what it did
```

### Monthly restore drill

`txn-verify-backup.timer` runs on the 1st at 01:00 Beirut. It restores the latest
dump into a **throwaway** postgres container with `--network none` (so it cannot
reach any live database), asserts the data is there, asserts the double-entry ledger
still balances to exactly zero, then destroys the container. It never touches
`txn_postgres` or `txn_postgres_staging`.

Last verdict: `cat /home/deploy/.drill-status`. A failure is surfaced by the daily
watchdog as a notice — it does not page you.

### Restoring for real

Destructive. Never run against a healthy prod DB.

```bash
docker cp /home/deploy/backups/txn-<date>.dump txn_postgres:/tmp/r.dump
docker exec txn_postgres pg_restore -U <POSTGRES_USER> -d <POSTGRES_DB> \
  --clean --if-exists /tmp/r.dump
```

To inspect a dump without restoring: `pg_restore -l /tmp/r.dump`.

---

## Watchdog

`txn-healthcheck.timer` runs daily at 08:00 Beirut and checks: every prod container
is up and healthy, both TLS certs have >21 days left, a backup exists and is fresh,
disk is under 85/90%, and the public site answers over HTTPS.

**It is silent unless something is wrong.** Two tiers, deliberately:

- **Urgent → Telegram.** Only things affecting clients now or within days: site
  down, a prod container down, TLS renewal actually failing, disk about to stop
  Postgres writing, or backups dead for over a week. Telegram is the same chat that
  carries real load/payout requests, so nothing else may go there — an ops channel
  people learn to ignore protects nobody.
- **Notice → log only.** Never Telegram.

```bash
cat /home/deploy/ops-status.txt                 # last result, any time
journalctl -u txn-healthcheck -n 40             # full detail
/home/deploy/healthcheck.sh --test              # sends ONE Telegram, to prove it works
```

The 21-day cert threshold is chosen deliberately: renewal happens ~30 days out, so
under 21 days means renewal has genuinely been failing for days rather than merely
being due. That gap is what makes the alert worth trusting.

---

## SSH & brute force

Password login and direct root login are **intentionally on** — the "never locked out"
rule, with a long random root password and the hPanel browser console as fallbacks. That
choice is only safe with brute-force protection in front of it, so **fail2ban** guards
sshd: 5 failures in 10 minutes earns a 1-hour ban, on ports 22 and 2222.

Config lives in `/etc/fail2ban/jail.local` — never `jail.conf`, which package upgrades
overwrite. It sets `backend = systemd` because this host's SSH unit is `ssh.service` and
fail2ban's default log path does not apply.

```bash
fail2ban-client status sshd                    # who is banned right now
fail2ban-client set sshd unbanip <ip>          # if it ever catches you
```

If it does catch you, do not keep retrying — that extends the ban. Use the hPanel
console, which bypasses SSH entirely.

---

## Deploying

`main` is the integration branch; **only `production` deploys**.

```bash
git push origin main            # CI only, never touches the server
git push origin main:production # the actual release
```

Before releasing, two checks worth thirty seconds:

```bash
git merge-base --is-ancestor origin/production origin/main && echo "fast-forward, safe"
git diff --name-only origin/production..origin/main | grep -i migration || echo "no migrations"
```

A deploy with no migrations is code-only: images swap, Caddy rides out the gap with
`lb_try_duration`, and the health gate rolls you back if the new release is unhealthy
(`./rollback.sh` on the server). A deploy _with_ migrations changes the database and
deserves the low-traffic window.
