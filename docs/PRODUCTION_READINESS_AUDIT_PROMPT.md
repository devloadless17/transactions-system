# Production-Readiness Audit — "Is every part of this system perfect?"

> **How to use:** paste everything below the line into Claude Code (or any agent with the
> Workflow/Agent tools) from the repo root. It is written as a standing directive to an
> orchestrator. It will fan out many sub-agents, verify findings adversarially, loop until
> nothing new surfaces, and finish with a blunt GO / NO-GO deploy verdict.
> Re-run it after any significant change. It is read-only by default — it must not modify
> code or data; it produces a report.

---

## ROLE & MISSION

You are the lead auditor for a **production money system** that will hold **real money** and
process **millions of transactions**. Your job is to prove — or disprove — that **every part of
the system is correct, secure, fast, realtime, solid, clean, fully documented, and ready to
deploy**. Assume an adversary and assume scale. "Looks fine" is not an answer; **evidence is**.

This is a **zero-tolerance bar** for anything touching money or tenant security. A single
cross-tenant leak, an unbalanced ledger, a lost/duplicated payment, or a silently-swallowed
money error is a **launch blocker**, full stop. Performance regressions that fall apart at
millions of rows are blockers too.

**Default to read-only.** Investigate, reproduce, measure, and report. Do **not** change code,
run destructive commands, or mutate the database. If you want to measure a query plan, use
`EXPLAIN (ANALYZE, BUFFERS)` inside a read-only transaction (`BEGIN; ... ROLLBACK;`).

## HOW TO RUN IT (orchestration)

- **Use the Workflow tool.** Decompose into the dimensions below and run them in **parallel**,
  one agent group per dimension; within a dimension, one agent per subsystem. Token cost is not
  a constraint — **thoroughness is the goal**.
