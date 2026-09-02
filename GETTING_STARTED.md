# Getting started

You just cloned the repo. This is the shortest path to a running stack on your machine. For the wider project overview see [README.md](./README.md).

## 1. Prerequisites

- **Node 24+** (check with `node -v`)
- **pnpm 10+** (`corepack enable && corepack prepare pnpm@latest --activate`, or `npm i -g pnpm`)
- **Docker + Docker Compose** — Postgres and Redis run in containers so nothing pollutes your host

## 2. Install + configure

```bash
pnpm install
cp .env.example .env
```

`.env.example` is the source of truth for defaults. Don't edit `.env.example` unless you're changing the shared defaults — edit your local `.env` for personal overrides.

What the defaults give you:

| Var                                        | Default                                                | What it is                             |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------- |
| `DATABASE_URL`                             | `postgresql://txn_app_rls:…@localhost:5444/txn_system` | Runtime app connection (RLS enforced)  |
| `DATABASE_MIGRATIONS_URL`                  | `postgresql://txn_app:…@localhost:5444/txn_system`     | Migration connection (RLS bypass)      |
| `REDIS_PORT`                               | `6391`                                                 | Host-side port for the Redis container |
| `API_PORT`                                 | `3001`                                                 | NestJS listens here                    |
| `WEB_PORT`                                 | `3000`                                                 | Next.js listens here                   |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@example.com` / `AdminPassw0rd!`                 | Created by `db:seed`                   |
| `NEXT_PUBLIC_API_BASE_URL`                 | `http://localhost:3001/v1`                             | Web → API base URL                     |

Postgres binds to **5444** and Redis to **6391** specifically to avoid clashing with anything already running on the standard ports (5432 / 6379).

## 3. First-time setup

Run these in order, once:

```bash
# Start Postgres + Redis (detached)
pnpm docker:up

# Load .env into your shell so the Prisma CLI sees DATABASE_URL.
# (Required for db:* scripts; the dev servers load .env themselves.)
set -a; . ./.env; set +a

# Generate the Prisma client, apply migrations, seed the admin + sample data
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
```

If `pnpm docker:up` says ports are taken, edit `.env` to pick free ones, then run `pnpm docker:down && pnpm docker:up`.

`db:migrate:deploy` is non-interactive — use it for clean clones and CI. Use `pnpm db:migrate` only when you want to _create_ a new migration in dev (it needs a shadow DB; see Troubleshooting).

## 4. Start the dev servers

```bash
pnpm dev
```

That builds the shared packages once, then runs three watchers in parallel:

- `pkgs` — rebuilds `@app/db` + `@app/shared` on change
- `api` — NestJS, hot-reloads on TS changes
- `web` — Next.js dev server

You'll see colored, prefixed logs from each. Ready when you see:

- API: `Nest application successfully started` and `API listening on http://0.0.0.0:3001/v1`
- Web: `✓ Ready in …` from Next

Open:

- **Web:** http://localhost:3000
- **API health:** http://localhost:3001/v1/health
- **Prisma Studio (DB GUI):** `pnpm db:studio`

### Running on different ports

If another project already owns 3000/3001, change `WEB_PORT` and `API_PORT` in your
`.env` — nothing else. `pnpm dev`, `docker compose`, `pnpm e2e`, `pnpm loadtest` and
`scripts/ui-smoke.cjs` all read those two vars, so the whole toolchain moves together.
Two things must move with them or login breaks:

- `ALLOWED_ORIGINS` (and `WEB_ORIGIN`) — the API rejects a browser origin it doesn't
  list, so a web server on a new port needs that origin added.
- `apps/web/.env.local` — `next dev` does **not** read the repo-root `.env`, so the
  browser bundle and Next's server side each need the API URL spelled out there:

  ```bash
  # apps/web/.env.local  (gitignored, per-machine)
  NEXT_PUBLIC_API_BASE_URL=http://localhost:4001/v1   # browser → API
  API_INTERNAL_BASE_URL=http://127.0.0.1:4001/v1      # middleware / server components → API
  ```

  Without the second line, login sets its cookies and every guarded route still
  bounces back to `/login`.

Container-internal ports never change: inside Docker the API is always `:3001` and the
web always `:3000`, and Caddy proxies to those names. `WEB_PORT`/`API_PORT` only pick
the **host** side of the mapping.

Sign in to the web with the seeded admin: `admin@example.com` / `AdminPassw0rd!` (or whatever you put in your `.env`).

## 5. Verify everything works

Optional but quick — runs a 27-test Playwright smoke against the live stack (needs `pnpm dev` already running):

```bash
pnpm e2e
```

Or just lint + typecheck without launching browsers:

```bash
pnpm lint
pnpm typecheck
```

## Workspace layout

```
apps/
  api/           NestJS API (entry: src/main.ts)
  web/           Next.js App Router dashboards
packages/
  db/            Prisma schema + SQL migrations + seed
  shared/        zod schemas, enums, Money helper (the contract between api and web)
e2e/             Playwright specs
postman/         Postman collection covering the full flow
docker-compose.yml  Postgres + Redis
```

