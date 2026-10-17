# Production Deployment

Push to `production` → GitHub Actions builds both Docker images, pushes them to
Docker Hub, ships the compose stack to your server, runs DB migrations, and brings
the app up behind Caddy with automatic HTTPS.

> `production` is the **only** branch that deploys the live site. `main` is the
> integration branch: pushing to it runs CI (typecheck, lint, tests) and never
> touches the server. Release with `git push origin main:production`.

**You only need to (1) prepare the server once and (2) set the GitHub secrets.**

```
Browser ──HTTPS──► Caddy (:80/:443, auto TLS)
                     ├─ /v1/*, /socket.io/*  → API  (NestJS, :3001)
                     └─ everything else       → Web  (Next.js, :3000)
                         API ──► Postgres (:5432, internal)  +  Redis (:6379, internal)
```

Single domain, path-based: the web app and the API share one domain
(`https://DOMAIN`, API under `https://DOMAIN/v1`), so there are no cross-origin
cookie/CORS concerns and you need only **one** DNS record.

---

## 1. One-time server prep

A Linux server (Ubuntu recommended) with a public IP and SSH **key** access (a
non-root sudo user such as `deploy` is fine).

1. **Install Docker** (includes the compose plugin):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. **DNS** — add an `A` record pointing your domain at the server IP:
   ```
   app.example.com.  A  <SERVER_IP>
   ```
   Use the apex or a subdomain — whatever you put in the `DOMAIN` secret.