- **Adversarially verify every non-trivial finding.** For each candidate issue, spawn an
  independent skeptic agent prompted to _refute_ it (reproduce it, or prove it's a false alarm).
  Only keep findings that survive. Default to "refuted" when uncertain, but record the doubt.
- **Loop until dry.** Keep launching finders until **two consecutive rounds** surface nothing
  new per dimension. Track what's been covered so rounds don't repeat.
- **No silent caps.** If you sample, top-N, or skip anything, **say so** in the report. Silent
  truncation reads as "covered everything" when it wasn't.
- **Cite everything** as `file:line`. Quote the code/query/plan. A finding with no location and
  no evidence is not a finding.
- **Reproduce money/security findings** with a concrete scenario (inputs → expected → actual),
  ideally a failing test or a query, before calling them real.

## SYSTEM CONTEXT (so agents scrutinize the right things, not rediscover the obvious)

- **Monorepo (pnpm):** `apps/api` (NestJS), `apps/web` (Next.js App Router), `packages/shared`
  (the zod contract shared by both), `packages/db` (Prisma schema + **checked-in SQL
  migrations**, applied with `pnpm db:migrate:deploy`).
- **Tenancy:** Postgres **Row-Level Security (FORCE)** on tenant tables, via
  `app.bypass_rls` / `app_current_company_id()` and the `runAsTenant` / `runAsAdmin` /
  `runAsScoped` helpers on `PrismaService`. Admin-scope rows that must never reach a tenant are
  stored with `company_id = NULL` (e.g. admin notifications).
- **Money model:** double-entry **ledger** with accounts `AVAILABLE / PENDING / RESERVED / FEE /
EXTERNAL / RECEIVABLE`; all money is `Money`/`Decimal(20,8)`, `ROUND_HALF_EVEN`; there is a
  ledger balance-invariant migration. Wallets carry an optimistic-concurrency `version`; writes
  use `SERIALIZABLE` transactions with retry.
- **Flows:** deposits (source ingest), loads, withdrawals, payouts. **Commission rule-groups**
  (per company × operation × amount tier, `FIXED|PERCENTAGE`, `DEDUCTED|ON_TOP`) book the
  platform's fee to the **FEE** ledger on settlement; a reversal debits it back. Loads
  **settle outstanding RECEIVABLE first**. Reversals/clawbacks can create a `RECEIVABLE`.
- **Source fees / net revenue (admin/system-only):** `source_fee_rules` = what an upstream
  source (e.g. Whish) charges _the platform_ per deposit, evaluated **per-deposit** via a
  correlated subquery (`apps/api/src/modules/analytics/source-fees.ts`), channel = `WHISH_PAY`
  if a `whish_payments` row links the deposit else `INGEST`. **Net revenue = platform revenue
  (FEE ledger) − source fees.** Companies must **never** see source fees or net revenue.
- **Whish Pay:** hosted collect links; **callback** URLs (settlement, carry a token) are
  platform-controlled; **redirect** URLs (payer-facing) are company-customizable (per-company
  default + per-link override). Reconciliation polls/settles; outbound webhooks are
  SSRF-guarded; creation is idempotent and dry-runs the commission rule up front.
- **Realtime:** Socket.IO; `RealtimeTopic` → client `TOPIC_KEYS` → react-query invalidation;
  admin vs company rooms.
- **Activity feed:** `UNION ALL` across the four COMPLETED money tables, merged by
  `(created_at DESC, id DESC)`, with `MAX_LIST_OFFSET` deep-paging and `BALANCE_MODE_MAX_ROWS`
  guards, backed by partial indexes.
- **Auth:** JWT cookies + **CSRF** (`csrf-token` cookie ↔ `x-csrf-token` header), API keys
  (`Bearer tsk_…`) for `integrations/*`, roles `SUPER_ADMIN / ADMIN_OPERATOR / BACKOFFICE /
COMPANY_{OWNER,MANAGER,VIEWER}`, login throttle (10/60s per IP), per-key + per-IP rate limits.
- **Docs:** `docs/companies-integration-docs.md`, `docs/sources-integration-docs.md`, pinned to
  the real schemas by a **docs↔schema contract test** (anti-drift).
- **Gates:** `pnpm typecheck`, `pnpm lint` (warning ceiling), `pnpm -r test` (unit),
  `pnpm --filter @app/api test:int` (integration, real `_test` DB), `pnpm e2e` (Playwright),
  admin reconciliation endpoint (`GET /admin/reconciliation`).

---

## BUSINESS-CRITICAL INVARIANTS (owner-stated; a violation of any is a launch blocker)

These are the product owner's non-negotiables. Treat each as a named invariant to **prove or
disprove** with evidence; a failure here is **Critical/High**, not a polish item. Real companies
are already transacting, ~90% via **API + CRM webhooks**.

1. **The two deposit flows must NEVER break or block.** (a) **Source ingest** —
   `POST /ingest/{sourceCode}/transactions` with discovery via `GET /ingest/companies`; the company
   is passive (it just receives). (b) **Whish Pay** — company-driven, via **public API AND the
   dashboard**. Money that is collected must always either become a **booked deposit** or land in a
   **visible, operator-recoverable** state. No silent drop; no collected-but-unbooked-with-no-signal.
2. **Deposits are DEDUCTED** so a deposit **succeeds even at zero wallet balance** (the fee comes out
   of the deposit, never the wallet). Prove no path can block a deposit for lack of balance, and that
   `commission ≤ amount` holds (no negative net / unbalanced ledger).
3. **Withdrawals are ON_TOP**, mostly **auto-approved** (Whish W2W to a recipient phone), with a
   **master switch to manual**. The Whish wallet is **external and NOT tracked by the system** (the
   admin also spends from it elsewhere). Any transfer failure — **session expired, insufficient Whish
   balance, ambiguous/UNKNOWN result** — must **never corrupt the ledger, never double-pay, never
   strand reserved funds**, and must leave the withdrawal **manually approvable / markable**. OFF must
   never transfer (the switch is re-checked mid-run).
4. **Loads** (credit the company wallet) and **Payouts** (debit it) — usually no fee; **API-only**.
5. **CRM emit boundary:** deposits (`transaction.*`) and withdrawals (`withdrawal.*`) are emitted to
   the company's CRM webhook; **loads and payouts are deliberately NOT emitted**. Prove the boundary.
6. **Every flow has a manual fallback.** If any automated part stops (poller down, Whish session
   dead, auto-approval off), the operator can still complete or recover the operation **by hand**
   with **correct calculations preserved** — nothing wedges with no way out.
7. **Light & fast everywhere** — every list paginated and offset-bounded, every hot query indexed,
   no unbounded `findMany`, no per-request work that scales with total rows. No lags or jank.
8. **Docs are correct AND working** — the API is the primary product surface; a new integrator can go
   zero-to-working from the docs alone, and internal-only concepts (source fees, net revenue) never
   leak to companies.

### Recent changes to verify specifically (and the drift they may create)

- **`company.visible` is now discovery-only** (gates only `GET /ingest/companies`); a hidden+ACTIVE
  company **still ingests and still settles Whish**. Verify the new behavior holds end-to-end AND that
  **docs match** (`docs/sources-integration-docs.md` previously said hidden → `403` on ingest — confirm
  whether that line is now stale and flag it).
- **Super-admin Whish "Refresh"** endpoint (`whish-admin.controller.ts` → `adminRefreshStatus`) is the
  operator recovery for paid-but-unsettled links (the 60s poller deliberately **skips** `needsAttention`
  rows). Verify it re-settles and clears the flag, is correctly role-gated (SUPER_ADMIN/ADMIN_OPERATOR,
  not BACKOFFICE), CSRF-guarded, and audited.
- **`settlementError`** is surfaced on the Whish payment response/badge — confirm it never leaks
  internal detail to a company that shouldn't see it.

---

## DIMENSIONS TO AUDIT (run as parallel agent groups; each is exhaustive, not a sample)

### 1. Money correctness & the ledger — _zero tolerance_

- Every flow keeps the ledger **balanced** (Σ debits = Σ credits per transaction) and the wallet
  projection equals the ledger (`AVAILABLE + PENDING + RESERVED + RECEIVABLE` identity). Prove it
  for ingest, load (incl. **settle-on-load**), withdrawal, payout, **reversal/clawback**,
  cancel/reject, refund.
- Commission math: `FIXED`/`PERCENTAGE`, `DEDUCTED`/`ON_TOP`, tier boundaries (inclusive/
  exclusive), rounding (`ROUND_HALF_EVEN` at the platform money scale — 2 dp; see docs/MONEY_SCALE.md), `commission ≤ amount`, percentage ∈ [0,100],
  the rule-group resolver's specificity/priority/overlap rules. Hunt for any path producing a
  **negative net, double-charge, or unbalanced** entry.
- **Source fees / net revenue:** per-deposit tier selection is deterministic (no double-count on
  touching/overlapping bands), channel classification (`WHISH_PAY` vs `INGEST`) is correct,
  rounding is sane, and the figure equals an independent recomputation. Confirm net revenue can
  only be negative for _real_ economic reasons, never a bug.
- **Idempotency & concurrency:** retried creates don't double-write (Whish idempotencyKey,
  `(source, externalId)` unique, request idempotency); concurrent wallet writes are safe under
  the `version` + `SERIALIZABLE` + retry scheme; no lost updates, no TOCTOU on balances.
