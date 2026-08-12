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
- **Money** — the platform money scale is **2 dp (whole cents)**; see
  `docs/MONEY_SCALE.md` (and `docs/MONEY_SCALE_MIGRATION.md` for the remaining
  data migration). Columns are `DECIMAL(20, 8)` at rest as headroom for
  pre-migration rows, and two things keep their precision on purpose: PERCENTAGE
  rule values (a rate is not money — 0.125% is a real price) and the append-only
  `ledger_entries` / `wallets` projection. App-side `Money` helper in
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

- **Config** — single platform Whish account via `WHISH_*` env vars (Whish Pay
  **v1.4.4**; sandbox `https://partner.api.sbx.whish.money/itel-service/api` by
  default, live `https://api.whish.money/itel-service/api`). In production the base
  URL must be the live host — the guard allowlists it rather than blacklisting
  "sandbox", so a renamed sandbox can never slip through; `WHISH_ALLOW_SANDBOX=true`
  is the explicit opt-in for staging. `WHISH_CALLBACK_BASE` must be
  internet-reachable so Whish can call back.
- **Local development** — Whish rejects `localhost`/loopback in **any** of the four
  URLs it is sent, with HTTP 403 (confirmed against the live v1.4.4 sandbox). Note
  that this covers **two** settings: `WHISH_CALLBACK_BASE` builds the callback URLs
  and `WEB_ORIGIN` builds the payer redirect URLs — a public callback base with a
  localhost `WEB_ORIGIN` is still refused. So the real sandbox cannot complete a
  round trip from a dev machine: run `node scripts/fake-whish.cjs` and point
  `WHISH_BASE_URL` at `http://localhost:4100/itel-service/api` instead. It can be
  driven through every `collectStatus` (`/__set-status?s=…`) and the indeterminate
  envelope (`/__set-envelope?mode=indeterminate`).
- **Amount rules** — Whish _documents_ per-currency limits (USD: at most 2 decimals,
  minimum 1.00) in `WHISH_AMOUNT_RULES`, but does **not** enforce them: the live
  sandbox mints a real link for `0.50` and `10.005`, and carries a `0.50` link to the
  payer's OTP step. So we log a warning and forward the amount — we must never be
  stricter than the payment provider and refuse money it would collect. That table
  is also the seam for enabling LBP.
- **Enabled currencies** — `WHISH_ENABLED_CURRENCIES` (default `USD`). Link creation
  rejects disabled currencies and, crucially, **pre-checks that a commission rule
  resolves for the amount** — so a link that couldn't settle is never minted. To
  activate LBP: set `WHISH_ENABLED_CURRENCIES=USD,LBP` **and** add commission rules
  covering LBP amounts. The enabled set is served at `GET /v1/company/whish/config`.
- **Reference** — each payment gets a numeric `externalId` (BIGINT identity), sent
  to Whish as a digit **string** (v1.4.4 documents the field as a String), echoed on
  callbacks, and reused as the settled transaction's `external_transaction_id`,
  making settlement idempotent against duplicate callbacks.
- **Statuses** — Whish returns `success | failed | pending | refunded | unknown`.
  Only `success` and `failed` are settled; `pending` persists **after a failed
  attempt** (the link stays payable) and `unknown` means the outcome could not be
  determined, so both keep polling. A `status:false` + `code:"500"` reply likewise
  means _pending_, surfaced as `WHISH_PENDING` — never treated as a failure.
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
[Companies Integration Guide](docs/companies-integration-docs.md) (company API + CRM
webhooks, for companies) and the [Sources Integration Guide](docs/sources-integration-docs.md)
(the Ingest API, for sources).
