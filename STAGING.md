# Staging instance (same server as prod)

A second, fully isolated copy of the app running **alongside** live prod on the
same VPS, for testing — notably the **Whish sandbox**. It reuses the exact same
published Docker images as prod (the web image is domain-agnostic / same-origin),
but has its own database, its own secrets, its own Whish sandbox credentials, and
its own public hostname.

```
                         ┌──────────── txn_caddy (prod, :80/:443) ────────────┐
DNS  portal.rivalpayments.com ───────▶ │  portal.rivalpayments.com  → api / web        (LIVE) │
DNS  staging.portal.rivalpayments.com ▶│  staging.portal...         → api-staging / web-staging (SANDBOX) │
                         └──────── reaches staging over the shared `edge` network ──────┘

prod project   : postgres / redis / api / web            (live DB, live Whish)
staging project: postgres-staging / redis-staging /
                 api-staging / web-staging               (separate DB, sandbox Whish)
```

Nothing is shared between the two stacks except the prod Caddy (the single TLS
entrypoint) and the `edge` network it uses to reach staging.

---

## One-time setup

**1. DNS** — add an A record so Caddy can get a cert and route traffic:

```
staging.portal.rivalpayments.com   A   <server IP>     # same IP as prod
```

**2. Create the shared `edge` network on the server** (REQUIRED before the next
prod deploy — `docker-compose.prod.yml` now references it as external):

```bash
docker network create edge        # idempotent enough; ignore "already exists"
```

**3. Ship the new config to the server.** The updated `Caddyfile` (with the
staging route), `docker-compose.staging.yml`, and the same-origin prod web image
all arrive on the next normal prod deploy (push to `production`). That deploy also
re-attaches the prod Caddy to `edge`. Prod stays up; verify it's still healthy
after.

> If you want to wire the running Caddy to `edge` immediately without waiting for
> a deploy: `docker network connect edge txn_caddy && docker exec txn_caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`

**4. Create `.env.staging` on the server** (next to `.env`), from the template:

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
# Fill: fresh DB passwords + JWT/CSRF/METRICS secrets (do NOT reuse prod's),
# and the Whish SANDBOX channel/secret. Keep WHISH_ALLOW_SANDBOX=true.
nano .env.staging
```

Generate secrets:

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD, POSTGRES_PASSWORD_RLS (URL-safe)
openssl rand -base64 36   # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, CSRF_SECRET, METRICS_TOKEN
```

**5. Bring staging up** (first run seeds the admin):

```bash
SC="docker compose -p staging --env-file .env.staging -f docker-compose.staging.yml"

$SC pull
# First run only: seed the super admin. Set SEED_DATABASE=true in .env.staging,
# run migrate, then set it back to false.
$SC run --rm migrate-staging
$SC up -d --remove-orphans
$SC ps
```

Caddy auto-issues the TLS cert on first hit. Visit
`https://staging.portal.rivalpayments.com` — log in with the seeded admin and
confirm a Whish payment link mints against the sandbox.

---

## Continuous deployment (branch flow)

Three branches. **Only `production` can deploy the live site** — `main` is a safe
integration branch that runs CI but never touches the server:

| Push to…     | Workflow                               | Deploys                                     | Whish   |
| ------------ | -------------------------------------- | ------------------------------------------- | ------- |
| `main`       | `.github/workflows/deploy.yml`         | **nothing** — CI only (typecheck/lint/test) | —       |
| `staging`    | `.github/workflows/deploy-staging.yml` | staging (`docker-compose.staging.yml`)      | SANDBOX |
| `production` | `.github/workflows/deploy.yml`         | prod (`docker-compose.prod.yml`)            | LIVE    |

- Each workflow builds **its own branch's code**, so staging tests exactly what
  you'll later release from `production`.
- Images are tagged per stack — prod: `:latest` / `:<sha>`; staging: `:staging` /
  `:staging-<sha>` — so they never collide in the shared Docker Hub repo.
- The staging workflow needs **no extra GitHub secrets** (just the SSH + Docker
  ones prod already uses). Staging's app secrets stay in `.env.staging` on the
  server; CI only ships code and re-points the stack at the new image tag.

Typical flow: do the work on `staging` → push → it deploys to the sandbox site →
verify → open a PR `staging → main` → merge (CI runs, nothing deploys) → when you
are ready to release, **push `main` to `production`**:

```bash
git push origin main:production   # ← the only thing that deploys the live site
```

> A manual `workflow_dispatch` run of the deploy workflow also **only deploys when
> run from the `production` branch**; from `main` it just runs the checks.

> First-time `staging` branch: `git switch -c staging && git push -u origin staging`.
> `.env.staging` must already exist on the server (see One-time setup above) or
> the staging deploy fails fast with a clear message.

## Updating staging manually (without a push)

```bash
SC="docker compose -p staging --env-file .env.staging -f docker-compose.staging.yml"
# Optionally pin .env.staging IMAGE_TAG to a specific image tag first.
$SC pull
$SC run --rm migrate-staging     # only if there are new migrations
$SC up -d --remove-orphans
```

## Stop / remove staging (prod untouched)

```bash
SC="docker compose -p staging --env-file .env.staging -f docker-compose.staging.yml"
$SC down                 # stop containers, keep the DB volume
$SC down -v              # ALSO wipe the staging DB + redis volumes
```

## Logs

```bash
docker logs -f txn_api_staging
docker logs -f txn_web_staging
```

---

## Notes / gotchas

- **Always pass `-p staging`** (or rely on the pinned `name: staging` in the
  compose file). Staging volumes/networks are `staging_*`; prod's are separate.
- The staging route in the `Caddyfile` just returns 502 whenever staging isn't
  running — it never affects the prod site.
- `edge` is external on purpose: a prod `docker compose down` won't remove it,
  and staging attaches independently.
- Staging uses the SANDBOX: `WHISH_BASE_URL=https://api.sandbox.whish.money/...`,
  `WHISH_ALLOW_SANDBOX=true`, and the sandbox channel/secret. Prod stays live.
- Whish sandbox callbacks hit `https://staging.portal.rivalpayments.com/v1` — make
  sure the sandbox account is configured for that host.