3. **Firewall** — allow inbound **80** and **443** (Caddy needs 80 for the
   Let's Encrypt HTTP challenge + the HTTP→HTTPS redirect, 443 for traffic).

That's all. Caddy obtains and renews the TLS certificate automatically.

---

## 2. GitHub secrets

`Repo → Settings → Secrets and variables → Actions → New repository secret`.

### Required

| Secret                  | What it is / how to generate                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `DOCKER_USERNAME`       | Your Docker Hub username.                                                      |
| `DOCKER_SECRET`         | Docker Hub access token (Account → Security → New Access Token, R/W).          |
| `VPS_HOST`              | Server public IP or hostname.                                                  |
| `VPS_USER`              | SSH login user (e.g. `deploy`).                                                |
| `VPS_SSH_KEY_B64`       | Base64 OpenSSH private key: `base64 -w0 ~/.ssh/id_ed25519`. (Opt: `VPS_PORT`.) |
| `DOMAIN`                | Your domain, e.g. `app.example.com` — **no** `https://`, **no** path.          |
| `POSTGRES_PASSWORD`     | DB superuser password. **Alphanumeric only:** `openssl rand -hex 24`.          |
| `POSTGRES_PASSWORD_RLS` | DB runtime-role password. **Alphanumeric only:** `openssl rand -hex 24`.       |
| `JWT_ACCESS_SECRET`     | `openssl rand -base64 36`                                                      |
| `JWT_REFRESH_SECRET`    | `openssl rand -base64 36` (must differ from the others)                        |
| `CSRF_SECRET`           | `openssl rand -base64 36` (must differ from the JWT secrets)                   |
| `METRICS_TOKEN`         | `openssl rand -base64 24`                                                      |
| `SEED_ADMIN_EMAIL`      | Initial super-admin email (your login).                                        |
| `SEED_ADMIN_PASSWORD`   | Initial super-admin password (you'll be forced to change it on 1st login).     |

### Optional — Whish Pay

Leave unset if you're not using Whish (the API boots fine with it "off").

| Secret          | What it is                          |
| --------------- | ----------------------------------- |
| `WHISH_CHANNEL` | Whish channel id (issued by Whish). |
| `WHISH_SECRET`  | Whish secret (issued by Whish).     |

When set, the deploy uses the Whish **production** base URL and your domain as
the callback/website URL automatically (`https://DOMAIN/v1`, `https://DOMAIN`).
Make sure that domain is the one registered with Whish.

> **Secret formatting:** the two `POSTGRES_*` passwords go inside DB connection
> strings, so they must be URL-safe (the `openssl rand -hex` above is). All
> secrets are injected with `sed`, so avoid the characters `|`, `&`, and `\` in
> any secret value (the `openssl` commands above never produce them).

---

## 3. First deploy

1. Set every required secret (step 2).
2. `Actions → CI & Deploy to Production → Run workflow`, **select the `production`
   branch**, set **seed_database = `true`**, and run it. This applies migrations,
   creates the runtime DB role, and seeds your super admin.
   (Running it from `main` only executes the checks — it will never deploy.)
3. When it finishes, open `https://DOMAIN` and log in with `SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD`. You'll be prompted to set a new password.

After that, **every push to the `production` branch auto-deploys** (migrations run
each time; seeding stays off). Pushing to `main` runs CI only and never touches the
server — to release, promote `main` to `production`:

```bash
git push origin main:production
```

---

## How it works (for maintainers)

- **Images:** `apps/api/Dockerfile` and `apps/web/Dockerfile`, built and pushed
  as `<DOCKER_USERNAME>/transactions-api` and `…/transactions-web`, tagged
  `:latest` and `:<commit-sha>`.
- **Browser API URL is baked at build time** — `NEXT_PUBLIC_API_BASE_URL` is
  inlined into the web bundle, so the workflow passes `https://DOMAIN/v1` as a
  build-arg. Changing the domain requires a rebuild (a normal push does this).
- **Migrations + RLS role:** the `migrate` one-shot service (reuses the API
  image) runs `packages/db/deploy.sh`: `prisma migrate deploy`, then rotates the
  `txn_app_rls` role's password (migration `0003` creates it with a committed dev
  password; production refuses to boot with that), then seeds if requested. The
  API then connects as that non-superuser role so Postgres RLS is enforced.
- **TLS:** Caddy (`Caddyfile`) terminates HTTPS and reverse-proxies by path.
- **Zero-downtime, zero-loss deploys (blue/green).** The API runs as two
  containers, `api-blue` and `api-green`; normally one of them runs. Caddy lists
  both and sends every request to the first **healthy** one (`lb_policy first`,
  health-checked every second). A release (`scripts/deploy/release.sh`, shipped
  to the server as `release.sh`) never stops the live API first:

  1. The new version starts in the other colour, **beside** the live one.
  2. It must answer its health check, and Caddy's own health check must have
     passed on it: Caddy marks its checks (`health_headers`), and the API
     reports, to a caller inside its container, when one last passed
     (`proxyCheckedMsAgo`). A release that never gets there is stopped and the
     live API carries on — the deploy fails red and nothing changed.
  3. The old colour drains: its health check answers 503 to Caddy (and to the
     checks inside the container), Caddy moves to the new one within a second,
     it finishes everything in flight (websockets are closed and reconnect),
     its background runs stop **between** items, then it exits. A healthy
     colour is up at every moment, so no request waits. An outside uptime
     monitor's `/v1/health` (it carries `X-Forwarded-For`, set by Caddy) still
     gets 200 in that second: the API is up, so a release never shows as an
     outage.
  4. The new colour is watched for a few seconds; if it falls over, the previous
     one (stopped, not removed) is started again.
  5. The web is swapped; Caddy holds its requests for the second it restarts.

  **Background work never runs in two versions at once.** Withdrawal
  auto-approval (real Whish transfers), every Whish W2W send (one shared session
  counter) and the Whish payment poller take a **database lease** first
  (`job_leases`, `apps/api/src/database/job-lease.service.ts`): one holder at a
  time, judged by the database clock, renewed while it works, re-confirmed
  before each withdrawal, released when done, and a crashed holder's runs out
  in 60s. CRM delivery already takes a Redis lock; the ledger reconciliation and
  maintenance are safe to run twice.

  The release script picks one of three modes from the image label
  `com.rivalpayments.blue-green` (an API that takes leases):

  | Mode           | When                                                               | How                                                                                                                                                                                                                        |
  | -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `overlap`      | both releases carry it (normal)                                    | as above                                                                                                                                                                                                                   |
  | `overlap-held` | only the new one (the switch-over from the single `api` container) | the script holds the leases, so only the old API runs background work; traffic and the web move to the new one, the old one is stopped between two Whish transfers with nothing calling it, then the leases are given back |
  | `sequential`   | the new one does not (a rollback to an older tag)                  | never side by side: the old one drains first, Caddy holds requests until the new one is healthy (a few seconds)                                                                                                            |

  Four things make it hold under real conditions, each found in a rehearsal or
  a load test:

  - Internal health checks are never rate limited (`skipThrottle`). Caddy checks
    each upstream name every second from one IP; over the per-IP limit a 429
    made Caddy think the API was down and hold every request ~16s a minute.
  - A conflicting money transaction is retried 8 times (over 1.2s). At a switch
    both versions write for ~200ms, and 5 attempts sometimes ran out.
  - A release that crashes on start is caught in seconds (its restart count),
    not after the 3-minute health wait.
  - A busy database pool is not a down API. The health check's `SELECT 1`
    queues for a connection like any query, so in a burst it waited behind the
    work (4.7s measured), past Caddy's 3s timeout: Caddy took the only API out
    of rotation mid-burst. It now waits at most 1.5s and answers 200
    `"db":"busy"` while the database answered within the last 30s; a database
    error, 30s without an answer, or a new release that never reached its
    database is still a 503.

  **Rehearsed locally** with the real compose file, release script, images and
  Caddy (2.11.7), under continuous load from 12 deposit streams, Whish
  withdrawals auto-approved (SIMULATE) and API reads:

  - normal releases (`overlap`): **0 failures, no request waited over 1s**
    (slowest 0.58s, the load's own p99 ~0.35s);
  - the switch-over and rollbacks (`overlap-held` / `sequential`): 0 failures;
  - a release that won't start, one Caddy can't reach, two at once, a release
    script killed half-way: the live API kept serving, 0 failures;
  - every deposit booked exactly once (60,000+), every withdrawal approved
    exactly once, wallets equal to the ledger at rest.

  What it cannot do: a **hard crash** (process killed, not a deploy) loses the
  requests that process was handling at that instant (502). Nothing of theirs is
  booked, and sources resend safely by their own reference. Requests still
  running after 40s at a shutdown are cut.

  Never run a bare `docker compose up -d` on the server (it starts **both**
  colours — harmless, the leases hold, but untidy) or `--remove-orphans`. A
  deploy never pulls or recreates Postgres, Redis or Caddy: every Compose `up`
  and `run` it makes passes `--no-deps` (a plain `run migrate` recreated
  Postgres once — see docs/server-operations.md), pinned by
  `apps/api/src/contract/deploy-safety.spec.ts`.

- **Config:** `.env.prod.example` is the template; the workflow renders it to
  `/home/deploy/transactions-system/.env` on the server from the secrets above
  (`DEPLOY_DIR` in the deploy workflow).

### Manual ops on the server

```bash
cd /home/deploy/transactions-system
./release.sh prod status          # which colour serves, its image, whether Caddy sees it
docker compose -f docker-compose.prod.yml ps
docker logs -f txn_api_blue       # or txn_api_green — whichever `status` says serves
# re-run migrations only (-T so it doesn't eat piped stdin in scripts):
docker compose -f docker-compose.prod.yml run --rm -T migrate
# re-release the current tag (e.g. after an interrupted deploy):
./release.sh prod
```

### Rollback

Each deploy pins `IMAGE_TAG` to its commit SHA and records the running release in
`.deploy_current` / the prior one in `.deploy_previous`. To revert, run the
shipped helper on the server:

```bash
cd ~/transactions-system
./rollback.sh             # back to the last-known-good release
./rollback.sh <git-sha>   # or a specific commit's image
```

A rollback is an ordinary release of the older tag (`./release.sh prod <tag>`):
the current API keeps serving until the older one is healthy, so it is as
zero-downtime as a deploy (a tag from before job leases runs `sequential`: a
few seconds of held requests, none lost). Postgres/Redis/Caddy and their data
volumes are never touched, and `.env` is pinned to the rolled-back tag so it
sticks.
Migrations are forward-only — `rollback.sh` reverts code, not schema; if a bad
release ran a destructive migration, restore the DB from a backup.

> Each deploy keeps the current + previous images on the server (older ones are
> pruned), and never recreates the database container — the new image ref only
> changes api/web, so the `postgres_data` volume is preserved untouched.

### Release notes — migrations that limit a rollback

Read the entry for every release you are about to roll back across. Newest first.

#### Blue/green API + job leases — `20261013160000_job_leases`

- **Additive only:** a new table, `job_leases`; nothing existing is touched or
  locked, and the previous release ignores it. A rollback to an older tag needs
  nothing special — the release script runs such a tag `sequential` (never
  beside another version).
- **The first production deploy that ships this** replaces the single `txn_api`
  container (a release that can neither drain nor take leases, with
  auto-approval ON and real W2W transfers). It runs `overlap-held`: the new API
  starts beside it while the script holds the leases (so only the old one runs
  auto-approval), traffic and the web move to the new one, and the old one is
  stopped only between two Whish transfers, with nothing left calling it. No
  request reaches an API that is shutting down, and no transfer is cut.
- **Before that deploy, on the server:** install the updated watchdog
  (`scripts/healthcheck.sh` → `/home/deploy/healthcheck.sh`; it accepts
  `txn_api` and the colours). Otherwise its next run pages "txn_api missing".
- The Caddyfile (both colours, `lb_policy first`, health-check marker) is loaded
  **by the release itself**, once the new colour runs, and only when the file
  changed (`.caddyfile-loaded.sha256`). Never before: on this server Docker's DNS
  takes ~10s to give up on a name that doesn't exist, and Caddy treats a newly
  listed upstream as healthy until its first check — a reload naming a colour
  that isn't running made requests wait seconds. Staging (Caddy is shared and
  only prod ships its config) gets its blue/green block from a one-off manual
  reload that changes **only** the staging block; prod's routing is untouched
  until its own deploy.
- Container names change: `txn_api` → `txn_api_blue` / `txn_api_green`
  (staging: `txn_api_staging_blue` / `_green`). Use `./release.sh prod status`.

#### Zero-loss deploys (no migration)

- **No database change**, so a rollback needs nothing special. An image without
  the `graceful-drain` label is stopped with the old 10s timeout.
- Superseded for the switch-over by the blue/green entry above (it ships in the
  same production deploy): the old API is no longer stopped while it still
  receives requests.

#### Whish refunds — `20261013140000_whish_refund`

- **One additive migration:** `REFUNDED` is added to `WhishPaymentStatus` and
  `WHISH_REFUND` to `TransactionLogKind`, with two nullable columns on
  `whish_payments` (`refund_requested_at`, `refunded_at`). The terminal-status
  guard from `0018` (`reject_terminal_status_change()`) now also covers
  `whish_payments` through a new `whish_payments_status_guard` trigger, so a
  `REFUNDED` payment can never change status again. The guard's rules for
  transactions, withdrawals, payouts and loads are unchanged. Catalog-only: no
  backfill, no index.
- **Nothing is refunded by deploying it.** A refund happens only when a
  `SUPER_ADMIN` presses Refund on a PAID payment (companies cannot refund; they ask
  the platform). Whish then
  sends the full amount back to the payer from the platform's Whish account — real
  money — and the deposit is reversed like the admin Reverse.
- **ROLLBACK RULE.** Rolling the API image back past this release is safe **only
  while no Whish payment is `REFUNDED`**: the previous image cannot read that status
  value. After the first refund, roll forward only. Check first (read-only):

  ```bash
  cd /home/deploy/transactions-system
  docker compose -f docker-compose.prod.yml exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' <<'SQL'
  SELECT count(*) FROM whish_payments WHERE status = 'REFUNDED';
  SQL
  ```

#### Deposits at volume — `20261013120000_whish_payment_poll_schedule`

- **One additive migration:** `whish_payments.next_poll_at` (nullable, no
  default — catalog-only) and a partial index over `PENDING` links only (a
  handful of rows, so the plain `CREATE INDEX` is a blink; the `CONCURRENTLY`
  command for a large table is in the migration file). The previous API image
  never reads the column, so it keeps serving while this runs.
- **Rollback is safe at any time.** The previous image ignores `next_poll_at`
  and goes back to polling the oldest pending Whish links first — the old
  behaviour, including its starvation of newer links once hundreds of links
  Whish never resolves pile up. No data needs repair either way.
- **Renamed limit — check the server env files.** The per-key brake on creating
  and refreshing Whish payment links is now `INTEGRATION_CREATE_RATE_LIMIT_MAX`
  (default 60000 a minute since 2026-10-14, was 6000; status lookups have their
  own `INTEGRATION_LOOKUP_RATE_LIMIT_MAX`, default 300000, was 30000). The old
  `INTEGRATION_RATE_LIMIT_MAX` is **no longer read**. Staging's hand-kept
  `.env.staging` still carries `INTEGRATION_RATE_LIMIT_MAX=300` (the old combined
  cap, copied from the old example) and that line is now inert — remove it at
  leisure. Production's `.env` is re-rendered from `.env.prod.example` on every
  production deploy, so it picks up the new names by itself. To change a brake,
  set the new names. **Raised 2026-10-14 (6000 → 60000, 30000 → 300000), so the
  brakes sit above what the platform itself serves.** Staging's `.env.staging`
  does not set these two names (checked), so it takes the compose default;
  production's `.env` is re-rendered from `.env.prod.example`, which carries the
  new values. A value set in a server env file overrides both.
- **Behaviour changes, no configuration needed:**
  - `/v1/integrations/whish/*` has no per-IP limit any more (per-key brakes
    only); Whish's payment confirmations are never limited — only fake ones
    (unknown link or wrong token), 60 a minute per sender IP.
  - On its dashboard twin, `/v1/company/whish/payments`, a link's own calls
    (create, look up, refresh-status) carry the same per-key brakes — per user
    on a dashboard session — instead of the per-IP cap; its list and CSV keep
    the per-IP cap. Rolling back restores the per-IP cap on all of them.
  - Failed company API keys count against the per-(IP, key prefix) limiter,
    as source keys already did.
  - One company's money transactions take turns inside the API process
    (`CompanyQueue`) instead of racing for the wallet row, so a burst for one
    company is booked in full, in order.
  - A key that verified once is remembered by the process (revocation and
    expiry are still checked live on every request), and `last_used_at` is
    stamped at most once a minute per key.
  - The Whish reconciliation poller follows `next_poll_at`, earliest-due first,
    up to 16 Whish calls at a time (about 3,200 links a minute). A link is
    scheduled at birth for one check 5:10 after it was created (Whish closes an
    unpaid link at 5:00, and reports a payment itself), then every minute, and
    is closed at 10 minutes if Whish still reports it unpaid — one Whish call
    for an unpaid link, none for a paid one. The poller wakes at the moment the
    next link is due (measured: 0.2s after it), with a pass every minute as the
    safety net; a full batch of 250 is followed by the next at once, unless
    Whish answers HTTP 429: then the poller stops and only the next
    every-minute pass asks again (Whish documents no rate limit, and link
    creation uses the same account). Its query
    takes the head of the schedule off the PENDING-only index, so its cost does
    not grow with the number of open links (measured with 500,000 payable
    links: 250 rows, 0.3 ms; the previous form read all 500,000, 135 ms).

#### Network fee — `20261008120000_network_fee_ledger_account` … `20261008120700_network_fee_ledger_index`

- **Eight small additive migrations**, applied in this order:

  | Migration                                   | What it does                                                                                             |
  | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | `20261008120000_network_fee_ledger_account` | Adds the `NETWORK_FEE` value to the `LedgerAccountType` enum.                                            |
  | `20261008120100_network_fees`               | Creates `company_network_fees` (RLS: a tenant may read its own rows, only admin/bypass may write).       |
  | `20261008120200_network_fee_withdrawals`    | `withdrawals.network_fee_amount`                                                                         |
  | `20261008120300_network_fee_payouts`        | `payouts.network_fee_amount`                                                                             |
  | `20261008120400_network_fee_loads`          | `loads.network_fee_amount`                                                                               |
  | `20261008120500_network_fee_company_switch` | `companies.network_fee_enabled BOOLEAN NOT NULL DEFAULT false`                                           |
  | `20261008120600_network_fee_transactions`   | `transactions.network_fee_amount` (the ingest hot path, last)                                            |
  | `20261008120700_network_fee_ledger_index`   | Partial index for the network-fee revenue sums (`WHERE account_type = 'NETWORK_FEE'`; empty at release). |

  Each `network_fee_amount` is `DECIMAL(20,2) NOT NULL DEFAULT 0` with a
  `NOT VALID` non-negative `CHECK`.

- **One live table per file — on purpose.** Prisma applies a migration file as a
  single transaction, and an `ALTER TABLE` holds its `ACCESS EXCLUSIVE` lock until
  that transaction commits, while the previous API image is still serving. A file
  that alters several live tables can **deadlock** against a money write that
  touches them in the opposite order (an ingest holds `transactions`/`companies`
  and then, through the ledger's foreign keys, needs `withdrawals`/`payouts`/
  `loads`); Postgres would abort the migration and the deploy would fail. A file
  that locks one table can only wait, never deadlock. The rule is enforced for
  every future migration by `migration-lock-safety.spec.ts`. (The enum value has
  its own file for a different reason: Postgres cannot use an enum value inside
  the transaction that added it.)
- **Catalog-only, no backfill.** Every new column has a constant default
  (metadata-only, no table rewrite) and the `CHECK`s skip the scan. Existing rows
  read as `0` / `false` — exactly the old behaviour — so the previous API image
  keeps serving while they run. The one index is partial on the `NETWORK_FEE`
  account, which has no rows yet; on an already-large ledger build it
  `CONCURRENTLY` out-of-band first (the command is in the migration file), and
  the in-migration `IF NOT EXISTS` then no-ops.
- **If one of them fails** (most likely `lock_timeout`: it could not get its lock
  within 5 s behind a long-running statement), nothing is half-applied — the file
  is one transaction — and the files before it stay applied. Prisma records the
  failure, and the next deploy stops with `P3009` until it is cleared:

  ```bash
  cd /home/deploy/transactions-system
  docker compose -f docker-compose.prod.yml run --rm -T migrate \
    sh -c 'cd /repo/packages/db && DATABASE_URL="$DATABASE_MIGRATIONS_URL" pnpm exec prisma migrate resolve --rolled-back <migration_name>' </dev/null
  ```

  then re-run the deploy; it continues from that file. The API is untouched
  meanwhile: the deploy stops before swapping containers, and the old image is
  compatible with any prefix of these migrations.

- **Staging and development databases** applied an earlier revision in which
  `20261008120100_network_fees` held every statement. There the follow-up files
  are written to change nothing (`IF NOT EXISTS`), and `migrate deploy` /
  `migrate status` are unaffected (verified). Only `prisma migrate dev` on such a
  development database notices the edited file; align its checksum instead of
  resetting:

  ```bash
  # development databases only — never needed on production, which runs the files as they are
  psql "$DATABASE_MIGRATIONS_URL" -c "UPDATE _prisma_migrations SET checksum = '$(sha256sum \
    packages/db/prisma/migrations/20261008120100_network_fees/migration.sql | cut -d' ' -f1)' \
    WHERE migration_name = '20261008120100_network_fees'"
  ```

- **Ships OFF.** No company is charged a network fee until a `SUPER_ADMIN` turns
  it on for that company (`PUT /v1/admin/companies/:id/network-fee`). With the
  switch off, every flow books exactly as before.
- **ROLLBACK RULE.** Rolling the API image back past this release is safe **only
  while no company has the network fee enabled**. Once any company has
  `NETWORK_FEE` ledger rows (or a pending request carrying a network fee), roll
  **forward only**: the previous image does not know the `NETWORK_FEE` enum value
  and ignores `network_fee_amount`, so it would fail to read those ledger rows and
  mis-book an approval or reversal of a row that carries one. The emergency lever
  is the per-company switch — turning the network fee off stops it on every new
  operation, while rows already booked or pending keep the fees frozen on them.

  Before any rollback across this release, confirm every count is `0`
  (read-only):

  ```bash
  cd /home/deploy/transactions-system
  docker compose -f docker-compose.prod.yml exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' <<'SQL'
  SELECT count(*) FROM companies WHERE network_fee_enabled;
  SELECT (SELECT count(*) FROM transactions WHERE network_fee_amount > 0)
       + (SELECT count(*) FROM withdrawals  WHERE network_fee_amount > 0)
       + (SELECT count(*) FROM payouts      WHERE network_fee_amount > 0)
       + (SELECT count(*) FROM loads        WHERE network_fee_amount > 0);
  SQL
  ```

## Scaling & operational notes (from the production-readiness audit)

The single-instance default is solid. Before scaling to **multiple API instances**
or to **very large tables**, action these (none are code bugs — they're topology
decisions):

- **Search is index-backed at any size — keep it that way.** Every money list's
  search (`apps/api/src/common/search.ts`) matches through four SQL functions
  (`deposit_search_text/_phones`, `flow_search_text/_phones`) that trigram GIN
  indexes cover on each table (migrations `20261014150000`–`150400`). Measured at
  27x production (525k deposits, 101k withdrawals) through the app's RLS role: a
  search by phone, name or reference answers in 10–40ms (it was 0.5–7s). Three
  things keep it that way:

  - the queries call those functions with exactly the indexed arguments
    (`search.spec.ts` checks the migrations against the code);
  - the functions — and LIKE/ILIKE — are LEAKPROOF and pin `search_path` (no
    inlining), or row-level security pushes the search behind the policy and
    every search walks the table again. `deploy.sh` re-asserts LIKE/ILIKE after
    every migrate (a restore drops their flag: see server-operations.md);
  - the indexes are SQL-only (an expression index can't be declared in
    schema.prisma), so a generated `prisma migrate dev` diff would DROP them —
    `sql-only-indexes.spec.ts` fails any migration that does. Delete those
    DROP lines from a generated migration before committing it.
    Each deposit insert pays ~0.15ms for the two indexes (`fastupdate = off`: no
    pending list for some later insert to flush).

- **Realtime is cross-replica via the Redis adapter (wired automatically).**
  Socket.IO attaches the Redis adapter (`@socket.io/redis-adapter`) whenever
  `REDIS_URL` is set — see `CorsIoAdapter` in
  [apps/api/src/main.ts](../apps/api/src/main.ts) — so an event emitted on instance
  A reaches clients connected to instance B across any number of replicas. **No
  sticky sessions are required, because the web client uses a WebSocket-only
  transport** (`transports: ['websocket']` in
  [apps/web/src/lib/realtime.tsx](../apps/web/src/lib/realtime.tsx)): there is no
  HTTP long-polling handshake whose in-memory engine.io session would be pinned to
  one instance and break under a round-robin LB. (The Redis adapter handles event
  fan-out; the WebSocket-only client handles connection affinity — the two are
  separate concerns.) It reuses the Redis you already run for
  cache/rate-limit. If Redis is unreachable the socket server falls back to the
  in-memory adapter (a startup warning is logged): the API keeps serving and the
  UI stays correct after a manual reload, but cross-instance live updates are
  dropped until Redis recovers — so monitor that warning when running >1 replica.
- **The reverse proxy MUST forward WebSocket upgrades with a long idle timeout.**
  The realtime socket is a long-lived connection. If the proxy (Caddy/nginx)
  doesn't pass the `Upgrade`/`Connection` headers, or closes idle connections
  after a short window, the client is dropped and reconnects repeatedly — and
  every reconnect triggers a full catch-up refetch of the open dashboard, which
  looks like the page "refreshing itself" every minute or two. Caddy's
  `reverse_proxy` forwards WebSockets by default; just keep its read/idle timeout
  generous (or unset) for the API upstream so a healthy socket stays open for the
  whole session (it only legitimately reconnects ~every 13 min on token refresh).
- **The DB connection pool per instance.** The compose files set
  `connection_limit=${DATABASE_POOL_SIZE:-20}` on `DATABASE_URL` (since
  2026-10-14). Without it Prisma takes `num_cpus*2+1` — 5 on the 2-core
  production server — and a burst of link creations queued past Prisma's 2s
  connection wait: in a local load test with 5 connections, 6% of 10,000 link
  creations were refused and CRM events were lost. Size it so
  `N_instances * connection_limit < max_connections` (100), leaving headroom for
  migrations/admin; during a blue/green release two instances run.
- **One company's bookings take turns per API process.** `CompanyQueue`
  ([apps/api/src/database/company-queue.ts](../apps/api/src/database/company-queue.ts))
  queues a company's money transactions inside one process — that is what lets
  a burst of one company's deposits book in full (measured locally: 1,000 at
  once, ~100 a second, all booked). With several API replicas each queues only
  its own share, and the replicas race for the company's wallet row again:
  SERIALIZABLE + retry keeps every booking correct, but a big same-company burst
  split across replicas can run out of retries (`WRITE_CONFLICT`). Before adding
  replicas, add a cross-instance turn as well (e.g. a
  `pg_advisory_xact_lock` on the company, taken first in the transaction).
