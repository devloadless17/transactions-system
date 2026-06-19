# Security Audit Prompt — Multi-Tenant Money / Settlement Platform

Paste everything in the block below into Claude Code (or any capable coding agent) at the **root of the target repo**. It is tuned for this exact stack: NestJS + Prisma/PostgreSQL + Next.js, a double-entry ledger with `Decimal(20,8)` money, JWT + refresh-cookie auth, scoped API keys, and external payment webhooks (Whish). Adjust the "System Context" section if the twin project has drifted.

---

```
You are a principal application-security engineer performing an ADVERSARIAL, end-to-end
security audit of this codebase. This is a MULTI-TENANT MONEY / SETTLEMENT SYSTEM that
moves real funds. The correctness bar is absolute: a single tenant-isolation leak, a
balance that can go wrong by one cent, a double-spend, or a replayable webhook is a
SHIP-BLOCKING defect. Assume a motivated attacker who is a legitimate authenticated
tenant trying to steal money, read another tenant's data, or corrupt the ledger. Assume
breach: assume any single guard, secret, or input filter can fail, and ask "what then?".

Your job is to FIND real, exploitable problems — not to reassure me. Skepticism is the
job. If something is safe, prove it by tracing the data flow; if you cannot prove it,
treat it as a finding. Do NOT pad the report with generic advice. Every finding must be
backed by concrete code at `file:line` and a concrete exploit path.

================================================================================
SYSTEM CONTEXT (verify against the actual repo; correct me where I'm wrong)
================================================================================
- Backend: NestJS (modular), Prisma ORM on PostgreSQL, BullMQ + Redis for jobs/queues,
  socket.io for realtime, undici for outbound HTTP, pino for logs, Prometheus metrics.
- Money: all amounts are PostgreSQL Decimal(20,8); arithmetic via decimal.js. NEVER float.
- Ledger: double-entry (DEBIT/CREDIT LedgerEntry rows, account types). Wallets track
  availableBalance / pendingBalance / reservedBalance per (companyId, currency).
- Domain: transactions, withdrawals, payouts, loads, commissions (tiered rule groups),
  reconciliation, wallets, audit logs. External payment provider integration (Whish) with
  inbound webhooks and delivery tracking.
- Multi-tenancy: almost every row is scoped by `companyId`. Tenant isolation is THE
  central invariant.
- AuthN: JWT access tokens + rotating refresh tokens (hashed, stored in DB), argon2 for
  passwords, httpOnly cookies, a CSRF guard, role-based guards (UserRole enum), and a
  Public() decorator to opt endpoints out of auth.
- Machine auth: API keys with prefix + hash, scoped as SOURCE keys vs COMPANY keys, with
  rate-limit and company-access guards.
- Frontend: Next.js (App Router) + React, TanStack Query, react-hook-form + zod.

================================================================================
METHODOLOGY — work in phases, do not skip recon
================================================================================
PHASE 0 — Map the system. Enumerate every HTTP route, websocket event, queue
  consumer, webhook handler, and cron/scheduled job. For each, record: auth guard(s)
  applied, required role/scope, whether it is Public(), what it reads/writes, and which
  tenant(s) it touches. Build this inventory FIRST; most money bugs live in the gap
  between "what the guard checks" and "what the handler actually does".

PHASE 1 — Trace the money. For every flow that creates or moves value
  (transaction ingest, commission calc, withdrawal, payout, load, reconciliation,
  wallet balance update, ledger write), follow the data end-to-end: input → validation →
  authorization → DB transaction → ledger entries → wallet mutation → response/audit.
  Prove the ledger stays balanced and the wallet math is exact at every step.

PHASE 2 — Attack each cross-cutting concern (the checklist below), per module.

PHASE 3 — Verify every candidate finding adversarially (see Rules of Engagement).
  Discard anything you cannot actually exploit; downgrade anything speculative.

PHASE 4 — Write the report.

Be exhaustive. Read the actual implementation, not just signatures — guards, Prisma
queries, service methods, DTO/zod schemas, interceptors, filters. Do NOT stop at the
first handful of issues. Trace flows to their end. Where the codebase is large, fan out
with parallel sub-agents per module, then consolidate.

================================================================================
THREAT MODEL & AUDIT CHECKLIST — hunt for ALL of these
================================================================================

1) TENANT ISOLATION / IDOR  ← highest priority
   - For EVERY query that reads or writes a tenant-owned row, confirm `companyId` (and
     for source keys, sourceId) is enforced in the WHERE clause / Prisma filter — not
     just trusted from the token after fetch. Find any `findUnique`/`findFirst`/update/
     delete keyed only by `id` with no tenant scope.
   - Can tenant A pass tenant B's resource id (transaction, wallet, withdrawal, payout,
     load, api-key, commission rule, audit log, user) and read or mutate it?
   - Is `companyId` ever taken from the request body/query/header instead of the
     authenticated principal? (Classic horizontal-privilege bug.)
   - List endpoints / search / export / analytics / reconciliation: are aggregates and
     row lists scoped per tenant, including pagination cursors and count queries?
   - Cross-tenant leakage via includes/relations, joins, or `select` that pulls related
     rows without re-scoping.
   - Websocket rooms and realtime events: is each socket bound to its tenant, and are
     broadcasts scoped so one tenant never receives another's events?

2) MONEY & LEDGER INTEGRITY
   - Double-entry: every value movement writes balanced DEBIT/CREDIT entries; sum of
     entries per transaction nets to zero; no code path mutates a wallet without a
     corresponding ledger entry (or vice versa).
   - Decimal discipline: no float/Number arithmetic on money, no `parseFloat`, no JS `+`
     on amounts, no implicit string→number coercion. Rounding is explicit, consistent,
     and applied at defined boundaries (never silently truncated). Check Decimal(20,8)
     overflow / precision-loss and currency mismatches.
   - Sign & bounds: negative, zero, NaN, Infinity, and absurdly large amounts are
     rejected at the edge. A negative withdrawal/payout/commission must be impossible.
   - Commission/fee math: tiered rules (min/max amount, open-ended top tier, priority,
     per-company × operation) — can overlapping/missing tiers, a crafted amount, or a
     boundary value (exactly min, exactly max, max=null) yield a wrong or attacker-chosen
     commission? Can a tenant influence which rule applies?
   - Balance invariants: availableBalance/pendingBalance/reservedBalance transitions are
     consistent; reserve→capture→release can't leak or double-count; available balance
     can never go negative; pending can't be spent.
   - Reconciliation can't be tricked into masking a discrepancy or "fixing" balances
     without an audit trail.

3) CONCURRENCY, IDEMPOTENCY & RACE CONDITIONS
   - Wallet/balance updates: are read-modify-write sequences inside a DB transaction with
     proper row locking (SELECT ... FOR UPDATE / atomic decrement with a guard), or is
     there a TOCTOU window where two concurrent requests both pass the balance check and
     overdraw? (Try: two simultaneous withdrawals each ≤ balance but together > balance.)
   - Idempotency keys (e.g. Transaction.idempotencyKey unique per company): is the unique
     constraint actually relied on, and are races handled (two requests, same key,
     interleaved) without creating duplicates or returning the wrong cached result?
   - State machines (withdrawal/payout/load/whish status): can a resource be approved/
     paid/settled twice? Can status be moved backwards or skipped? Is the transition
     atomic and guarded by the current status in the WHERE clause (compare-and-set), or
     is it `if (status===X) update(...)` with a gap?
   - Queue/job consumers (BullMQ): are jobs idempotent on retry? Can a redelivered or
     duplicated job double-pay or double-post to the ledger?

4) AUTHENTICATION
   - JWT: signing algorithm pinned (no `alg:none`/confusion), strong secret/keys from env
     (not defaulted/committed), short access-token TTL, audience/issuer checked,
     expiration enforced. No sensitive data in the token beyond what's needed.
   - Refresh tokens: stored hashed (not plaintext), rotated on use, with reuse detection
     (a replayed old refresh token should revoke the family). Logout/rotation actually
     invalidates. No fixed/guessable token ids.
   - Cookies: httpOnly + Secure + SameSite set correctly; host-only vs domain scoping
     sane; access/refresh cookie paths and lifetimes correct; no token in localStorage on
     the web side.
   - CSRF: the CSRF guard actually protects all state-changing, cookie-authenticated
     routes; double-submit/synchronizer logic is sound; it isn't bypassable via method
     override, content-type, or a Public() route.
   - Public() decorator: enumerate EVERY endpoint marked public and confirm none exposes
     tenant data or a state change that should be authenticated. A misplaced Public() on a
     money route is critical.
   - Password handling: argon2 params reasonable; no timing oracle on login/user-exists;
     password reset / email-change flows can't be abused for takeover; brute-force is rate
     limited and/or lockout exists.

5) AUTHORIZATION / RBAC / PRIVILEGE ESCALATION
   - RolesGuard correctness: does it fail-closed (no role metadata ⇒ deny, or is it
     accidentally allow)? Is it actually applied (globally or per route) everywhere it
     should be? Order of guards vs the Public() short-circuit.
   - Vertical escalation: can a normal company user hit admin/maintenance/admin-users/
     cross-company endpoints? Can a company-scoped user act on platform-level resources?
   - Mass assignment: can a user set/modify protected fields (role, companyId, status,
     balances, isAdmin, fee/commission overrides) by including them in a create/update
     body? Confirm DTO/zod schemas whitelist fields and the service ignores the rest.
   - Can a user create/invite a user with a higher role or in another company?

6) API KEYS / MACHINE AUTH
   - Keys stored hashed (argon2/strong), compared in constant time; only a prefix is
     queryable; the secret is shown once and never logged/returned.
   - SOURCE vs COMPANY scope is enforced on every key-authed route; a source key can't act
     as a company and vice versa; CompanyAccessGuard can't be bypassed.
   - Rate limiting per key works and can't be evaded; revoked/expired keys are rejected;
     no key leakage in logs, errors, metrics, or audit entries.

7) EXTERNAL INTEGRATIONS, WEBHOOKS & SSRF
   - Inbound webhooks (Whish & any provider): is the signature/HMAC verified on the RAW
     body (before parsing), with constant-time comparison and a configured secret? Are
     timestamps checked to prevent replay? Is processing idempotent (a redelivered webhook
     can't double-credit)? Does the handler scope effects to the correct company/payment?
   - Can a forged webhook mark a payment as PAID/settled and trigger a payout or balance
     credit? This is a critical money path — attack it hard.
   - Outbound HTTP (undici): SSRF guard — confirm it blocks private/loopback/link-local/
     metadata (169.254.169.254) ranges, handles DNS rebinding (resolve+pin or re-check
     after resolution), and does NOT follow redirects to internal hosts. Any URL that
     comes from tenant input (callback URLs, avatars, imports) must go through it.

8) INPUT VALIDATION & INJECTION
   - Every controller body/query/param validated by a zod schema (or equivalent) with
     strict types; unknown keys stripped/rejected; numeric/decimal fields bounded.
   - SQL injection: any raw SQL / `$queryRaw` / `$executeRaw` / dynamic `orderBy`/column
     names built from user input? Prisma raw with interpolation is the usual culprit.
   - NoSQL/Redis/queue injection via unvalidated keys; path traversal in any file/key
     handling; ReDoS in regexes applied to user input.
   - Frontend (Next.js): `dangerouslySetInnerHTML`, unsanitized markdown/HTML, open
     redirects, reflected values; XSS that could steal the session if cookies aren't
     httpOnly.

9) SECRETS, CONFIG & DEPLOYMENT
   - No secrets committed (.env, keys, tokens) — grep history and tracked files. .env in
     .gitignore; .env.example contains no real secrets.
   - All secrets come from env with NO insecure defaults (e.g. `process.env.JWT_SECRET ||
     'dev'`). Fail-fast if a required secret is missing in prod.
   - CORS: origin allowlist is explicit (no `*` with credentials), methods/headers minimal.
   - helmet/security headers present and correct (CSP, HSTS, no sniff, frameguard).
   - Swagger / metrics / studio / debug endpoints are disabled or auth-gated in prod.
   - Docker/compose: no privileged exposure, DB/Redis not publicly bound, least-privilege
     DB user, migrations URL separated from runtime URL.

10) LOGGING, AUDIT & PII
   - Audit log coverage: every sensitive money/admin action (approve, pay, refund, role
     change, key create/revoke, balance adjust) is audited with actor, tenant, before/
     after, and is tamper-evident / append-only. No gaps an attacker could slip through.
   - Logs/metrics/errors never contain secrets, tokens, API keys, full PAN, passwords, or
     full request bodies of money endpoints. pino redaction configured.
   - Error responses don't leak stack traces, SQL, internal ids, or existence of other
     tenants' resources (404 vs 403 distinction can be an enumeration oracle).

11) RATE LIMITING / ABUSE / DoS
   - Throttler applied to auth (login/refresh/reset), webhook, and expensive endpoints;
     Redis-backed limits can't be bypassed by changing IP/header; per-tenant and per-key
     limits exist. Unbounded list/export queries (no max page size) are a DoS + data-dump
     risk.

12) DEPENDENCIES & SUPPLY CHAIN
   - Run/inspect `pnpm audit` (or report what it would show); flag known-vulnerable or
     abandoned packages, especially in auth/crypto/parsing paths. Note any pinned-but-
     outdated security-critical deps.

13) ERROR HANDLING & FAIL STATE
   - Do guards/validation/SSRF/signature checks FAIL CLOSED on exception? An unhandled
     throw in a guard that resolves to "allow" is critical. Check the global exception
     filter doesn't accidentally 200 a failed money operation or swallow a rollback.

================================================================================
RULES OF ENGAGEMENT
================================================================================
- READ-ONLY. Do not modify code, run migrations, or hit live/staging systems. Static
  analysis + reasoning only, unless I explicitly ask for a PoC.
- NO FALSE POSITIVES. Before reporting, verify the issue is REAL and reachable: confirm
  the vulnerable code is actually on a live route/handler, the guard you think is missing
  is truly missing (not applied globally or via a parent), and the exploit input is
  actually accepted. If you're unsure, say so and mark confidence.
- For each finding, construct the concrete exploit: the request/sequence an attacker
  sends and what they gain. If you can't articulate the exploit, it's not a finding —
  move it to "hardening suggestions".
- Prefer depth over breadth of wording: one proven critical > ten vague maybes.

================================================================================
SEVERITY RUBRIC
================================================================================
CRITICAL — direct theft/loss of funds, cross-tenant money/data access or mutation,
           auth bypass, ledger corruption, double-spend, forgeable money webhook.
HIGH     — privilege escalation, idempotency/race that can be triggered, secret exposure,
           refresh-token replay, missing tenant scope on sensitive read.
MEDIUM   — info disclosure, weak crypto/config, missing rate limit on sensitive route,
           audit gaps.
LOW      — defense-in-depth, hardening, hygiene.
Rank strictly by real-world impact on money and tenant isolation.

================================================================================
OUTPUT FORMAT — write to SECURITY_AUDIT_REPORT.md
================================================================================
1. Executive summary: overall posture, count by severity, the top risks in plain language.
2. System map: the route/event/job inventory from Phase 0 (table: endpoint, auth, role/
   scope, tenant-scoped?, writes money?).
3. Findings, ordered by severity. For EACH:
   - Title, Severity, Confidence (High/Med/Low)
   - Location: `file:line` (and the exact code snippet)
   - Affected flow / data
   - Exploit scenario: concrete steps an attacker takes and what they gain
   - Why it works (root cause)
   - Concrete fix: the specific code/config change (show the corrected pattern)
4. Money-integrity attestation: for each value-moving flow, state whether you could prove
   the ledger stays balanced and tenant isolation holds — and exactly where you couldn't.
5. Prioritized remediation plan: ordered, with effort estimate.
6. What you did NOT cover and why (so the gaps are explicit, not silent).

Begin with Phase 0 now. Show me the system map before going deep, then proceed.
```

---

## How to use it

1. Open Claude Code (or your agent) **in the root of the twin project**.
2. Paste the block above as your first message.
3. Let it produce the Phase 0 system map, sanity-check that the route inventory looks complete, then let it go deep.
4. The findings land in `SECURITY_AUDIT_REPORT.md`.

## Tips to make it even more powerful

- Run it on a **clean checkout of the exact commit** you intend to ship.
- After the report, ask: _"Now write failing tests that reproduce each CRITICAL and HIGH finding."_ — turns claims into proof.
- For a money system, also run a focused second pass: _"Ignore everything except tenant isolation and ledger/balance integrity. Re-audit only those two, as deeply as possible."_ Depth beats breadth on the two invariants that can lose money.
- If the repo is large, tell it explicitly: _"Fan out one sub-agent per module, then consolidate"_ — it parallelizes and misses less.