- **Decimal discipline:** no JS `number` arithmetic on money anywhere; no float in SQL sums that
  feed money; DB columns are `Decimal(20,8)` end to end.

### 2. Tenant isolation & security — _zero tolerance_

- **RLS holds for every tenant table** and every access path (ORM + every `$queryRawUnsafe`):
  company A can never read/write/aggregate company B. Specifically prove the **new admin-only
  surfaces never leak**: `source_fee_rules`, source-fee analytics, net revenue, the
  `sourceFeeBreakdown`, and admin notifications (`company_id = NULL`) are unreachable from any
  company-scoped endpoint or response schema.
- **AuthZ:** every controller has correct guards/roles; no missing `@Roles`; CSRF on every
  cookie-authed mutation; API-key routes reject browser sessions and vice-versa; BACKOFFICE
  can't reach platform config; object-level checks (a company can't act on another's
  withdrawal/payout/load/whish payment by id).
- **Injection / SSRF / secrets:** every `$queryRawUnsafe` is parameterized (no string-built
  values); outbound URLs (webhooks, redirects) are validated and SSRF-guarded; no secret in
  logs/responses/repo; password hashing (argon2id) and token handling are sound; redirect URLs
  can't become open-redirect/XSS vectors.
- **Input validation:** every external input is zod-validated at the edge; no mass-assignment;
  pagination/offset is bounded (`MAX_LIST_OFFSET`); rate limits and the login throttle actually
  protect the endpoints they claim to.

