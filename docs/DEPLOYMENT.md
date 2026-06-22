# Production Deployment

Push to `main` → GitHub Actions builds both Docker images, pushes them to Docker
Hub, ships the compose stack to your server, runs DB migrations, and brings the
app up behind Caddy with automatic HTTPS.

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
2. `Actions → Deploy to Production → Run workflow`, set **seed_database = `true`**,
   and run it. This applies migrations, creates the runtime DB role, and seeds
   your super admin.
3. When it finishes, open `https://DOMAIN` and log in with `SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_PASSWORD`. You'll be prompted to set a new password.

After that, **every push to `main` auto-deploys** (migrations run each time;
seeding stays off).

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
- **Config:** `.env.prod.example` is the template; the workflow renders it to
  `/root/transactions-system/.env` on the server from the secrets above.

### Manual ops on the server

```bash
cd /root/transactions-system
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
# re-run migrations only (-T so it doesn't eat piped stdin in scripts):
docker compose -f docker-compose.prod.yml run --rm -T migrate
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

It recreates **only** api + web (`--no-deps`), so Postgres/Redis and their data
volumes are never touched, and pins `.env` to the rolled-back tag so it sticks.
Migrations are forward-only — `rollback.sh` reverts code, not schema; if a bad
release ran a destructive migration, restore the DB from a backup.

> Each deploy keeps the current + previous images on the server (older ones are
> pruned), and never recreates the database container — the new image ref only
> changes api/web, so the `postgres_data` volume is preserved untouched.

## Scaling & operational notes (from the production-readiness audit)

The single-instance default is solid. Before scaling to **multiple API instances**
or to **very large tables**, action these (none are code bugs — they're topology
decisions):

- **Realtime is cross-replica via the Redis adapter (wired automatically).**
  Socket.IO attaches the Redis adapter (`@socket.io/redis-adapter`) whenever
  `REDIS_URL` is set — see `CorsIoAdapter` in
  [apps/api/src/main.ts](../apps/api/src/main.ts) — so an event emitted on instance
  A reaches clients connected to instance B across any number of replicas, no
  sticky sessions required. It reuses the Redis you already run for
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
- **Set the DB connection pool per instance.** `DATABASE_URL` has no
  `connection_limit`, so Prisma defaults to `num_cpus*2+1` **per instance**. With
  N replicas + the 120s reconcile transaction, that can exceed Postgres
  `max_connections`. Append `?connection_limit=<n>&pool_timeout=<s>` to
  `DATABASE_URL` (size it: `N_replicas * connection_limit < max_connections`,
  leaving headroom for migrations/admin).
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
