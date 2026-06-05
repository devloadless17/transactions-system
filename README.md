# Transactions System

Multi-tenant transaction & settlement platform. NestJS API + Next.js dashboards, PostgreSQL via Prisma, ledger-based accounting, RLS-enforced tenant isolation.

## Stack

- **Backend:** NestJS 11 (Node 24), Prisma 6, PostgreSQL 16
- **Frontend:** Next.js 15 (App Router), TanStack Query, shadcn/ui primitives, Tailwind
- **Shared:** zod schemas + enums in `packages/shared`
- **DB:** Prisma schema + SQL migrations in `packages/db`
- **Infra:** Docker Compose (Postgres + Redis)

## Layout

```
apps/api          NestJS API
apps/web          Next.js dashboards
packages/db       Prisma schema, migrations, seed
packages/shared   zod schemas, enums, Money helper
```

## Prerequisites

- Node 24+
- pnpm 10+
- Docker + Docker Compose

## Setup

```bash
# 1. Install deps
pnpm install

# 2. Copy env
cp .env.example .env

# 3. Start Postgres + Redis (Postgres on 5444, Redis on 6391 to avoid host conflicts)
pnpm docker:up

# 4. Build shared packages (one-time; dev watcher keeps them in sync later)
pnpm packages:build

# 5. Generate Prisma client + apply migrations + seed
set -a; . ./.env; set +a
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed

# 6. Start dev servers
pnpm dev
```

- API: http://localhost:3001/v1
- Web: http://localhost:3000

The seed prints the super admin credentials. Default:

- email: `admin@example.com`
- password: `AdminPassw0rd!`

## Architecture highlights

- **Tenant isolation** — `PrismaService.runAsTenant(companyId, fn)` runs each
  query inside a DB transaction with `SET LOCAL app.current_company_id`. RLS
  policies on every tenant table compare `company_id` against this GUC.
  `runAsAdmin(fn)` sets `app.bypass_rls = 'on'` for SUPER_ADMIN endpoints and
  the seed. The runtime API connects as `txn_app_rls` (non-superuser) so RLS
  is actually enforced; migrations connect as `txn_app` (superuser).
- **Append-only ledger & audit** — DB triggers reject UPDATE/DELETE on
  `ledger_entries` and `audit_logs`. History is immutable at the DB layer.
- **Money** — all amounts are `DECIMAL(20, 8)`. App-side `Money` helper in
  `@app/shared` wraps decimal arithmetic. Never use JS `number` for money.
- **Auth** — argon2id passwords, JWT access (15m) + refresh (7d), refresh
  tokens stored hashed in DB and rotated on use. httpOnly cookies + CSRF
  double-submit on mutating routes.
- **Errors** — typed `DomainError` subclasses, mapped to HTTP by a global
  exception filter. Controllers never throw HTTP errors directly.
- **Validation** — zod schemas in `@app/shared` are the single source of
  truth, used by both API (`ZodPipe`) and web (`react-hook-form` +
  `@hookform/resolvers/zod`).

## Common scripts

| Script                   | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `pnpm dev`               | Build shared, then run API + web + shared watcher |
| `pnpm build`             | Build all apps and packages                       |
| `pnpm lint`              | Lint workspace                                    |
| `pnpm typecheck`         | Typecheck workspace                               |
| `pnpm test`              | Run all tests                                     |
| `pnpm db:migrate:deploy` | Apply migrations                                  |
| `pnpm db:seed`           | Seed admin user + sample sources/commissions      |
| `pnpm db:studio`         | Prisma Studio                                     |
| `pnpm docker:up`         | Start Postgres + Redis                            |
| `pnpm docker:down`       | Stop them                                         |

## Implementation phases

- **Phase 1 (this commit)** — workspace bootstrap, schema, RLS, auth + RBAC + CSRF, companies admin CRUD, admin dashboard shell.
- **Phase 2** — transactions ingestion (API key auth + idempotency), commission engine, ledger writes, multi-currency wallets.
- **Phase 3** — withdrawals, audit log emission, API keys UI.
- **Phase 4** — analytics, caching, queues for high-volume paths.

See `/home/aliubuntu/.claude/plans/system-architecture-prompt-fluttering-hedgehog.md` for the full architecture plan.

## Whish Pay integration

Companies mint Whish payment links; a paid link settles into the company wallet
through the existing ingest pipeline (commission + ledger + wallet credit).
We are the _outbound_ caller (the inverse of source-key ingest).

- **Config** — single platform Whish account via `WHISH_*` env vars (sandbox by
  default). `WHISH_CALLBACK_BASE` must be internet-reachable so Whish can call back.
- **Enabled currencies** — `WHISH_ENABLED_CURRENCIES` (default `USD`). Link creation
  rejects disabled currencies and, crucially, **pre-checks that a commission rule
  resolves for the amount** — so a link that couldn't settle is never minted. To
  activate LBP: set `WHISH_ENABLED_CURRENCIES=USD,LBP` **and** add commission rules
  covering LBP amounts. The enabled set is served at `GET /v1/company/whish/config`.
- **Reference** — each payment gets a numeric `externalId` (BIGINT identity). It is
  sent to Whish, echoed on callbacks, and reused as the settled transaction's
  `external_transaction_id`, making settlement idempotent against duplicate callbacks.
- **Flow** — `POST /v1/company/whish/payments` → Whish `POST /payment/whish` →
  `collectUrl`. Customer pays → Whish `GET /v1/whish/callback/{success,failure}`
  (token-guarded, **verified** via `POST /payment/collect/status` before crediting).
  Missed callbacks self-heal via a 60s reconciliation interval (and manual
  `POST .../:id/refresh-status`).
- **CRM integration** — server-to-server via a **company API key**
  (`Authorization: Bearer tsk_…`, minted under Settings → API keys):
  `POST/GET /v1/integrations/whish/payments[/:ref]`. Optional signed webhook
  (`whish.payment.paid`, `X-Whish-Signature: sha256=…`) so the CRM needn't poll.
- **Surfaces** — company **Whish Pay** + **Developers** (live tester, multi-language
  examples, webhook config) pages; **admin → Whish Pay** (balance + all payments).

**Partner integration docs:** see [`docs/`](docs/README.md) — the
[Integration Guide](docs/rival-integration-guide.md) covers both the Ingest API (for
sources) and the CRM webhooks (for companies).