- **Build big-table indexes `CONCURRENTLY` out-of-band.** Index-adding migrations
  (`20260619120000_transactions_list_indexes`, `20260622180000_activity_*`) use a
  plain `CREATE INDEX`, which takes a brief write lock. On an already-large
  `transactions` table, create those indexes `CONCURRENTLY` by hand first (the
  `IF NOT EXISTS` in the migration then no-ops on deploy) to avoid blocking writes.
- **The `source_fee_amount` backfill is one-time but O(rows).** The
  `20260622210000_transaction_source_fee` migration backfills every existing
  COMPLETED deposit inline, and `20260622230000_recompute_source_fee_backfill`
  re-runs it once schedules exist. Both run inside `migrate deploy`, which is fine
  on a fresh or small database. On an **already-multi-million-row** `transactions`
  table those inline `UPDATE`s take a long lock and can wedge the deploy — in that
  case run `migrate deploy` during a maintenance window, **or** prefer the batched,
  resumable, lock-free out-of-band script:
  `pnpm --filter @app/db exec tsx scripts/backfill-source-fee.ts` (keyset-paginated
  in `BACKFILL_BATCH_SIZE` chunks; idempotent — only touches rows still at the 0
  default; rounds ROUND_HALF_EVEN to match app-computed rows). Going forward this
  is automatic: editing a source's schedule recomputes that source's deposits in
  `SourcesService.setFeeRules`. Then analytics just SUM the column — free forever.
  **Do not edit those applied migration SQL files to "fix" the lock** — that breaks
  Prisma's checksum; use the script instead.
- **Background tickers assume a single runner.** Reconciliation, maintenance, and
  Whish reconciliation tickers have no cross-instance lock. The work is idempotent
  (no double-settlement), so multiple instances are _safe_ but do _redundant_ work;
  with >1 replica, gate them behind a Postgres advisory lock or run them on one
  designated instance.