### 3. Performance & scale — _budget: correct at millions of rows_

- **Index coverage for every hot query.** Run `EXPLAIN (ANALYZE, BUFFERS)` on the real queries
  and flag any **Seq Scan / Sort / Hash** on large tables, and any plan that can't early-stop on
  `LIMIT`. Required scrutiny:
  - The **source-fee per-deposit correlated subquery** (`source-fees.ts`) — at millions of
    COMPLETED deposits this is O(rows) sub-lookups per analytics call. Is it indexed
    (`source_fee_rules(source_id, channel, active)`, transactions `(status, created_at)`)? Does
    it stay acceptable, or does it need a materialized rollup / summary table? **Treat this as a
    prime suspect** — it is new.
  - The **activity `UNION ALL` feed** (deep `OFFSET`, the balance-mode window scan) and its
    partial indexes.
  - The platform/company **analytics aggregations** (`groupBy`, the FEE-ledger sums).
  - Admin list endpoints over `transactions` (potentially huge), companies, ledger, audit.
- **N+1 queries**, unbounded `findMany`, missing pagination, payloads that grow with tenant
  size, and any per-request work that scales with total rows rather than the page.
- **Caching** correctness + invalidation (the 60s analytics cache, react-query keys): stale
  money figures, cache stampedes, missing busts after mutations.
- **Connection pool & DB**: pool sizing vs expected concurrency, long transactions holding locks
  (esp. `SERIALIZABLE` retries under contention), migration lock risk on large tables (e.g.
  non-`CONCURRENTLY` index builds — see the activity-index migration note).
- **Web**: bundle size, server/client component boundaries, no heavy client work, lazy-loading
  of charts, no layout-thrash; first-paint/SSR prefetch correctness.

### 4. Realtime — _fast, lossless, multi-instance-safe_

- `RealtimeTopic` → `TOPIC_KEYS` mapping is **complete and correct** (every mutation that
  changes a viewed figure emits; every emit maps to the right query keys; no missing
  invalidation for the new source-fee/net-revenue/redirect surfaces).
- Events are emitted to the **right room** (admin vs company) and **never** to a room that would
  leak another tenant's data.
- **Horizontal scaling:** does Socket.IO have a Redis adapter / sticky sessions? With >1 API
  instance, are events delivered to all clients, or silently dropped? This is a scale blocker if
  unaddressed.
- Reconnection/backfill (no permanently-stale UI after a disconnect), backpressure, and that
  realtime is an _optimization_ — the UI is still correct after a manual reload with no events.

### 5. Reliability & correctness under failure

- **No money operation is blocked or rolled back by a best-effort side effect** (notifications,
  CRM dispatch, webhooks, realtime emits must be post-commit + try/caught).
- Idempotent and safe retries everywhere money moves; Whish reconciliation can't double-settle;
  webhook/CRM delivery has bounded retries and doesn't wedge.
- Error handling: every `catch` either handles or rethrows meaningfully; no swallowed errors
  hiding money/security failures; the global exception filter maps everything to clean,
  non-leaky responses; failed external calls degrade gracefully.
