# Security Audit Report — Transactions / Settlement Platform

**Scope:** Full application — NestJS API (`apps/api`), Next.js web (`apps/web`), DB/schema (`packages/db`), shared money lib (`packages/shared`), bootstrap/config/deployment.
**Method:** Read-only adversarial audit. Attacker model = a legitimate authenticated tenant (and a forged external webhook caller) trying to steal funds, cross tenant boundaries, or corrupt the ledger. Every value-moving flow traced end-to-end.
**Date:** 2026-06-19

---

## 1. Executive Summary

**This is a genuinely strong, security-conscious money codebase — well above the norm.** Tenant isolation is enforced at the database (Postgres RLS with `FORCE ROW LEVEL SECURITY`), not just in app code; money is exact decimal with a double-entry ledger backed by DB triggers and serializable transactions; auth uses argon2id, alg-pinned JWTs, rotating refresh tokens with reuse detection, and a fail-closed production config gate.

**I found no CRITICAL or HIGH vulnerability in the application logic.** No cross-tenant read/write, no double-spend, no double-credit, no auth bypass, no ledger-imbalance path, no SQL injection, no forgeable money settlement, no SSRF bypass. The findings below are dependency patching and defense-in-depth hardening.

| Severity | Count   | Summary                                                                                                              |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| Critical | 0       | —                                                                                                                    |
| High     | 0 (app) | (Dependency CVEs tracked separately under M1)                                                                        |
| Medium   | 3       | Dependency CVEs; fail-open guard architecture; Whish callback token in URL/logs                                      |
| Low      | 4       | Multi-instance job locking; API-key privilege breadth; `/admin/sources` read exposure; public CRM-demo token-in-path |
| Info     | several | Positives + minor notes                                                                                              |

**Top risks in plain language:**

1. **Outdated dependencies** carry known CVEs (mostly DoS/transitive, some dev-only). The only concrete "patch now" item.
2. **Authentication is opt-in per controller** (only the rate-limiter is global). Every controller is correctly guarded _today_, but one forgotten `@UseGuards` on a future endpoint would be unauthenticated rather than denied.
3. **The public Whish callback passes its secret token in the URL query string**, which lands in access logs / proxies / the app's own request log. Not directly exploitable (settlement re-verifies with Whish and never trusts request input), but it's a secret-hygiene weakness.

---

## 2. System Map (condensed)

**Global guard model:** The only globally-registered guard (`APP_GUARD`) is `ThrottlerGuard` (rate limiting). Authentication/authorization is applied per-controller via `@UseGuards`. Guards:

- `JwtAuthGuard` — verifies `txn_access` cookie or `Bearer` JWT (HS256, alg-pinned), **re-loads the user live each request** (status, role-change, mustChangePassword), gates inactive companies, honors `@Public()`. `jwt-auth.guard.ts`
- `CompanyAccessGuard` — accepts a company API key (`Bearer tsk_…`) OR delegates to `JwtAuthGuard`; sets `apiKeyAuth` so CSRF is skipped for key callers. `company-access.guard.ts`
- `ApiKeyAuthGuard` / `CompanyApiKeyAuthGuard` — `tsk_` key auth for ingest/integrations.
- `RolesGuard` — enforces `@Roles(...)` membership; **allows when no roles are declared** (auth is a separate guard).
- `CsrfGuard` — double-submit cookie on mutating methods; skipped for API-key auth and `@Public()`.

**Money-moving entry points** (all authenticated + role-gated unless noted):

- `POST /v1/ingest/:sourceCode/transactions` — API-key, credits wallet (the core inflow).
- `POST /v1/company/{withdrawals,payouts,loads}` + admin `approve/reject` — money out/in, OWNER/MANAGER then platform approval.
- `POST /v1/admin/transactions/:id/reverse` — SUPER_ADMIN/ADMIN_OPERATOR.
- `GET /v1/whish/callback/{success,failure}` — **public** (token-gated), settles a Whish payment → ledger txn → wallet credit.
- Company-configured outbound webhook + CRM delivery (background).

**Tenant model:** Every tenant table has RLS policy `company_id = app_current_company_id() OR app_bypass_rls()` + `FORCE ROW LEVEL SECURITY`. All DB access funnels through `PrismaService.runAsTenant` / `runAsAdmin` / `runAsScoped`; the GUC is set via **parameterized** `set_config()`; a boot guard (`assertRlsEnforced`) fails hard in prod if the runtime DB role can bypass RLS. The authenticated `companyId` always comes from the live user row / verified key — never from request input.

Full route inventory is in the appendix of the working notes; omitted here for brevity.

---

## 3. Findings (by severity)

### M1 — Outdated dependencies with known CVEs · Medium · Confidence: High

`pnpm audit`: **39 advisories (2 critical, 10 high, 23 moderate, 4 low)**. Production-runtime high-severity ones:

| Package          | Path                    | Issue                                     | Fix                 |
| ---------------- | ----------------------- | ----------------------------------------- | ------------------- |
| `path-to-regexp` | `@nestjs/core`          | ReDoS / DoS via routing                   | ≥ 8.4.0             |
| `ws`             | `socket.io › engine.io` | WebSocket memory-exhaustion DoS           | ≥ 8.21.0            |
| `undici`         | direct (outbound fetch) | 3× WS-client CVEs + cache info-disclosure | ≥ 7.28.0            |
| `lodash`         | `@nestjs/config`        | Code injection via `_.template`           | ≥ 4.18.0 (override) |

The 2 **critical** (`vitest` RCE) and several other highs (`vite`, `glob`, `picomatch`, `form-data`) are **dev/test-only** dependencies — not in the production runtime, lower real-world risk, but worth clearing for CI hygiene.

**Exploitability note:** the prod-runtime highs are DoS-class or transitive; the `undici` CVEs are in its **WebSocket client**, which the app does not use (it uses `undici.fetch` for SSRF-safe outbound HTTP). No direct money/RCE path in the app's actual usage. Still, a money platform should run clean.

**Fix:** `pnpm update` the transitive ranges; add `pnpm.overrides` for `undici`, `lodash`, `path-to-regexp`, `ws`; bump `vitest`/`vite`. Re-run `pnpm audit`. Add `pnpm audit --prod --audit-level=high` to CI.

---

### M2 — Authentication is opt-in per controller (fail-open architecture) · Medium · Confidence: High

`app.module.ts` registers only `ThrottlerGuard` globally. There is **no global `JwtAuthGuard`**, so a controller that omits `@UseGuards` is reachable unauthenticated (only throttled), rather than denied by default. Every controller is correctly guarded _today_ (verified across all modules), but this relies on every author remembering to opt in — there is no backstop.

**Why it matters:** in a money system, the safe default is deny. A single future endpoint (or a refactor that drops a controller-level guard) silently becomes public.

**Fix (defense-in-depth):** register `JwtAuthGuard` as a global `APP_GUARD` and rely on the existing `@Public()` decorator to opt out the genuinely public routes (login, refresh, csrf, whish callback, crm-demo). The guards already support this. Alternatively/additionally, add an architecture test that asserts every controller method has an auth guard or `@Public()`.

---

### M3 — Whish callback secret token travels in the URL query string (and is logged) · Medium · Confidence: High

`GET /v1/whish/callback/{success,failure}?token=…&externalId=…` is the public settlement webhook. The per-payment `callbackToken` is a 192-bit random, compared in constant time (`whish-payments.service.ts:288`), and settlement **re-verifies** real status with Whish and takes the amount from the stored row (never from request input). So a forged or token-less call settles nothing, and the token cannot inject money or an amount.

**The weakness:** the token is in the query string, so it is written to nginx/ALB access logs, forward proxies, and — confirmed — the app's own request log (the pino `req` serializer logs `url`, `logger.module.ts:44`). A token recovered from logs is replayable until the payment settles. Blast radius is limited (it only _triggers a re-verification_ of a payment that is genuinely PAID at Whish — the 60s reconciler would settle it anyway), so this is secret-hygiene / defense-in-depth, not direct money loss.