The api and web both depend on `@app/shared` and `@app/db`. When you change a shared file, `pkgs` watcher rebuilds and both apps hot-reload.

## Common day-to-day commands

| What you want             | Command                                         |
| ------------------------- | ----------------------------------------------- |
| Run everything            | `pnpm dev`                                      |
| Just the API              | `pnpm --filter @app/api dev`                    |
| Just the web              | `pnpm --filter @app/web dev`                    |
| Apply existing migrations | `pnpm db:migrate:deploy`                        |
| Author a new migration    | `pnpm db:migrate` (interactive)                 |
| Reset DB & re-seed        | `pnpm db:reset`                                 |
| Re-seed only              | `pnpm db:seed`                                  |
| Inspect the DB            | `pnpm db:studio`                                |
| Typecheck workspace       | `pnpm typecheck`                                |
| Lint                      | `pnpm lint` (fix: `pnpm lint:fix`)              |
| Unit tests                | `pnpm test`                                     |
| Browser e2e               | `pnpm e2e` (or `pnpm e2e:ui` for the inspector) |
| Stop containers           | `pnpm docker:down`                              |
| Tail container logs       | `pnpm docker:logs`                              |

## How the pieces fit together

- A request hits **Next.js** at :3000 → server components / API client call the **NestJS API** at :3001.
- The API authenticates the request (JWT cookie + CSRF for the dashboard, Bearer API key for ingestion), then opens a Prisma transaction. For tenant-scoped queries it runs `SET LOCAL app.current_company_id = <uuid>` so Postgres RLS policies filter rows automatically.
- Money operations write **balanced ledger entries** (debits == credits) before touching wallet balances. Ledger entries are append-only at the DB layer (a trigger rejects UPDATE/DELETE).
- External providers (OMT, Wish, …) authenticate with a **source API key** and POST to `/v1/ingest/<sourceCode>/transactions`, identifying the target company by `companySlug` in the body (company UUIDs are never exposed to sources). Discovery: `GET /v1/ingest/companies` (returns slugs; kept undocumented for partners — slugs are normally handed out directly).

See [README.md](./README.md) for the architecture deep-dive.

## Troubleshooting

**`Cannot find module '/.../apps/api/dist/main'`**
The api crashed during a hot-reload restart. Stop with Ctrl-C and re-run `pnpm dev`. If it persists, run `pnpm packages:build` to force a clean rebuild of the shared packages first.

**`prisma migrate dev` says "could not create the shadow database"**
The runtime DB user (`txn_app_rls`) doesn't have CREATEDB permission, which `migrate dev` needs to detect drift. Either:

- Use `pnpm db:migrate:deploy` instead — non-interactive, no shadow DB needed. Use this unless you're actively authoring a new migration.
- Or grant CREATEDB to `txn_app` once: `PGPASSWORD=… psql -U postgres -h localhost -p 5444 -c "ALTER USER txn_app CREATEDB;"`.

**Port already in use (3000 / 3001 / 5444 / 6391)**
Something else is listening. Either kill it or change the corresponding `*_PORT` var in `.env` and restart the relevant service.

**Migrations are out of sync with the DB**

```bash
pnpm db:reset      # drops the DB, re-runs all migrations, re-seeds
```

This is destructive — local data is lost. Don't run it against shared/staging DBs.

**The web shows "Something went wrong" on a fresh page load**
Open DevTools → Network and find the failed request. Most often the API is still compiling or crashed; check the `api` pane in `pnpm dev`.

**Logged-in cookies look stale after switching users**
Clear cookies for `localhost` (DevTools → Application → Cookies) or open a private window.

## Project conventions to know on day one

- **Zod schemas in `packages/shared` are the single source of truth.** The API validates inbound payloads with `ZodPipe(<schema>)`; the web validates the same payload via `react-hook-form` + `@hookform/resolvers/zod`. If you need to change a payload shape, change the schema first.
- **Never use JS `number` for money.** Use `Money` from `@app/shared` — JS floats
  silently corrupt amounts. The platform money scale is **2 dp (whole cents)**;
  read money out of the DB with `Money.fromDb()` and derive dependent legs by
  exact subtraction. See `docs/MONEY_SCALE.md` for the one-page rule.
- **Don't throw HTTP errors from controllers.** Throw a `DomainError` subclass (`ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`) and the global filter maps it.
- **Don't mock the DB in tests.** Tests hit a real ephemeral Postgres so migrations and RLS policies are exercised end-to-end.

## Where to go next

- [README.md](./README.md) — full architecture + design rationale
- [postman/transactions-system.postman_collection.json](./postman/transactions-system.postman_collection.json) — import into Postman and click through the requests in folder order for a guided tour of every endpoint
- [packages/db/prisma/schema.prisma](./packages/db/prisma/schema.prisma) — the canonical data model
- [packages/shared/src/schemas/](./packages/shared/src/schemas/) — all API request/response shapes