- Transaction boundaries: every multi-write money path is atomic; nothing partially commits.
- **Manual recoverability — no stuck money (owner invariant #6).** For **every** flow, prove there is
  an operator path to recover or complete by hand if the automation stops, **without corrupting
  calculations**. Enumerate the known stuck/edge states and confirm each has a working, role-gated,
  audited recovery — and that none can silently swallow money:
  - Whish **paid-but-unsettled** / **paid-after-expiry** / **unexpected-status** (`needsAttention`):
    the poller skips these by design → the **admin Refresh** endpoint must re-settle them; prove it.
  - Withdrawal **PROCESSING/UNKNOWN** after an ambiguous transfer: a manual `resolveProcessing`
    (mark transferred / revert) must exist and keep the ledger balanced; prove no double-pay and no
    stranded reservation.
  - Deposit **no-matching-commission-rule**: ingest is blocked until pricing is configured — confirm
    it surfaces loudly (counter + deduped operator alert) and recovers on a retry once a rule exists.
  - Auto-approval **off / circuit-broken / Whish session expired**: manual approve + manual
    mark-as-transferred must still work; the external/untracked Whish wallet must never be assumed.
  - Wallet `version` conflict after retries (→ 409): confirm the caller-retry contract is safe
    (idempotent, no double-credit) and documented.

### 6. Code cleanliness & correctness signals

- `pnpm typecheck`, `pnpm lint`, `pnpm -r test`, `pnpm --filter @app/api test:int`, `pnpm e2e`
  all green; run them and report exact counts. Investigate every skipped/`.only`/flaky test.
- **Test coverage of the money & security invariants** specifically — is each invariant in
  dimensions 1–2 protected by a test, or only by manual reasoning? Flag invariants with no test.
- Dead code, duplicated logic, `TODO/FIXME/HACK`, `any`-casts hiding bugs, inconsistent patterns,
  and drift between `packages/shared` and the actual API behavior.

### 7. Documentation — _the API is the primary product surface_

- The integration docs (`companies-integration-docs.md`, `sources-integration-docs.md`) are
  **complete, accurate, and current**: every public endpoint, every request/response field,
  every error code, auth, idempotency, rate limits, and the newer features (Whish **redirect
  URLs**) are documented — and **internal-only** concepts (source fees, net revenue) are **not**
  exposed to companies anywhere.
- The **docs↔schema contract test** still pins docs to the real zod schemas (no drift). Run it —
  and assess its **coverage**: it must guard **ingest** (request + the fee-omitting response),
  **loads**, **payouts**, the full **withdrawal** fields, **list pagination** (params + response
  shape + the `MAX_LIST_OFFSET` cap behaviour), and the **error envelope** — not only Whish + the
  withdrawal CASH example. A narrow contract test is itself a finding (it lets docs drift).
- Cross-check the docs against the **current** behaviour, especially anything changed recently
  (e.g. the `company.visible` ingest-gate semantics, Whish redirect URLs). Any documented behaviour
  that no longer matches code is a **doc-drift finding** with the exact `file:line` on both sides.
- A new integrator could go from zero to a working integration using only the docs. Note any gap.

### 8. Deploy-readiness & operability

- Migrations are **additive, ordered, reversible-in-spirit, and safe on large tables** (no
  long exclusive locks; `CONCURRENTLY` where needed); the migration history is clean and applies
  on a fresh DB.
- Env/config: every required env var is validated at boot (fail-fast), no dev defaults leak to
  prod (e.g. seeded admin password forces change **in production**), secrets sourced correctly.
- Health checks, graceful shutdown, structured logging without PII/secrets, and enough
  observability (metrics/traces) to debug a money incident in prod.
- Build is reproducible and green (`pnpm build`).

---

## OUTPUT — what to hand back

Produce ONE consolidated report:

1. **Verdict (top line): GO / NO-GO for production**, with the count of blocking issues.
2. **Blocking issues** first (severity **Critical/High**), each as:
   `[severity] [dimension] title — file:line — evidence (quote/plan/repro) — concrete fix — how to verify the fix`.
3. **Non-blocking findings** (Medium/Low) grouped by dimension, same format.
4. **What was verified clean** (so the green areas are explicit, not just silence) and the exact
   gate results (typecheck/lint/unit/integration/e2e counts, reconciliation divergent count,
   key `EXPLAIN` timings).
5. **Coverage & caveats:** what was sampled vs exhaustive, anything not reached, and the
   highest-leverage next checks.

Severity rubric: **Critical** = money loss/corruption, cross-tenant leak, or data-loss path.
**High** = security/authz hole, missing money invariant, or a query that fails at scale.
**Medium** = correctness/perf risk under load, missing test on an invariant, doc gap.
**Low** = cleanliness/polish.

Hold the bar: this system holds **real money at millions of transactions**. If you are not
certain something is correct, say so and show what would make you certain. Do not soften a
blocker to make the verdict greener.