**Fix:** prefer a header or POST body for the token (Whish's callback shape permitting), or add a provider HMAC signature. At minimum, redact `token` from the logged URL and document the log-retention exposure. Consider an IP allowlist for Whish if they publish ranges.

---

### L1 — Background jobs use in-process locks only (no distributed lock) · Low · Confidence: High

`whish-reconciliation` (expires payments, calls Whish, settles) and `crm-delivery` (outbound POSTs) guard against overlap with an in-memory `running` flag. With more than one API instance (the prod compose scales the API), these run concurrently across pods.

**Impact:** money double-credit is still prevented (settlement uses `status=PENDING` compare-and-set + the `(sourceId, externalTransactionId)` unique constraint + serializable txn). The residual risk is **duplicate outbound CRM/webhook deliveries** and redundant Whish API calls under multi-instance deploys.

**Fix:** a Redis-based lock (Redis/ioredis is already a dependency) or Postgres advisory lock around each sweep; or move these to BullMQ (already installed, currently unused) with a single repeatable job.

---

### L2 — Company API keys carry full COMPANY_OWNER capability with no gradation · Low · Confidence: High

`CompanyApiKeyAuthGuard` mints a synthetic principal hardcoded to `role: COMPANY_OWNER` (`api-key-auth.guard.ts:42`), and `CompanyAccessGuard` lets keys drive `company/*` money endpoints (create/cancel withdrawals, payouts, loads) while **bypassing CSRF** (correct — key is in a header) and the live user-status re-check. So any valid company key == full owner-level money-request capability; `@Roles(COMPANY_MANAGER…)` is always satisfied for key callers.

**Impact:** a leaked company API key can initiate money-movement requests (still subject to platform approval for settlement). This is by design, but there is no scoping/least-privilege (e.g. read-only or ingest-only keys) and no per-key role.

**Fix (optional, hardening):** add key scopes/permissions (read-only, ingest-only, money-ops) and enforce them in the guard; surface `lastUsedAt`/anomaly alerts; document key compromise as owner-equivalent.

---

### L3 — `/admin/sources` GET routes readable by any authenticated user · Low · Confidence: High

`GET /v1/admin/sources`, `/all`, `/:id` (`sources.controller.ts:43,48,53`) have no `@Roles`, so any authenticated tenant user (e.g. a `COMPANY_VIEWER`) can read the platform source catalog via an `/admin/*` path. Intentional per code comment (sources are system-wide, non-tenant, no RLS), and the data is a non-sensitive catalog — but it is cross-privilege exposure of an admin-namespaced resource.

**Fix:** if intended for tenants, move these under a `/company/*` or neutral path to avoid implying admin protection; otherwise add `@Roles` for platform staff.

---

### L4 — Public CRM-demo ingress with token-in-path · Low · Confidence: High

`POST /v1/crm-demo/:token/inbox` (`crm-demo.controller.ts:30`) is public, defended by an unguessable per-company path token + timing-safe `crmDemoKey`. Token-in-path has the same log-leak property as M3. Impact is confined to the demo inbox (no money, no real tenant data mutation).

**Fix:** treat like M3 (token out of the URL where practical); confirm the demo inbox can't be used as an unbounded write/DoS sink (it is throttled).

---

## 4. Money-Integrity Attestation

For every value-moving flow I could **prove** the ledger stays balanced and tenant isolation holds:

| Flow                                                | Ledger balanced? | Tenant-scoped? | Notes                                                                                   |
| --------------------------------------------------- | ---------------- | -------------- | --------------------------------------------------------------------------------------- |
| Transaction ingest                                  | ✅               | ✅ RLS         | DEBIT EXTERNAL / CREDIT AVAILABLE + FEE; commission re-derived server-side              |
| Transaction reverse                                 | ✅               | ✅             | clawback caps at available, remainder → RECEIVABLE; blocks money-out while owed         |
| Withdrawal / Payout (request→approve→reject/cancel) | ✅               | ✅             | reserve→capture→release; only PENDING releasable; DB status-transition trigger          |
| Load                                                | ✅               | ✅             |                                                                                         |
| Whish settlement                                    | ✅               | ✅             | delegates to ingest; idempotent via unique `(source,externalId)` + `status=PENDING` CAS |

**Guarantees verified:** all money is `decimal.js` (`Decimal(20,8)`), **no float arithmetic anywhere**; `LedgerService.writeEntries` asserts DEBIT==CREDIT per currency and a DB `AFTER` trigger re-checks it; ledger is append-only (UPDATE/DELETE blocked by trigger); wallet mutation is the single `WalletsService.applyDelta` choke point with optimistic `version` locking + non-negative CHECK constraints; all mutations run in `runSerializable*` (Serializable isolation, 40001/P2002 retry); negatives/zero/NaN/Infinity rejected at the zod edge (`moneyAmountSchema`); commission is always server-derived (never client-supplied) with a tier-ladder validator that forbids overlap. `pendingBalance` is currently unfunded/unspendable.

---

## 5. Prioritized Remediation Plan

1. **M1 — Patch dependencies** (½ day). `pnpm.overrides` for `undici≥7.28`, `lodash≥4.18`, `path-to-regexp≥8.4`, `ws≥8.21`; bump `vitest`/`vite`. Add `pnpm audit --prod --audit-level=high` to CI. _Highest concrete value._
2. **M2 — Make auth fail-closed** (½ day). Global `JwtAuthGuard` + `@Public()` opt-out, or an architecture test asserting guard coverage. _Prevents the most likely future critical._
3. **M3 — Whish callback token hygiene** (½–1 day). Move token off the query string and/or redact it from logs; consider provider HMAC/IP allowlist.
4. **L1 — Distributed lock** for background sweeps (½ day) before/when scaling the API past one instance.
5. **L2–L4 — Hardening** (as capacity allows): API-key scopes; relocate/justify `/admin/sources` reads; CRM-demo token hygiene.

---

## 6. What This Audit Did _Not_ Fully Cover

- **Dynamic/runtime testing** — this was static analysis. The concurrency/idempotency guarantees were verified by reading the code + DB constraints, not by running concurrent load against a live instance. A load/chaos test of the double-spend and double-credit paths (concurrent withdrawals summing > balance; replayed/interleaved Whish callbacks) would convert "proven by construction" into "proven empirically."
- **Infra/secrets at rest** — Docker/compose and the Caddyfile were not deeply reviewed; `.env` is correctly untracked and prod config is fail-closed, but secret storage/rotation in the actual deployment environment is out of band.
- **Analytics SQL tenant-scoping** — the raw `$queryRawUnsafe` analytics queries are parameterized (no injection) and read-only; I did not exhaustively trace every analytics WHERE for tenant scoping since they never mutate and admin analytics is role-gated.
- **Full dependency transitive review** — beyond the `pnpm audit` advisory set.

**Bottom line:** the application is solid and the money invariants hold. Address M1 (dependencies) now, M2/M3 as quick hardening, and the system is in very strong shape for a production money platform.
