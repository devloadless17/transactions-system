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

A Linux server (Ubuntu recommended) with a public IP and root SSH (password).

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

| Secret                  | What it is / how to generate                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| `DOCKER_USERNAME`       | Your Docker Hub username.                                                  |
| `DOCKER_SECRET`         | Docker Hub access token (Account → Security → New Access Token, R/W).      |
| `SERVER_IP`             | Server public IP or hostname.                                              |
| `SERVER_SECRET`         | Server **root password**.                                                  |
| `DOMAIN`                | Your domain, e.g. `app.example.com` — **no** `https://`, **no** path.      |
| `POSTGRES_PASSWORD`     | DB superuser password. **Alphanumeric only:** `openssl rand -hex 24`.      |
| `POSTGRES_PASSWORD_RLS` | DB runtime-role password. **Alphanumeric only:** `openssl rand -hex 24`.   |
| `JWT_ACCESS_SECRET`     | `openssl rand -base64 36`                                                  |
| `JWT_REFRESH_SECRET`    | `openssl rand -base64 36` (must differ from the others)                    |
| `CSRF_SECRET`           | `openssl rand -base64 36` (must differ from the JWT secrets)               |
| `METRICS_TOKEN`         | `openssl rand -base64 24`                                                  |
| `SEED_ADMIN_EMAIL`      | Initial super-admin email (your login).                                    |
| `SEED_ADMIN_PASSWORD`   | Initial super-admin password (you'll be forced to change it on 1st login). |

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
# re-run migrations only:
docker compose -f docker-compose.prod.yml run --rm migrate
```

### Rollback

Images are tagged per commit. To roll back, edit `IMAGE_TAG=latest` to the
previous commit SHA in `/root/transactions-system/.env`, then:

```bash
docker compose -f docker-compose.prod.yml pull && \
docker compose -f docker-compose.prod.yml up -d
```
