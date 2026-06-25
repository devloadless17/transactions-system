# Rival Payments — Companies Integration Guide

**Audience:** the technical / developer team of a company on the Rival Payments platform.

This is the single reference for integrating your own systems (CRM, back office, reconciliation) with Rival Payments using a **company API key**. It covers everything you can do programmatically — query transactions, manage loads / withdrawals / payouts, read balances and the ledger, and collect Whish payments — plus the **CRM webhooks** Rival pushes to you when a deposit or withdrawal's status changes.

> **Sources, read elsewhere.** If you are a transaction _source_ (a provider such as Whish, OMT, or a bank) that pushes transactions _into_ the platform, this document is not for you — see the separate **Sources Integration Guide** (`sources-integration-docs.md`). The ingest API is intentionally out of scope here.

|                    |                                                                 |
| ------------------ | --------------------------------------------------------------- |
| **Base URL**       | `https://portal.rivalpayments.com/v1`                           |
| **Protocol**       | HTTPS only                                                      |
| **Content type**   | `application/json` (request and response), UTF-8                |
| **Authentication** | `Authorization: Bearer tsk_<prefix>_<secret>` (company API key) |

## Contents

- [Getting Started, Conventions & Authentication](#getting-started-conventions--authentication)
- [Company Transactions (query & status)](#company-transactions-query--status)
- [Loads (Wallet Top-Ups)](#loads-wallet-top-ups)
- [Withdrawals & Payouts (Money Out)](#withdrawals--payouts-money-out)
- [Wallets, Ledger & Activity Feed](#wallets-ledger--activity-feed)
- [Whish Payment Collection](#whish-payment-collection)
- [Outbound CRM Notifications (Webhooks)](#outbound-crm-notifications-webhooks)

---

## Getting Started, Conventions & Authentication

This is the canonical reference for the Transactions System HTTP API. Every other section assumes the conventions defined here (base URL, response envelope, error codes, money format, pagination, auth).

### Base URL & versioning

Every route lives under a global prefix, `/v1` (configurable via `API_GLOBAL_PREFIX`, default `v1`). Throughout this guide the literal placeholder `https://portal.rivalpayments.com/v1` means the origin **plus** the version prefix:

```
https://portal.rivalpayments.com/v1 = https://api.<your-domain>/v1
```

So `https://portal.rivalpayments.com/v1/company/wallets` resolves to `https://api.<your-domain>/v1/company/wallets`.

Two operational paths are deliberately mounted at the **root**, not under `/v1`: `/metrics` (Prometheus, bearer-token protected when `METRICS_TOKEN` is set) and `/docs` + `/docs-json` (Swagger UI, non-production only). You will not integrate against these.

- Request/response bodies are JSON; `Content-Type: application/json` is required on writes.
- Max request body size is **256 KB**; larger bodies are rejected by the body parser.
- CORS is an explicit allowlist (`ALLOWED_ORIGINS`); server-to-server API-key calls are unaffected by CORS.

### The response envelope

Every JSON response carries the same top-level shape so you can branch on `success` and read `statusCode` straight from the body.

**Success** — handler payload under `data`:

```json
{
  "success": true,
  "statusCode": 200,
  "data": { "...": "endpoint payload" }
}
```

**Error** — error object under `error`:

```json
{
  "success": false,
  "statusCode": 404,
  "error": {
    "code": "NOT_FOUND",
    "message": "ApiKey 3f2b... not found",
    "details": { "entity": "ApiKey", "id": "3f2b..." }
  }
}
```

`success` is the discriminant: a success body never has `error`; an error body never has `data`. `details` is optional and its shape depends on the code (see below).

**Status codes:** `POST` returns **201**, every other verb returns **200**, unless the handler overrides it. The `statusCode` in the body always equals the HTTP status line.

**List endpoints** put `{ data: [...], meta }` _inside_ the envelope's `data`, so the array is at **`data.data`** and pagination metadata at **`data.meta`** (see [Pagination](#pagination)).

**Envelope-exempt responses** (no `success` wrapper): CSV exports, the `/metrics` and health probes, any `204 No Content`, and inbound provider acknowledgement responses. These return their raw body.

### Error codes

All errors share the `{ success:false, statusCode, error:{ code, message, details? } }` shape. The `code` is stable; integrate against it (not the `message`, which may change).

| Code                   | HTTP   | When / `details`                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`     | 400    | Request body/query failed Zod validation. `details` is the raw array of Zod issues (`[{ code, path, message, ... }]`). Also returned for invalid DB query input.                                                                                                                                                                                         |
| `BAD_REQUEST`          | 400    | Generic 400 from a framework `HttpException` not mapped to a domain code.                                                                                                                                                                                                                                                                                |
| `UNAUTHORIZED`         | 401    | Missing/invalid/revoked/expired API key or session.                                                                                                                                                                                                                                                                                                      |
| `FORBIDDEN`            | 403    | Authenticated, but not allowed for this resource or action (e.g. a failing CSRF check on a session write). Tenant isolation never surfaces here — another company's data simply doesn't exist for your key.                                                                                                                                              |
| `NOT_FOUND`            | 404    | Entity missing. Domain `details`: `{ entity, id }`. Prisma `P2025` → bare `NOT_FOUND` (`Record not found`, no `details`).                                                                                                                                                                                                                                |
| `CONFLICT`             | 409    | Unique/FK/state conflict. Prisma `P2002` → `details.target`; `P2003` → `details.field`.                                                                                                                                                                                                                                                                  |
| `WRITE_CONFLICT`       | 409    | Serializable write conflict / deadlock (Prisma `P2034`). **Safe to retry** the same request.                                                                                                                                                                                                                                                             |
| `INSUFFICIENT_BALANCE` | 409    | Not enough available balance for amount (+fee). `details`: `{ currency, required, available, shortfall }`.                                                                                                                                                                                                                                               |
| domain 422 codes       | 422    | Semantically invalid request that passed schema validation — surfaced with a **domain code**, e.g. `NO_COMMISSION_RULE` (`details: { companyId, sourceId, amount }`) or `COMMISSION_EXCEEDS_AMOUNT` (`details: { ruleId, amount, commission }`). The bare `UNPROCESSABLE` code only appears as a fallback for a framework `HttpException` raised at 422. |
| `RATE_LIMITED`         | 429    | Rate limit exceeded (see [Rate limits](#rate-limits)).                                                                                                                                                                                                                                                                                                   |
| `INTERNAL_ERROR`       | 500    | Unexpected server error. Internals are never leaked in `message`.                                                                                                                                                                                                                                                                                        |
| `DB_<code>`            | 400    | Unmapped known Prisma error; surfaces the Prisma code (e.g. `DB_P2000`) but no internals.                                                                                                                                                                                                                                                                |
| `HTTP_<status>`        | varies | Framework `HttpException` at a status with no named mapping.                                                                                                                                                                                                                                                                                             |

Domain-specific codes (e.g. balance/whish/withdrawal flows) are documented in their own sections.

Example validation error:

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "code": "invalid_string", "path": ["amount"], "message": "must be a positive decimal" }
    ]
  }
}
```

### Money & currencies

Monetary amounts are **decimal strings, never floats** (e.g. `"100.50"`), validated by `moneyAmountSchema`:

- Pattern `^\d+(\.\d+)?$` — non-negative decimal, no sign, no exponent, no thousands separators.
- At most **8 fractional digits** and at most **12 integer digits** (matches the ledger's `Decimal(20,8)` columns).

Always send and parse amounts as strings to avoid floating-point drift.

| Field      | Type             | Req | Notes                                                                                           |
| ---------- | ---------------- | --- | ----------------------------------------------------------------------------------------------- |
| `amount`   | string (decimal) | yes | e.g. `"250.00"`. Max 12 int + 8 frac digits.                                                    |
| `currency` | enum             | yes | Validated by `currencySchema`. **Supported values: `USD` only** today (`SUPPORTED_CURRENCIES`). |

Timestamps are ISO-8601 strings (e.g. `"2026-06-22T14:05:00.000Z"`).

### Pagination

List endpoints that paginate accept `page` and `pageSize` as query params and return a `PaginatedResponse`:

| Param      | Type          | Req | Default | Notes                                                                                     |
| ---------- | ------------- | --- | ------- | ----------------------------------------------------------------------------------------- |
| `page`     | integer ≥ 1   | no  | `1`     | Coerced from string.                                                                      |
| `pageSize` | integer 1–100 | no  | `20`    | **Hard max 100** (`paginationSchema`). Values > 100 are rejected with `VALIDATION_ERROR`. |

Response payload (inside the envelope's `data`):

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [{ "...": "item" }],
    "meta": { "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 }
  }
}
```

Note: not every list endpoint is paginated — some (e.g. API-key listing) return a plain `{ data: [...] }` with no `meta` and no cap. Each section states which shape an endpoint uses.

### Idempotency

There is **no global `Idempotency-Key` header**. Idempotency is per-flow and expressed in the request body where supported — for example, **Whish payment creation** accepts an optional `idempotencyKey` (8–120 chars) and de-duplicates on it, so a retried create returns the original payment rather than a second one. Send a stable key per logical operation so retries (including after a `WRITE_CONFLICT`) don't double-create. Each section notes where an idempotency field is available. Endpoints without one are not safe to blindly retry on an ambiguous failure — except `WRITE_CONFLICT` (409), which is always retry-safe.

### Rate limits

There are two independent limiters:

**1. Global per-IP throttler** (`ThrottlerGuard`, Redis-backed, shared across instances) — applies to session/most routes.

- Default **`RATE_LIMIT_MAX` = 100 requests / `RATE_LIMIT_TTL` = 60s** per IP.
- Auth routes are stricter via per-route overrides: **login = 10/60s**, **token refresh = 30/60s**.
- Fails **open** if Redis is down (no limit rather than locking everyone out).

**2. Per-API-key limiter** (`ApiKeyRateLimitGuard`) — applies to the `integrations/whish` endpoints, keyed on the API key (not IP), so one high-volume integration behind a single IP isn't capped by the per-IP limiter.

- **300 requests / 60s** per key (`MAX_PER_WINDOW = 300`, `WINDOW_SECONDS = 60`), fixed-window.
- Fails **open** if Redis is unavailable.

Both emit HTTP **429** with `error.code = "RATE_LIMITED"`. The per-key limiter returns the standard flat envelope, with the limit in `error.details`:

```json
{
  "success": false,
  "statusCode": 429,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded: 300 requests per 60s",
    "details": { "limit": 300, "windowSeconds": 60 }
  }
}
```

The per-key limiter also sets standard headers on **every** response so you can self-pace: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until the window resets), plus `Retry-After` (seconds) on a 429. The **global per-IP** throttler's 429 is the default NestJS `ThrottlerException` and does not carry these details/headers — back off using the documented 60s window.

### Authentication & API keys

Most programmatic integration uses **API keys** sent as a Bearer token:

```
Authorization: Bearer tsk_<prefix>_<secret>
```

Key format: `tsk_<prefix>_<secret>` — `tsk` product tag, an 8-char lookup prefix (from a fixed unambiguous alphabet), then a 64-hex-char secret. The full plaintext is shown **once, at creation/rotation** (`plaintext` field) and is stored only as an argon2id hash; the platform can never show it again. The 8-char `keyPrefix` is stored and returned for identification.

Your integration uses a **company API key**, scoped to your company (tenant):

| Auth header      | Can call                                      | Notes                                                                                                          |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Bearer tsk_...` | All `company/*` endpoints                     | The same endpoints the dashboard uses (`CompanyAccessGuard` accepts a company key **or** a dashboard session). |
| `Bearer tsk_...` | `integrations/whish` (server-to-server Whish) | Company API key **only** — a browser session is not accepted here.                                             |

Rules and trust model:

- A **company key is scoped to exactly one company** (tenant). It can only ever read or act on that company's own data — isolation is enforced at the database layer (row-level security), not just in application code.
- **API-key requests skip CSRF** (no `x-csrf-token` needed) — CSRF only applies to cookie/session calls from the web app.
- A request authenticates as an API key whenever the `Authorization` header starts with `Bearer tsk_`; otherwise the cookie-session path is used.
- Keys can carry an optional expiry; expired or revoked keys verify as `UNAUTHORIZED`.

**Authenticated request example:**

```bash
curl "https://portal.rivalpayments.com/v1/company/wallets" \
  -H "Authorization: Bearer tsk_A7K3M9PQ_3f2c...secret"
```

A missing, invalid, expired, or revoked key returns:

```json
{
  "success": false,
  "statusCode": 401,
  "error": { "code": "UNAUTHORIZED", "message": "Invalid or revoked API key" }
}
```

#### Creating, rotating & revoking keys

API keys are created in three ways. All mint routes return `CreateApiKeyResponse` = `{ apiKey, plaintext }`; the `plaintext` is the only time you see the full key. Management (`create`/`rotate`/`revoke`) requires a **dashboard session** (cookie + CSRF), not an API key.

| Action             | Endpoint                               | Who                          | Notes                                                             |
| ------------------ | -------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| List company keys  | `GET /v1/company/api-keys`             | Company owner **or** manager | Self-serve. Returns `{ data: [ApiKeyResponse] }` (no pagination). |
| Create company key | `POST /v1/company/api-keys`            | Company **owner**            | Body `{ name, expiresAt? }`.                                      |
| Rotate company key | `POST /v1/company/api-keys/:id/rotate` | Company **owner**            | Mints a new key inheriting name+expiry, revokes the old.          |
| Revoke company key | `POST /v1/company/api-keys/:id/revoke` | Company **owner**            | Idempotent.                                                       |

In the dashboard, your keys are managed under the **API Keys** screen — the company owner can create, rotate, and revoke; managers can view.

**Create body (`createApiKeySchema`):**

| Field       | Type                       | Req | Notes                                                                              |
| ----------- | -------------------------- | --- | ---------------------------------------------------------------------------------- |
| `name`      | string                     | yes | Trimmed, **2–80 chars**. Must be unique per company among live (non-revoked) keys. |
| `expiresAt` | string (ISO-8601 datetime) | no  | Omit for a non-expiring key.                                                       |

**`ApiKeyResponse` fields** (returned by list and inside `apiKey`):

| Field        | Type              | Notes                                                      |
| ------------ | ----------------- | ---------------------------------------------------------- |
| `id`         | string (uuid)     | Use in rotate/revoke URLs.                                 |
| `name`       | string            |                                                            |
| `keyPrefix`  | string            | 8-char prefix; identifies the key (secret never returned). |
| `createdAt`  | string (ISO-8601) |                                                            |
| `lastUsedAt` | string \| null    | Best-effort, updated on successful auth.                   |
| `expiresAt`  | string \| null    |                                                            |
| `revokedAt`  | string \| null    | Set once revoked; key stops authenticating.                |

**Rotation** is the zero-downtime swap: deploy the new key first, then call rotate — the old key keeps working until the call returns and revokes it (the old key is renamed `<name> (rotated:<id8>)` to free the unique name).

```bash
# Create a company key (dashboard session: cookie + CSRF)
curl -X POST "https://portal.rivalpayments.com/v1/company/api-keys" \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: <token>" \
  --cookie "txn_access=<session>" \
  -d '{ "name": "crm-prod", "expiresAt": "2027-01-01T00:00:00.000Z" }'
```

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "apiKey": {
      "id": "9a2e...",
      "name": "crm-prod",
      "keyPrefix": "A7K3M9PQ",
      "createdAt": "2026-06-22T14:05:00.000Z",
      "lastUsedAt": null,
      "expiresAt": "2027-01-01T00:00:00.000Z",
      "revokedAt": null
    },
    "plaintext": "tsk_A7K3M9PQ_3f2c...64hex...secret"
  }
}
```

Store `plaintext` immediately — it is never retrievable again.

---

## Company Transactions (query & status)

Read-only endpoints for a company to query the transactions ingested against it by your sources, inspect a single transaction (optionally with its full double-entry ledger trail), and export the filtered set as CSV. All endpoints below are callable with a **company API key** (`Authorization: Bearer tsk_...`) or a dashboard session.

The key is bound to one company; the server forces every query to that company's tenant scope. The `companyId` query parameter (below) is **admin-only** and is silently ignored for company-key callers — you only ever see your own transactions.

Unlike the ingest responses (which deliberately hide the platform fee), these company-facing responses **do** include `commissionAmount` and `netAmount`: that is your money, so you are entitled to see the fee taken and the net you were credited.

> Reversing a transaction is an **admin-only** action (`POST /admin/transactions/:id/reverse`, roles `SUPER_ADMIN`/`ADMIN_OPERATOR`, requires a dashboard session + CSRF). A company API key **cannot** reverse — there is no `company/transactions/:id/reverse` route, and the admin route rejects company principals with `403 FORBIDDEN`. A transaction you ingested can only move to `REVERSED` via platform staff.

### `TransactionResponse` fields

Returned by the list, get-one, and (nested under `transaction`) the detail endpoint.

| Field                   | Type             | Notes                                                                                       |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `id`                    | string (uuid)    | Platform transaction id. Use this in the get-one / detail URLs.                             |
| `companyId`             | string (uuid)    | Always your company.                                                                        |
| `sourceId`              | string (uuid)    | The source that ingested it. Use as the `sourceId` list filter.                             |
| `sourceCode`            | string           | Human-readable source code (e.g. the provider short code).                                  |
| `externalTransactionId` | string           | The id your source supplied at ingest. Target of the `search` filter.                       |
| `amount`                | string (decimal) | Gross amount as ingested. Decimal string, up to 8 dp. Never a float.                        |
| `commissionAmount`      | string (decimal) | Platform fee applied. `"0"` when no rule matched.                                           |
| `netAmount`             | string (decimal) | Amount credited to your available balance (gross − fee for `DEDUCTED`; gross for `ON_TOP`). |
| `currency`              | string           | ISO-4217, 3 chars. Currently only `USD` is supported.                                       |
| `status`                | enum             | See lifecycle below.                                                                        |
| `customer`              | string \| null   | Lifted from the ingest `payload.customer`. `null` if not provided.                          |
| `target`                | string \| null   | Lifted from `payload.target` (the trading account / payee). `null` if absent.               |
| `phone`                 | string \| null   | From `payload.phone`. `null` if absent.                                                     |
| `note`                  | string \| null   | From `payload.note`. `null` if absent.                                                      |
| `processedAt`           | string \| null   | ISO-8601 timestamp when booked (set at ingest). `null` if not yet processed.                |
| `createdAt`             | string           | ISO-8601 row-creation timestamp. Also the list sort key (desc).                             |

The **detail** endpoint adds two fields inside `transaction` and a `ledgerEntries` array:

| Field                         | Type             | Notes                                                                                                               |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `transaction.payload`         | object \| null   | The full raw ingest payload (typed `customer`/`target`/`phone`/`note` plus any provider-specific passthrough keys). |
| `transaction.idempotencyKey`  | string \| null   | The idempotency key supplied at ingest, if any.                                                                     |
| `ledgerEntries[]`             | array            | The balanced double-entry trail for this transaction (see fields below).                                            |
| `ledgerEntries[].id`          | string (uuid)    |                                                                                                                     |
| `ledgerEntries[].accountType` | string           | One of `AVAILABLE`, `PENDING`, `RESERVED`, `FEE`, `EXTERNAL`, `RECEIVABLE`.                                         |
| `ledgerEntries[].direction`   | string           | `DEBIT` or `CREDIT`.                                                                                                |
| `ledgerEntries[].amount`      | string (decimal) |                                                                                                                     |
| `ledgerEntries[].currency`    | string           | 3-char ISO-4217.                                                                                                    |
| `ledgerEntries[].metadata`    | object \| null   | Free-form; e.g. `{ "kind": "reversal", "reason": "..." }` on reversal entries.                                      |
| `ledgerEntries[].createdAt`   | string           | ISO-8601, sorted ascending.                                                                                         |

### Status lifecycle

`status` is one of: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REVERSED`, `REFUNDED`.

In practice for source-ingested transactions:

- A transaction is created already **`COMPLETED`** (ingest is atomic: row + ledger + wallet credit in one serializable transaction).
- An admin reversal moves a `COMPLETED` transaction to **`REVERSED`** (writes compensating ledger entries; reversal is idempotent). Only `COMPLETED` can be reversed.
- `PENDING` / `PROCESSING` / `FAILED` / `REFUNDED` exist in the enum but are not produced by the ingest flow today; treat them as forward-compatible values you may receive in the future and avoid hard-coding an exhaustive switch that throws on the others.

---

### `GET /company/transactions`

List your transactions, newest first, with filters and offset pagination.

**Query parameters** (all optional):

| Field       | Type                       | Req | Notes                                                                                                 |
| ----------- | -------------------------- | --- | ----------------------------------------------------------------------------------------------------- |
| `page`      | int ≥ 1                    | No  | Default `1`.                                                                                          |
| `pageSize`  | int 1–100                  | No  | Default `20`. Hard cap 100.                                                                           |
| `status`    | enum                       | No  | Filter by `TransactionStatus` (see above).                                                            |
| `sourceId`  | string (uuid)              | No  | Filter by source.                                                                                     |
| `currency`  | enum                       | No  | `USD`.                                                                                                |
| `from`      | string (ISO-8601 datetime) | No  | `createdAt >= from`. Must be a full RFC-3339 datetime (e.g. `2026-06-01T00:00:00Z`), not a bare date. |
| `to`        | string (ISO-8601 datetime) | No  | `createdAt <= to`.                                                                                    |
| `search`    | string ≤ 200               | No  | Substring match on `externalTransactionId`.                                                           |
| `companyId` | string (uuid)              | No  | **Admin-only.** Ignored for company keys (always scoped to your company).                             |

The response is the standard envelope wrapping a paginated body, so the rows live at `data.data` and the page metadata at `data.meta`.

**Pagination cap:** offset paging is capped — once `(page-1) × pageSize` exceeds 100,000 the request fails with `400 VALIDATION_ERROR` ("Page too deep…"). Narrow with filters or use the CSV export for bulk extraction.

```bash
curl -s "https://portal.rivalpayments.com/v1/company/transactions?status=COMPLETED&pageSize=2&from=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "id": "8b1f0e2a-1c3d-4f5a-9b6c-7d8e9f0a1b2c",
        "companyId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "sourceId": "a1b2c3d4-e5f6-4789-9abc-def012345678",
        "sourceCode": "WHISH",
        "externalTransactionId": "WX-2026-0001",
        "amount": "100.00000000",
        "currency": "USD",
        "commissionAmount": "2.50000000",
        "netAmount": "97.50000000",
        "status": "COMPLETED",
        "customer": "Jane Doe",
        "target": "ACCT-7781",
        "phone": "+9613000000",
        "note": null,
        "processedAt": "2026-06-20T14:02:11.000Z",
        "createdAt": "2026-06-20T14:02:11.000Z"
      }
    ],
    "meta": { "page": 1, "pageSize": 2, "total": 134, "totalPages": 67 }
  }
}
```

Error — page too deep:

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Page too deep to scan efficiently. Narrow the results with filters (date range, status, source) or use Export CSV."
  }
}
```

Error — bad filter value (zod issues in `details`):

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": ["from"], "message": "Invalid datetime" }]
  }
}
```

### `GET /company/transactions/:id`

Fetch a single transaction by its platform `id` (a UUID). Returns a `TransactionResponse`.

```bash
curl -s "https://portal.rivalpayments.com/v1/company/transactions/8b1f0e2a-1c3d-4f5a-9b6c-7d8e9f0a1b2c" \
  -H "Authorization: Bearer tsk_live_xxx"
```

A transaction that doesn't exist **or belongs to another company** returns the same `404` (cross-tenant ids are indistinguishable from non-existent ones — no tenant leakage):

```json
{
  "success": false,
  "statusCode": 404,
  "error": {
    "code": "NOT_FOUND",
    "message": "Transaction 8b1f0e2a-1c3d-4f5a-9b6c-7d8e9f0a1b2c not found"
  }
}
```

A malformed (non-UUID) `:id` is rejected by the path pipe with `400` (code `BAD_REQUEST`) before reaching the handler — note this is **not** a `VALIDATION_ERROR` (that code is reserved for zod query-param failures and the page-too-deep cap).

### `GET /company/transactions/:id/detail`

Same as get-one but also returns the raw ingest `payload`, `idempotencyKey`, and the full `ledgerEntries` double-entry trail (see the detail fields table above). Use this to audit how a transaction was booked.

```bash
curl -s "https://portal.rivalpayments.com/v1/company/transactions/8b1f0e2a-1c3d-4f5a-9b6c-7d8e9f0a1b2c/detail" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "transaction": {
      "id": "8b1f0e2a-1c3d-4f5a-9b6c-7d8e9f0a1b2c",
      "companyId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "sourceId": "a1b2c3d4-e5f6-4789-9abc-def012345678",
      "sourceCode": "WHISH",
      "externalTransactionId": "WX-2026-0001",
      "amount": "100.00000000",
      "currency": "USD",
      "commissionAmount": "2.50000000",
      "netAmount": "97.50000000",
      "status": "COMPLETED",
      "customer": "Jane Doe",
      "target": "ACCT-7781",
      "phone": "+9613000000",
      "note": null,
      "processedAt": "2026-06-20T14:02:11.000Z",
      "createdAt": "2026-06-20T14:02:11.000Z",
      "payload": {
        "customer": "Jane Doe",
        "target": "ACCT-7781",
        "phone": "+9613000000",
        "branch": "BEY-01"
      },
      "idempotencyKey": "wx-2026-0001-abc123"
    },
    "ledgerEntries": [
      {
        "id": "…",
        "accountType": "EXTERNAL",
        "direction": "DEBIT",
        "amount": "100.00000000",
        "currency": "USD",
        "metadata": null,
        "createdAt": "2026-06-20T14:02:11.000Z"
      },
      {
        "id": "…",
        "accountType": "AVAILABLE",
        "direction": "CREDIT",
        "amount": "97.50000000",
        "currency": "USD",
        "metadata": null,
        "createdAt": "2026-06-20T14:02:11.000Z"
      },
      {
        "id": "…",
        "accountType": "FEE",
        "direction": "CREDIT",
        "amount": "2.50000000",
        "currency": "USD",
        "metadata": null,
        "createdAt": "2026-06-20T14:02:11.000Z"
      }
    ]
  }
}
```

### `GET /company/transactions/export.csv`

Stream **all** matching transactions as CSV (no row cap; streamed in keyset chunks). Accepts the **same query parameters** as the list endpoint (`status`, `sourceId`, `currency`, `from`, `to`, `search`; `page`/`pageSize` are accepted/validated but ignored — the export is not paginated, and the page-too-deep cap does not apply). This endpoint is exempt from the JSON envelope: on success you get a raw `text/csv` body with `Content-Disposition: attachment`. Errors (e.g. validation) still return the JSON error envelope.

Columns (header row): `id, created_at, company_id, source_code, external_transaction_id, amount, currency, commission_amount, net_amount, status, customer, target, phone, note`. User-derived cells are CSV-escaped and formula-injection–neutralized.

```bash
curl -s "https://portal.rivalpayments.com/v1/company/transactions/export.csv?status=COMPLETED&from=2026-06-01T00:00:00Z" \
  -H "Authorization: Bearer tsk_live_xxx" -o transactions.csv
```

### Errors & limits (all endpoints)

| Status | Code               | When                                                                               |
| ------ | ------------------ | ---------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Bad query param (zod issues in `details`), or page-too-deep.                       |
| 400    | `BAD_REQUEST`      | Malformed (non-UUID) `:id` rejected by the path pipe.                              |
| 401    | `UNAUTHORIZED`     | Missing/invalid/revoked key, or a **source** key used here (company key required). |
| 403    | `FORBIDDEN`        | Session without a company; or attempting the admin-only reverse route.             |
| 404    | `NOT_FOUND`        | Unknown id, or an id belonging to another company.                                 |
| 429    | `RATE_LIMITED`     | Per-IP throttle exceeded (`RATE_LIMIT_MAX`, default 100 per `RATE_LIMIT_TTL`).     |

> Note: these company endpoints use the **global per-IP** `ThrottlerGuard`, not the per-API-key ingest limiter. If you call from a single static egress IP at high volume you share that IP's budget across all your concurrent requests.

---

## Loads (Wallet Top-Ups)

A **Load** is how a company adds funds to its own wallet (money **in**). The company files a load request describing the amount and how the money was sent; an operator later confirms the funds actually arrived and **approves** it, which credits the wallet. An optional platform fee may be taken on approval.

> Loads are the inbound sibling of [Withdrawals/Payouts](#). They reuse the same `payoutDetails` shape and the same shared status enum, but here the `payout` block records **how the money arrived** (the Whish phone it was sent from, the crypto tx network/address, a cash drop, etc.), not where it is going.

### Lifecycle & wallet effects

```
                approve (operator)        ┌── COMPLETED  (wallet credited net; fee → platform)
  request ──▶ PENDING ──────────────────▶─┤
  (company)                               ├── REJECTED   (operator; nothing moved)
                                          └── CANCELLED  (company; nothing moved)
```

| Transition  | Who                      | Wallet / ledger effect                                                                                                                                        |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **request** | Company key or dashboard | None. Row is persisted `PENDING`. The fee is only **previewed** (`feeAmount`/`netAmount` are stored) — no money moves because the funds have not arrived yet. |
| **approve** | Operator only            | `available` is credited the **net** (`netAmount`); the fee is credited to the platform FEE account; `EXTERNAL` is debited the gross. Status → `COMPLETED`.    |
| **reject**  | Operator only            | Pure status change → `REJECTED`. Nothing was reserved, so nothing is released.                                                                                |
| **cancel**  | Company key or dashboard | Pure status change → `CANCELLED`. Only allowed while `PENDING`.                                                                                               |

Only **`PENDING`** loads can be approved, rejected, or cancelled. Acting on a load in any other status returns `409 CONFLICT`.

> Note: the `status` field is the shared withdrawal/payout enum (`PENDING`, `APPROVED`, `REJECTED`, `PROCESSING`, `COMPLETED`, `CANCELLED`), but a Load only ever reaches **`PENDING`, `COMPLETED`, `REJECTED`, or `CANCELLED`**. `APPROVED` and `PROCESSING` never occur for loads — approval goes straight to `COMPLETED`. Do not branch on `APPROVED` for loads.

### Fee & net behavior

The fee is resolved from the company's commission rules for `operationType = LOAD`. **No rule means free** (`feeAmount` = `"0"`). The response always exposes the full breakdown:

| Field            | Meaning                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `amount`         | The figure the company requested.                                                                                       |
| `feeApplication` | `DEDUCTED` (fee comes out of `amount`) or `ON_TOP` (fee added on top of `amount`).                                      |
| `feeAmount`      | The platform fee.                                                                                                       |
| `netAmount`      | What lands in the wallet on approval. `DEDUCTED` → `amount − fee`; `ON_TOP` → `amount`.                                 |
| `totalAmount`    | The money that actually moves = `netAmount + feeAmount`. Equals `amount` for `DEDUCTED`; exceeds `amount` for `ON_TOP`. |

Unlike the ingest boundary, the load endpoints **do** expose `feeAmount`/`netAmount` to a company key — this is correct, because the company is the party paying the fee on its own top-up.

---

### What a company API key can call

A company API key authenticates as a surrogate `COMPANY_OWNER`, so it can drive the full self-service lifecycle: **request, list, get, cancel**. It **cannot** approve or reject (operator-only) and cannot call the super-admin direct-load endpoint — those return `403 FORBIDDEN`.

| Action                | Method & path                                                                  | Company key?                    |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Request a load        | `POST https://portal.rivalpayments.com/v1/company/loads`                       | Yes                             |
| List loads            | `GET https://portal.rivalpayments.com/v1/company/loads`                        | Yes                             |
| Get one load          | `GET https://portal.rivalpayments.com/v1/company/loads/:id`                    | Yes                             |
| Cancel a pending load | `POST https://portal.rivalpayments.com/v1/company/loads/:id/cancel`            | Yes                             |
| Approve / reject      | `POST https://portal.rivalpayments.com/v1/admin/loads/:id/approve` · `/reject` | **No — operator only (403)**    |
| Direct admin load     | `POST https://portal.rivalpayments.com/v1/admin/loads`                         | **No — super-admin only (403)** |

---

### `POST https://portal.rivalpayments.com/v1/company/loads` — Request a load

Files a `PENDING` top-up request. Returns `201` with the persisted load including the fee preview.

**Request body** (`createLoadSchema`):

| Field      | Type             | Req | Notes                                                                                                                                          |
| ---------- | ---------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount`   | string (decimal) | yes | Non-negative decimal string, ≤ 12 integer + ≤ 8 fractional digits. Must be > 0 after rounding to 8 dp.                                         |
| `currency` | string           | yes | Enum; currently only `"USD"`.                                                                                                                  |
| `notes`    | string           | no  | Trimmed, ≤ 500 chars.                                                                                                                          |
| `payout`   | object           | yes | **How the money arrived.** Discriminated on `method`; only `CASH`, `WISH`, `CRYPTO` accepted on create (`BANK_TRANSFER`/`OTHER` are rejected). |

`payout` fields by `method`:

| method   | Required                                         | Optional                                       |
| -------- | ------------------------------------------------ | ---------------------------------------------- |
| `CASH`   | `recipientName` (2–120), `recipientPhone` (4–30) | `pickupLocation` (≤200), `instructions` (≤500) |
| `WISH`   | `recipientName` (2–120), `recipientPhone` (4–30) | `instructions` (≤500)                          |
| `CRYPTO` | `network` (2–40), `walletAddress` (20–200)       | `memo` (≤120), `instructions` (≤500)           |

```bash
curl -X POST "https://portal.rivalpayments.com/v1/company/loads" \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "1000.00",
    "currency": "USD",
    "notes": "Sent via Whish from +9613XXXXXX",
    "payout": {
      "method": "WISH",
      "recipientName": "Acme Treasury",
      "recipientPhone": "+9613000000"
    }
  }'
```

**`201` success** (example assumes a 2% `DEDUCTED` load fee):

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "b3f1c2a8-0d4e-4c1a-9f2b-7e6d5c4b3a21",
    "companyId": "11111111-2222-3333-4444-555555555555",
    "amount": "1000.00",
    "currency": "USD",
    "feeAmount": "20.00",
    "feeApplication": "DEDUCTED",
    "netAmount": "980.00",
    "totalAmount": "1000.00",
    "status": "PENDING",
    "payoutMethod": "WISH",
    "payoutDetails": {
      "method": "WISH",
      "recipientName": "Acme Treasury",
      "recipientPhone": "+9613000000"
    },
    "externalReference": null,
    "requestedById": null,
    "approvedById": null,
    "notes": "Sent via Whish from +9613XXXXXX",
    "processedAt": null,
    "createdAt": "2026-06-22T10:15:00.000Z",
    "updatedAt": "2026-06-22T10:15:00.000Z"
  }
}
```

> For API-key callers `requestedById` is `null` (the key is not a user row); the key id is recorded internally in metadata, not exposed here.

**`400` validation error** (e.g. unsupported `payout.method`):

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "path": ["payout"],
        "message": "Invalid discriminator value. Expected 'CASH' | 'WISH' | 'CRYPTO'"
      }
    ]
  }
}
```

> `details` is the raw array of zod issues (each carries `code`, `path`, `message`, and possibly extra fields like `options`); the example above is trimmed to the load-bearing keys.

---

### `GET https://portal.rivalpayments.com/v1/company/loads` — List loads

Returns the calling company's loads, newest first, paginated. Always scoped to the caller's company (the `companyId` query param is ignored for company keys).

**Query params** (`listLoadsQuerySchema`):

| Field          | Type     | Req | Notes                                                                              |
| -------------- | -------- | --- | ---------------------------------------------------------------------------------- |
| `page`         | int      | no  | Default `1`, min `1`.                                                              |
| `pageSize`     | int      | no  | Default `20`, **max `100`** (capped).                                              |
| `status`       | enum     | no  | `PENDING` \| `COMPLETED` \| `REJECTED` \| `CANCELLED` (others never match a load). |
| `currency`     | string   | no  | Enum; e.g. `USD`.                                                                  |
| `payoutMethod` | enum     | no  | `CASH` \| `WISH` \| `CRYPTO` \| `BANK_TRANSFER` \| `OTHER`.                        |
| `from` / `to`  | ISO-8601 | no  | Filters on request (`createdAt`) time.                                             |

```bash
curl "https://portal.rivalpayments.com/v1/company/loads?status=PENDING&pageSize=20" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [{ "id": "b3f1c2a8-...", "status": "PENDING", "amount": "1000.00", "...": "..." }],
    "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
  }
}
```

> The list rows are at `data.data`; pagination is at `data.meta`. The `total` is cached for ~30s, so it can briefly lag the live rows.

---

### `GET https://portal.rivalpayments.com/v1/company/loads/:id` — Get one load

`:id` must be a UUID (a malformed id is rejected with `400` by the path pipe before reaching the handler). A load belonging to another company returns `404 NOT_FOUND` (not `403`), so ids are not enumerable across tenants.

```bash
curl "https://portal.rivalpayments.com/v1/company/loads/b3f1c2a8-0d4e-4c1a-9f2b-7e6d5c4b3a21" \
  -H "Authorization: Bearer tsk_live_xxx"
```

**`404`** (unknown or other-tenant id):

```json
{
  "success": false,
  "statusCode": 404,
  "error": { "code": "NOT_FOUND", "message": "Load b3f1c2a8-... not found" }
}
```

---

### `POST https://portal.rivalpayments.com/v1/company/loads/:id/cancel` — Cancel a pending load

Cancels the company's own `PENDING` load. Body is optional `notes`. Nothing was moved at request time, so cancelling is a pure status change → `CANCELLED`.

**Body** (`cancelRequestSchema`): `{ "notes"?: string }` (trimmed, ≤ 500).

```bash
curl -X POST "https://portal.rivalpayments.com/v1/company/loads/b3f1c2a8-.../cancel" \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "notes": "Sent the wrong amount, will re-file" }'
```

**`200`** returns the updated load with `status: "CANCELLED"` and `processedAt` set.

**`409`** if the load is not `PENDING`:

```json
{
  "success": false,
  "statusCode": 409,
  "error": { "code": "CONFLICT", "message": "Load is in status COMPLETED and cannot be cancelled" }
}
```

---

### Operator-only (for reference; not callable with a company key)

- `POST https://portal.rivalpayments.com/v1/admin/loads/:id/approve` — body `{ "externalReference": string (2–200, required), "notes"?: string }`. Credits the wallet net and moves the load to `COMPLETED`. A company key receives `403 FORBIDDEN`.
- `POST https://portal.rivalpayments.com/v1/admin/loads/:id/reject` — body `{ "notes"?: string }`. Moves to `REJECTED`. `403` for company keys.
- `POST https://portal.rivalpayments.com/v1/admin/loads` — super-admin direct load (off-platform funds). `403` for company keys.

### Idempotency

There is **no idempotency key** on `POST /company/loads`. Each call creates a new `PENDING` row, so a client retry after a network blip will create a **duplicate load**. Integrators should treat the returned `id` as the dedupe handle and avoid blind retries on timeout, or reconcile by listing before retrying.

### Auth & rate limits

All `company/loads*` routes are behind `CompanyAccessGuard` (company API key **or** dashboard session). API-key requests skip CSRF; dashboard (cookie) requests require the CSRF token. These routes are governed by the global per-IP `ThrottlerGuard` (`RATE_LIMIT_MAX`, default 100/60s), not the per-key ingest limiter.

---

## Withdrawals & Payouts (Money Out)

Both flows move money **out** of a company's wallet through an identical lifecycle. The difference is only the recipient:

- **Withdrawal** — the company pays an **external third party** (e.g. a vendor, a driver). A `WITHDRAWAL`-type fee may apply.
- **Payout** — the company moves funds **to itself** (off-platform settlement to its own account). A `PAYOUT`-type fee may apply.

Everything else — request/cancel via your company API key, list/get, the balance movement, the payout-method fields, the operator-only approve/reject step, the response shape — is the same. Endpoints are identical except for the path segment `withdrawals` vs `payouts`. Below, `{flow}` stands for either `withdrawals` or `payouts`.

> All paths are under the global `/v1` prefix. `https://portal.rivalpayments.com/v1` = origin + prefix, e.g. `https://portal.rivalpayments.com/v1/company/withdrawals`.

### Authentication & who can do what

| Action           | Path                                                                                                               | Auth                                     | Roles                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------- |
| Request          | `POST https://portal.rivalpayments.com/v1/company/{flow}`                                                          | Company API key **or** dashboard session | `COMPANY_OWNER`, `COMPANY_MANAGER`                   |
| List (own)       | `GET https://portal.rivalpayments.com/v1/company/{flow}`                                                           | Company API key **or** session           | `COMPANY_OWNER`, `COMPANY_MANAGER`, `COMPANY_VIEWER` |
| Get one (own)    | `GET https://portal.rivalpayments.com/v1/company/{flow}/:id`                                                       | Company API key **or** session           | `COMPANY_OWNER`, `COMPANY_MANAGER`, `COMPANY_VIEWER` |
| Cancel           | `POST https://portal.rivalpayments.com/v1/company/{flow}/:id/cancel`                                               | Company API key **or** session           | `COMPANY_OWNER`, `COMPANY_MANAGER`                   |
| **Approve**      | `POST https://portal.rivalpayments.com/v1/admin/{flow}/:id/approve`                                                | **Operator only** (dashboard session)    | `SUPER_ADMIN`, `ADMIN_OPERATOR`, `BACKOFFICE`        |
| **Reject**       | `POST https://portal.rivalpayments.com/v1/admin/{flow}/:id/reject`                                                 | **Operator only**                        | `SUPER_ADMIN`, `ADMIN_OPERATOR`, `BACKOFFICE`        |
| Admin list / get | `GET https://portal.rivalpayments.com/v1/admin/{flow}`, `GET https://portal.rivalpayments.com/v1/admin/{flow}/:id` | **Operator only**                        | `SUPER_ADMIN`, `ADMIN_OPERATOR`, `BACKOFFICE`        |

A company API key is mapped to a surrogate `COMPANY_OWNER` role and is **scoped to its own company** (tenant-isolated). The `admin/*` approve/reject/list endpoints require a platform-operator session and are **not reachable with a company API key** (403). As an integrator, your CRM can create, list, inspect, and cancel requests, but **a human operator must approve or reject** the money actually leaving the platform.

### Balance movement (available → reserved → external)

| Step                                          | Who                | Ledger / wallet effect                                                                                                          |
| --------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Request**                                   | Company            | `available → reserved` for the full **reserved total** (see fee rules). The funds are held but have not left. Status `PENDING`. |
| **Approve**                                   | Operator           | `reserved → external` for the net, and the fee is realized to the platform `FEE` account. Money is gone; status `COMPLETED`.    |
| **Reject** (operator) or **Cancel** (company) | Operator / Company | `reserved → available` for the full reserved total. **No fee is charged.** Status `REJECTED` / `CANCELLED`.                     |

**Fee rules** (a fee rule may or may not be configured; with no rule the fee is `0`):

- **`DEDUCTED`** — the recipient receives `amount − fee`; the reserved/charged total equals `amount`. `totalAmount == amount`.
- **`ON_TOP`** — the recipient receives the full `amount`; the company is charged `amount + fee`. The reserved total (and `totalAmount`) is `amount + fee`.

The reservation is checked against your **available** balance at request time, and **re-checked at approval**. If your available balance can't cover the reserved total you get a `409 INSUFFICIENT_BALANCE` (see error example). If your company **owes the platform** (an outstanding receivable from a reversal clawback), all money-out is blocked at both request and approve with a `409 CONFLICT` until the debt is settled.

### Statuses

`PENDING` → `COMPLETED` (approve) · `PENDING` → `REJECTED` (operator reject) · `PENDING` → `CANCELLED` (company cancel).

Only a `PENDING` request can be approved, rejected, or cancelled. Acting on any other status returns `409 CONFLICT`. (`APPROVED` and `PROCESSING` exist in the shared status enum but are not produced by these flows today — approval goes straight to `COMPLETED`.)

---

### Request a withdrawal / payout

`POST https://portal.rivalpayments.com/v1/company/{flow}` → **201**. Reserves funds and creates a `PENDING` request.

**Body**

| Field      | Type             | Req | Notes                                                                                                                    |
| ---------- | ---------------- | :-: | ------------------------------------------------------------------------------------------------------------------------ |
| `amount`   | string (decimal) |  ✓  | Money string, max 8 decimals / 12 integer digits. Must be `> 0` (zero/negative → `400 VALIDATION_ERROR`). Never a float. |
| `currency` | enum             |  ✓  | Supported: `USD` (only value currently enabled).                                                                         |
| `notes`    | string           |  —  | Free text, trimmed, ≤ 500 chars.                                                                                         |
| `payout`   | object           |  ✓  | Payout-method object (discriminated by `payout.method`). See below.                                                      |

**`payout` — method-specific required fields.** On **create**, only `CASH`, `WISH`, and `CRYPTO` are accepted; `BANK_TRANSFER` and `OTHER` are **rejected** at the API (they exist only for reading legacy rows). The `method` field is the discriminator — sending fields that don't match the method is a `VALIDATION_ERROR`.

| `method`        | Required fields                                                                                                                        | Optional fields                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CASH`          | `recipientName` (2–120), `recipientPhone` (4–30)                                                                                       | `pickupLocation` (≤200), `instructions` (≤500)                 |
| `WISH`          | `recipientName` (2–120), `recipientPhone` (4–30)                                                                                       | `instructions` (≤500)                                          |
| `CRYPTO`        | `network` (2–40), `walletAddress` (20–200)                                                                                             | `memo` (≤120), `instructions` (≤500)                           |
| `BANK_TRANSFER` | `accountHolder` (2–120), `accountNumber` (4–40), `bankName` (2–120) (+ optional `swiftBic` 8–11, `routingNumber` 3–20, `instructions`) | **Read-only — not accepted on create**                         |
| `OTHER`         | `description` (2–500)                                                                                                                  | `instructions` (≤500) · **Read-only — not accepted on create** |

```bash
curl -X POST "https://portal.rivalpayments.com/v1/company/withdrawals" \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "250.00",
    "currency": "USD",
    "notes": "Vendor invoice #4471",
    "payout": {
      "method": "CASH",
      "recipientName": "Jane Vendor",
      "recipientPhone": "+9611234567",
      "pickupLocation": "Beirut HQ"
    }
  }'
```

**Success (201)** — note `feeAmount`/`netAmount`/`totalAmount` are returned to the company (these are NOT hidden the way the ingest path hides fees):

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "companyId": "11111111-2222-3333-4444-555555555555",
    "amount": "250.00",
    "currency": "USD",
    "feeAmount": "2.50",
    "feeApplication": "DEDUCTED",
    "netAmount": "247.50",
    "totalAmount": "250.00",
    "status": "PENDING",
    "payoutMethod": "CASH",
    "payoutDetails": {
      "method": "CASH",
      "recipientName": "Jane Vendor",
      "recipientPhone": "+9611234567",
      "pickupLocation": "Beirut HQ"
    },
    "externalReference": null,
    "requestedById": null,
    "approvedById": null,
    "notes": "Vendor invoice #4471",
    "processedAt": null,
    "createdAt": "2026-06-22T10:15:00.000Z",
    "updatedAt": "2026-06-22T10:15:00.000Z"
  }
}
```

> For a payout, use `POST https://portal.rivalpayments.com/v1/company/payouts` with the identical body. `requestedById` is `null` for API-key callers (the key id is recorded in internal metadata, not exposed).

**Response fields**

| Field                     | Type                   | Notes                                                                                            |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                      | uuid                   | Use in `:id` paths.                                                                              |
| `companyId`               | uuid                   | Always your own company.                                                                         |
| `amount`                  | string                 | The requested amount.                                                                            |
| `currency`                | string                 | e.g. `USD`.                                                                                      |
| `feeAmount`               | string                 | Platform fee (`0` if no rule).                                                                   |
| `feeApplication`          | `DEDUCTED` \| `ON_TOP` | How the fee is applied.                                                                          |
| `netAmount`               | string                 | What the recipient receives. `DEDUCTED`→`amount−fee`; `ON_TOP`→`amount`.                         |
| `totalAmount`             | string                 | What the company is charged (`net + fee`). `==amount` for `DEDUCTED`; `amount+fee` for `ON_TOP`. |
| `status`                  | `WithdrawalStatus`     | `PENDING` / `COMPLETED` / `REJECTED` / `CANCELLED`.                                              |
| `payoutMethod`            | `PayoutMethod`         | `CASH` / `WISH` / `CRYPTO` / `BANK_TRANSFER` / `OTHER`.                                          |
| `payoutDetails`           | object \| null         | The method object you submitted (may be `null` for old rows).                                    |
| `externalReference`       | string \| null         | Off-platform proof set at approval (wire id, tx hash, receipt #).                                |
| `requestedById`           | uuid \| null           | `null` for API-key requests.                                                                     |
| `approvedById`            | uuid \| null           | Operator who approved/rejected; `null` until resolved.                                           |
| `notes`                   | string \| null         |                                                                                                  |
| `processedAt`             | string \| null         | ISO-8601; set when approved/rejected/cancelled.                                                  |
| `createdAt` / `updatedAt` | string                 | ISO-8601.                                                                                        |

**Error — insufficient balance (example)** — note this is `409`, not 422:

```json
{
  "success": false,
  "statusCode": 409,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient USD balance: need 250.00, have 100.00. Top up 150.00 USD and try again.",
    "details": {
      "currency": "USD",
      "required": "250.00",
      "available": "100.00",
      "shortfall": "150.00"
    }
  }
}
```

**Error — outstanding debt blocks money-out**

```json
{
  "success": false,
  "statusCode": 409,
  "error": {
    "code": "CONFLICT",
    "message": "Outstanding balance of 40.00 USD owed to the platform must be settled before withdrawing",
    "details": { "currency": "USD", "outstanding": "40.00" }
  }
}
```

### Cancel a pending request

`POST https://portal.rivalpayments.com/v1/company/{flow}/:id/cancel` → **200**. Company-initiated; releases the reserved funds back to available. **`PENDING` only** — once approved it cannot be cancelled.

| Field   | Type   | Req | Notes                         |
| ------- | ------ | :-: | ----------------------------- |
| `notes` | string |  —  | Optional reason, ≤ 500 chars. |

```bash
curl -X POST "https://portal.rivalpayments.com/v1/company/withdrawals/a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/cancel" \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "notes": "Sent by another channel" }'
```

**Error — not pending**

```json
{
  "success": false,
  "statusCode": 409,
  "error": {
    "code": "CONFLICT",
    "message": "Withdrawal is in status COMPLETED and cannot be cancelled"
  }
}
```

### List requests

`GET https://portal.rivalpayments.com/v1/company/{flow}` → **200**. Returns your company's requests only. Response payload is `{ data: [...], meta }` (so the array is at `data.data`).

| Query param    | Type               | Notes                                                                            |
| -------------- | ------------------ | -------------------------------------------------------------------------------- |
| `page`         | int ≥ 1            | Default `1`.                                                                     |
| `pageSize`     | int 1–100          | Default `20`. **Capped at 100.**                                                 |
| `status`       | `WithdrawalStatus` | Optional filter.                                                                 |
| `currency`     | enum               | Optional.                                                                        |
| `payoutMethod` | `PayoutMethod`     | Optional.                                                                        |
| `from` / `to`  | ISO-8601 datetime  | Filter by `createdAt`.                                                           |
| `companyId`    | uuid               | Ignored for company callers (always scoped to your own company); used by admins. |

```bash
curl "https://portal.rivalpayments.com/v1/company/withdrawals?status=PENDING&pageSize=20" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "id": "a3f1c2d4-...",
        "status": "PENDING",
        "amount": "250.00",
        "currency": "USD",
        "payoutMethod": "CASH"
      }
    ],
    "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
  }
}
```

> `meta.total` is cached per filter for ~30s, so it may briefly lag the live rows.

### Get one request

`GET https://portal.rivalpayments.com/v1/company/{flow}/:id` → **200**. `:id` must be a UUID (non-UUID → `400 BAD_REQUEST` — rejected by the path pipe before the handler; `VALIDATION_ERROR` is reserved for zod query-param failures). A request belonging to another company returns `404 NOT_FOUND` (not 403), so existence isn't leaked across tenants.

```bash
curl "https://portal.rivalpayments.com/v1/company/payouts/a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d" \
  -H "Authorization: Bearer tsk_live_xxx"
```

### Approve / Reject (operator only — for reference)

Your CRM cannot call these (company keys get 403). They are listed so you understand the lifecycle.

- **Approve** `POST https://portal.rivalpayments.com/v1/admin/{flow}/:id/approve` — body requires `externalReference` (2–200 chars, the off-platform proof the money moved) and optional `notes` (≤500). Moves `reserved → external` + realizes the fee; status → `COMPLETED`.
- **Reject** `POST https://portal.rivalpayments.com/v1/admin/{flow}/:id/reject` — body optional `notes` (≤500). Releases `reserved → available`; status → `REJECTED`.

### Notes for integrators

- **Idempotency:** there is **no idempotency key**. A retried `POST /company/{flow}` creates a **second** request and reserves funds again. De-duplicate on your side (e.g. track your own request id and check the list before retrying on a network timeout).
- **Two key types:** these endpoints take a **company** key (`tsk_...` bound to your company). Source/ingest keys are rejected (`401`).
- **CSRF:** API-key requests skip CSRF. Session (dashboard) requests need the CSRF token.
- **Rate limits:** company endpoints use the global per-IP throttler (`RATE_LIMIT_MAX`, default 100/60s); a `429 RATE_LIMITED` is returned when exceeded.
- **CRM webhooks (withdrawals only):** every withdrawal status change is also pushed to your CRM — `withdrawal.pending` then `withdrawal.completed` / `rejected` / `cancelled`, carrying the same `feeAmount` / `netAmount` / `totalAmount` breakdown — so you needn't poll. See [Outbound CRM Notifications](#outbound-crm-notifications-webhooks). **Payouts and loads are not pushed** — read their status over the REST API.

---

## Wallets, Ledger & Activity Feed

These three read-only endpoints are how a CRM reconciles its own books against the platform. All are reachable with a **COMPANY API key** (`Authorization: Bearer tsk_<prefix>_<secret>`) — the key is bound to one company and every query is RLS-scoped to that tenant, so you only ever see your own data. (The sibling `admin/*` routes are dashboard-only and not reachable with an API key.) Responses use the standard envelope; list endpoints nest the array at `data.data` with `data.meta` for pagination. All money fields are decimal **strings**; all timestamps are ISO-8601 strings. The platform currently operates in a single currency, `USD`.

> Reconciliation in one line: **Wallets** = current balances, **Ledger** = the immutable double-entry source of truth (export to CSV for period close), **Activity** = a human-readable, per-operation feed with an optional running balance.

---

### GET `/company/wallets`

Lists your company's wallets — one row per currency, auto-provisioned on first money movement. A wallet splits a balance into three buckets.

**Response item** (`data` is an array):

| Field              | Type              | Notes                                                                                                                                                                                                 |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string (uuid)     | Wallet id                                                                                                                                                                                             |
| `companyId`        | string (uuid)     | Your company id                                                                                                                                                                                       |
| `currency`         | string            | ISO-4217 (currently always `USD`)                                                                                                                                                                     |
| `availableBalance` | string (decimal)  | **Spendable now.** Funds you can withdraw/pay out/load against                                                                                                                                        |
| `pendingBalance`   | string (decimal)  | Money credited but not yet final (e.g. an in-flight deposit not yet `COMPLETED`) — not yet spendable                                                                                                  |
| `reservedBalance`  | string (decimal)  | Funds **held** against an approved-but-not-completed money-out request (withdrawal/payout/load). Moved out of `available` into `reserved` while the request is in flight, then released on completion |
| `updatedAt`        | string (ISO-8601) | Last balance change                                                                                                                                                                                   |

The wallet never goes negative; debts that exceed `available` are booked to a `RECEIVABLE` ledger account instead of driving a balance below zero (see Ledger).

```bash
curl -s https://portal.rivalpayments.com/v1/company/wallets \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": [
    {
      "id": "0b3f7c9e-1d2a-4b6c-8e10-aa1122334455",
      "companyId": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      "currency": "USD",
      "availableBalance": "1250.00000000",
      "pendingBalance": "0.00000000",
      "reservedBalance": "300.00000000",
      "updatedAt": "2026-06-22T10:15:30.000Z"
    }
  ]
}
```

---

### GET `/company/ledger`

Paginated, append-only double-entry ledger — the authoritative record. Every money event writes a **balanced set** of entries (Σ debits = Σ credits per currency); nothing is ever updated or deleted. Use this for audits and exact reconciliation.

**Query params:**

| Field           | Type              | Req | Notes                                                                      |
| --------------- | ----------------- | --- | -------------------------------------------------------------------------- |
| `page`          | int ≥ 1           | no  | Default `1`                                                                |
| `pageSize`      | int 1–200         | no  | Default `50`. Hard cap **200**                                             |
| `currency`      | enum              | no  | Currently only `USD`                                                       |
| `accountType`   | enum              | no  | One of `AVAILABLE`, `PENDING`, `RESERVED`, `FEE`, `EXTERNAL`, `RECEIVABLE` |
| `transactionId` | uuid              | no  | Filter to entries of one deposit/transaction                               |
| `withdrawalId`  | uuid              | no  | Filter to one withdrawal                                                   |
| `payoutId`      | uuid              | no  | Filter to one payout                                                       |
| `loadId`        | uuid              | no  | Filter to one load                                                         |
| `from`          | ISO-8601 datetime | no  | Inclusive lower bound on `createdAt`                                       |
| `to`            | ISO-8601 datetime | no  | Inclusive upper bound on `createdAt`                                       |

Deep paging is capped: an effective offset `(page-1)*pageSize > 50000` returns `400 VALIDATION_ERROR` ("narrow with filters"). For full-history pulls use the CSV export below instead of paging.

**Response item:**

| Field           | Type                  | Notes                                                                               |
| --------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `id`            | string (uuid)         | Entry id                                                                            |
| `companyId`     | string (uuid)         | Your company id                                                                     |
| `transactionId` | string (uuid) \| null | Set when the entry came from a deposit                                              |
| `withdrawalId`  | string (uuid) \| null | Set when from a withdrawal                                                          |
| `payoutId`      | string (uuid) \| null | Set when from a payout                                                              |
| `loadId`        | string (uuid) \| null | Set when from a load. **At most one** of these four FK fields is non-null per entry |
| `accountType`   | enum                  | Which account this line hits (see below)                                            |
| `direction`     | enum                  | `DEBIT` or `CREDIT`                                                                 |
| `amount`        | string (decimal)      | Always positive; `direction` carries the sign                                       |
| `currency`      | string                | ISO-4217                                                                            |
| `metadata`      | object \| null        | Free-form context written by the originating flow                                   |
| `createdAt`     | string (ISO-8601)     | All lines of one event share the same timestamp                                     |

**Account types:**

- `AVAILABLE` / `PENDING` / `RESERVED` — project directly to the matching wallet balance bucket. Sum of (`CREDIT` − `DEBIT`) over `AVAILABLE` for a currency equals that wallet's `availableBalance`.
- `FEE` — the platform commission/fee leg (revenue to the platform).
- `EXTERNAL` — the counterparty/world side (the source provider on a deposit, the destination on a payout). Balances the wallet-side legs.
- `RECEIVABLE` — debt the company owes the platform (e.g. the uncovered remainder of a reversal/clawback after `available` was drained). Has no wallet projection, which is how the wallet stays ≥ 0.

Lines within one event are returned in a stable order: newest first, then `DEBIT` before `CREDIT`, then by account-type enum order. A standard deposit reads `EXTERNAL(DEBIT) → AVAILABLE(CREDIT) → FEE(CREDIT)`.

```bash
curl -s "https://portal.rivalpayments.com/v1/company/ledger?accountType=AVAILABLE&from=2026-06-01T00:00:00Z&pageSize=50" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "id": "c1a2...e",
        "companyId": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
        "transactionId": "7d8e9f00-1122-3344-5566-778899aabbcc",
        "withdrawalId": null,
        "payoutId": null,
        "loadId": null,
        "accountType": "AVAILABLE",
        "direction": "CREDIT",
        "amount": "95.00000000",
        "currency": "USD",
        "metadata": { "reason": "deposit_settled" },
        "createdAt": "2026-06-22T10:15:30.000Z"
      }
    ],
    "meta": { "page": 1, "pageSize": 50, "total": 1, "totalPages": 1 }
  }
}
```

Error (offset too deep):

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Page too deep to scan efficiently. Narrow the results with filters (currency, account type, date range)."
  }
}
```

#### GET `/company/ledger/export.csv`

Same filters as `/company/ledger` (the query schema is identical), but streams **all** matching rows as CSV with no row cap — built for offline period reconciliation. Returns `text/csv; charset=utf-8` with `Content-Disposition: attachment` and **skips the JSON envelope** (you get raw CSV, not `{success,...}`). Header row:

```
id,created_at,account_type,direction,amount,currency,transaction_id,withdrawal_id,payout_id,load_id
```

```bash
curl -s "https://portal.rivalpayments.com/v1/company/ledger/export.csv?from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z" \
  -H "Authorization: Bearer tsk_live_xxx" -o ledger-june.csv
```

---

### GET `/company/activity`

A unified, human-readable feed merging the four **COMPLETED** money operations — deposits, loads, withdrawals, payouts — into one chronological list (newest first). This is the friendly view; the ledger is the exact one. Pending/failed operations do **not** appear here.

**Query params:**

| Field         | Type              | Req | Notes                                                    |
| ------------- | ----------------- | --- | -------------------------------------------------------- |
| `page`        | int ≥ 1           | no  | Default `1`                                              |
| `pageSize`    | int 1–100         | no  | Default `20`. Hard cap **100**                           |
| `direction`   | enum              | no  | `IN` (deposits + loads) or `OUT` (withdrawals + payouts) |
| `kind`        | enum              | no  | `DEPOSIT`, `LOAD`, `WITHDRAWAL`, `PAYOUT`                |
| `currency`    | enum              | no  | Currently only `USD`                                     |
| `from` / `to` | ISO-8601 datetime | no  | Filter by `createdAt`                                    |
| `search`      | string ≤ 200      | no  | Fuzzy match on `reference` / `description` / `details`   |

Deep paging capped at offset `50000` (same `400 VALIDATION_ERROR` as ledger). The admin-only `companyId` filter is ignored on this company-scoped route.

**Response item** (`data.data[]`):

| Field          | Type                      | Notes                                                                                      |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `id`           | string (uuid)             | Id of the underlying operation                                                             |
| `kind`         | enum                      | `DEPOSIT` / `LOAD` / `WITHDRAWAL` / `PAYOUT`                                               |
| `direction`    | enum                      | Derived: `IN` for deposit/load, `OUT` for withdrawal/payout                                |
| `amount`       | string (decimal)          | Gross amount of the operation                                                              |
| `fee`          | string (decimal)          | Platform fee/commission on this operation                                                  |
| `net`          | string (decimal)          | Net after fee                                                                              |
| `currency`     | string                    | ISO-4217                                                                                   |
| `description`  | string                    | Source code (deposits) or payout method (load/withdrawal/payout); falls back to `kind`     |
| `details`      | string \| null            | Counterparty/recipient (customer, phone, masked account, recipient name…)                  |
| `reference`    | string \| null            | External ref: `externalTransactionId` (deposit) or `externalReference` (others)            |
| `createdAt`    | string (ISO-8601)         | When the operation was created                                                             |
| `completedAt`  | string (ISO-8601) \| null | When it settled                                                                            |
| `companyId`    | null                      | Always `null` on the company feed (single-tenant)                                          |
| `companyName`  | null                      | Always `null` on the company feed                                                          |
| `balanceAfter` | string (decimal) \| null  | Running **AVAILABLE** balance after this op — populated only in _balance mode_ (see below) |

**Balance mode** (`meta.balanceMode`): when the feed resolves to a **single currency** and you pass **no** `kind`, `direction`, or `search` filter, each row carries `balanceAfter` — the absolute running `available` balance after that operation. Because the platform is currently single-currency (`USD`), balance mode is **on by default** for an unfiltered company feed; passing `kind`/`direction`/`search` turns it off (those filters would punch holes in the chronological sum) and sets every `balanceAfter` to `null`. A `from`/`to` date filter keeps balance mode on (the running sum is computed over full history first, then the window is sliced), so balances stay absolute. The newest row's `balanceAfter` reconciles to `wallets.availableBalance` in normal operation; the only documented divergence is a rare partial-reversal clawback (a `RECEIVABLE` was booked), which self-corrects as new operations arrive.

`meta` extends the standard pagination meta with `balanceMode`:

```bash
curl -s "https://portal.rivalpayments.com/v1/company/activity?pageSize=20" \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "id": "7d8e9f00-1122-3344-5566-778899aabbcc",
        "kind": "DEPOSIT",
        "direction": "IN",
        "amount": "100.00000000",
        "fee": "5.00000000",
        "net": "95.00000000",
        "currency": "USD",
        "description": "OMT",
        "details": "John Customer",
        "reference": "OMT-REF-8842",
        "createdAt": "2026-06-22T10:15:30.000Z",
        "completedAt": "2026-06-22T10:15:31.000Z",
        "companyId": null,
        "companyName": null,
        "balanceAfter": "1250.00000000"
      }
    ],
    "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1, "balanceMode": true }
  }
}
```

---

### GET `/company/operations/counts`

Live counts of your **PENDING** (needs-action) requests per money flow. Powers dashboard badges; no parameters.

| Field         | Type | Notes                       |
| ------------- | ---- | --------------------------- |
| `withdrawals` | int  | Pending withdrawal requests |
| `payouts`     | int  | Pending payout requests     |
| `loads`       | int  | Pending load requests       |

```json
{ "success": true, "statusCode": 200, "data": { "withdrawals": 2, "payouts": 0, "loads": 1 } }
```

---

### How a CRM reconciles its books

1. **Snapshot:** `GET /company/wallets` for current `available` / `pending` / `reserved`. `available` is what you can move; `reserved` is held against in-flight money-out; `pending` is credited-but-not-final.
2. **Per-period truth:** pull `GET /company/ledger/export.csv?from=…&to=…`. For each currency, `Σ(CREDIT − DEBIT)` over `AVAILABLE` rows = the change in `availableBalance`; the same over `FEE` = platform fees you paid; `RECEIVABLE` rows = debt owed to the platform.
3. **Human view / running balance:** `GET /company/activity` unfiltered (balance mode on) gives a per-operation statement with `balanceAfter` that ties out to the wallet's `availableBalance` on the newest row.

Common error envelopes apply throughout: `401 UNAUTHORIZED` (bad/missing key), `403 FORBIDDEN`, `400 VALIDATION_ERROR` (bad query params, with Zod issues in `error.details`), `429 RATE_LIMITED`.

---

## Whish Payment Collection

Whish Pay lets your CRM mint a hosted payment link, hand the link to your customer, and have the collected money settle automatically into your company wallet. The flow is **collect → reconcile**: you create a link, the customer pays on Whish's hosted page, Whish confirms the payment, and the platform writes a ledger transaction and credits your wallet. You can confirm settlement either by polling, by registering an outbound webhook, or by forcing a status refresh.

> **Optional / platform-gated.** Whish is a single, platform-wide integration (one Whish merchant account, configured by the platform operator via the `WHISH_CHANNEL` / `WHISH_SECRET` credentials). It is **not** something a company self-enables. If the platform has not configured Whish, create calls fail with a **`VALIDATION_ERROR` (400)** — message `"Whish is not configured (missing WHISH_CHANNEL / WHISH_SECRET)"`. (A genuine _upstream_ Whish API failure is different: it surfaces as `WHISH_ERROR`, HTTP 502.) Enabled currencies are platform-controlled via `WHISH_ENABLED_CURRENCIES` (intersected with the set the API accepts) — by default **USD only**.

### Authentication & base path

All endpoints in this section are reachable with a **COMPANY API key**: `Authorization: Bearer tsk_<prefix>_<secret>`. There are two route families that do the same job with different identifiers:

| Route family                                  | Auth                                     | Reference used in URL              | Rate limit                                                  |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `integrations/whish/*` (recommended for CRMs) | Company API key only                     | numeric `externalId` ("reference") | Per-API-key: **300 req / 60s**                              |
| `company/whish/payments/*`                    | Company API key **or** dashboard session | UUID `id`                          | Per-IP global throttler (`RATE_LIMIT_MAX`, default 100/60s) |

Both families return the **same** payment object. API-key requests skip CSRF. We document the `integrations/whish/*` family first (purpose-built for server-to-server CRM use), then the `company/whish/payments/*` equivalents.

> **Heads-up (two different references):** `integrations/whish` addresses a payment by its **numeric `externalId`** (called the _reference_), while `company/whish/payments` addresses it by its **UUID `id`**. Both are returned by every create call (`externalId` and `id` fields). Pick one family and stay in it.

---

### The payment object

Returned (under the `data` envelope) by every create / get / refresh call.

| Field              | Type                      | Notes                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string (UUID)             | Internal payment id. URL reference for the `company/whish/payments/*` family.                                                                                                                                                                                                   |
| `companyId`        | string (UUID)             | Your company id.                                                                                                                                                                                                                                                                |
| `externalId`       | string (numeric)          | The **reference**. Serialized as a string (DB bigint). URL reference for the `integrations/whish/*` family. Also the `whish:<externalId>` transaction reference once settled.                                                                                                   |
| `status`           | enum                      | `PENDING` \| `PAID` \| `FAILED`. See lifecycle below. (`EXPIRED` is a legacy value retained only for old records; lapsed links now report as `FAILED`.)                                                                                                                         |
| `amount`           | string (decimal)          | The amount to collect, as a decimal string.                                                                                                                                                                                                                                     |
| `currency`         | string                    | Always `USD` by default.                                                                                                                                                                                                                                                        |
| `invoice`          | string                    | Your free-text invoice/description (1–200 chars).                                                                                                                                                                                                                               |
| `collectUrl`       | string \| null            | The Whish-hosted page to send your customer to. `null` if link creation failed (`status: FAILED`).                                                                                                                                                                              |
| `payerPhoneNumber` | string \| null            | The payer's Whish phone, populated after Whish reports a result.                                                                                                                                                                                                                |
| `transactionId`    | string (UUID) \| null     | The settled ledger transaction id. Non-null only when `PAID`.                                                                                                                                                                                                                   |
| `needsAttention`   | boolean                   | `true` when the money is **PAID at Whish but could not be settled** into the ledger (almost always because the commission rule changed after the link was minted) — the reconciler keeps retrying but an operator must act. Surfaced so it is visible to you, not just in logs. |
| `createdAt`        | string (ISO-8601)         |                                                                                                                                                                                                                                                                                 |
| `paidAt`           | string (ISO-8601) \| null | Set when settled.                                                                                                                                                                                                                                                               |

> **No fee/net fields on this object.** Like the ingest boundary, the payment object deliberately omits the platform commission and net amount — you see only the gross amount you asked to collect. **To see the fee we took and the net you were credited**, read the **settled transaction** once `PAID` (reference `whish:<externalId>`): `GET /company/transactions` returns `commissionAmount` + `netAmount`, and the `transaction.completed` CRM event carries them too.

#### Status lifecycle

| Status    | Meaning                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING` | Link created; customer has not completed payment yet. (Also the transient state while a paid-but-unsettled payment awaits operator action — see `needsAttention`.)  |
| `PAID`    | Confirmed by Whish; a ledger transaction was written and your wallet credited. Terminal.                                                                            |
| `FAILED`  | Whish reported failure, the link lapsed unpaid, or the link could not be created. Terminal. (Whish reports no separate "expired" — a lapsed link is also `FAILED`.) |

---

### 1. Create a payment link

`POST https://portal.rivalpayments.com/v1/integrations/whish/payments`

Mints a PENDING payment, calls Whish to get a `collectUrl`, and returns the payment. The platform **dry-runs the commission rule at create time** — if no commission rule covers the amount/currency, creation fails (422) _before_ any customer pays, so you never end up with collected money that can't settle.

**Request body**

| Field                | Type             | Req | Notes                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `amount`             | string (decimal) | yes | Non-negative decimal string; ≤ 8 fractional digits, ≤ 12 integer digits. Never a float. (Note: the money validator accepts `"0"`; a zero/uncovered amount is rejected by the commission dry-run below, not by field validation.)                                                                             |
| `currency`           | enum             | yes | Must be an enabled currency — `USD` only by default. Other values → `VALIDATION_ERROR`.                                                                                                                                                                                                                      |
| `invoice`            | string           | yes | 1–200 chars (trimmed). Your reference/description shown to the payer.                                                                                                                                                                                                                                        |
| `idempotencyKey`     | string           | no  | 8–120 chars (trimmed). A retry with the same key returns the **original** payment instead of minting a duplicate link (safe to retry on network failure). Scoped per company.                                                                                                                                |
| `successRedirectUrl` | string (URL)     | no  | Where the **payer's browser** is sent after a **successful** payment. Must be `http(s)`, ≤ 2048 chars. Overrides your saved default **for this link**; if omitted, your company default is used, then the platform's confirmation page. We append `?ref=<externalId>` so your page can identify the payment. |
| `failureRedirectUrl` | string (URL)     | no  | Same, for a **failed/abandoned** payment.                                                                                                                                                                                                                                                                    |

```bash
curl -X POST "https://portal.rivalpayments.com/v1/integrations/whish/payments" \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "49.99",
    "currency": "USD",
    "invoice": "Order #1043",
    "idempotencyKey": "order-1043-attempt-1"
  }'
```

**201 Created**

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "9b1d4c2a-5f3e-4a8b-9c7d-1e2f3a4b5c6d",
    "companyId": "1a2b3c4d-5e6f-7081-9a0b-1c2d3e4f5061",
    "externalId": "100237",
    "status": "PENDING",
    "amount": "49.99",
    "currency": "USD",
    "invoice": "Order #1043",
    "collectUrl": "https://whish.money/collect/abc123",
    "payerPhoneNumber": null,
    "transactionId": null,
    "needsAttention": false,
    "createdAt": "2026-06-22T10:15:00.000Z",
    "paidAt": null
  }
}
```

Send your customer to `data.collectUrl`. Keep `data.externalId` (the reference) to look the payment up later.

**Where the customer lands after paying (redirect).** After the customer finishes (or fails) on the Whish page, their browser is redirected. You control the destination, resolved in this order:

1. `successRedirectUrl` / `failureRedirectUrl` in **this** create request (per-link override), else
2. your company **default** redirect URLs (set once on the dashboard **Whish Pay** page), else
3. the platform's built-in `/pay/success` and `/pay/failure` confirmation pages.

The chosen URL always gets `?ref=<externalId>` appended, so your landing page can read the reference and show the right order. These are **customer-facing redirects only** — they are _not_ how you learn the payment settled (that happens automatically via the CRM webhook / status endpoints). The settlement **callback** URLs are managed by the platform and are not yours to set.

**Managing your default redirect URLs.** Set the company-wide defaults on the dashboard **Whish Pay** page, or programmatically:

- `GET https://portal.rivalpayments.com/v1/company/whish/redirects` → `{ "successUrl": string|null, "failureUrl": string|null }` (`null` = the platform's `/pay` pages).
- `PUT https://portal.rivalpayments.com/v1/company/whish/redirects` → body `{ "successUrl": string|null, "failureUrl": string|null }`. URLs must be `http(s)`, ≤ 2048 chars; send `null` to clear a default. Returns the saved config.

Both endpoints accept **either** a company API key (`Authorization: Bearer tsk_…`, no CSRF) **or** a dashboard cookie session (with the CSRF token). Roles: `GET` requires `COMPANY_OWNER` / `COMPANY_MANAGER` / `COMPANY_VIEWER`; `PUT` requires `COMPANY_OWNER` / `COMPANY_MANAGER`. (API-key callers act as a `COMPANY_OWNER` surrogate, so both pass.) The per-link `successRedirectUrl` / `failureRedirectUrl` above override these defaults for a single payment.

**Error — no commission rule covers the amount (422):**

```json
{
  "success": false,
  "statusCode": 422,
  "error": {
    "code": "NO_COMMISSION_RULE",
    "message": "No active commission rule matches amount=49.99 for company=1a2b3c4d-5e6f-7081-9a0b-1c2d3e4f5061 source=<whish-source-id>",
    "details": {
      "companyId": "1a2b3c4d-5e6f-7081-9a0b-1c2d3e4f5061",
      "sourceId": "<whish-source-id>",
      "amount": "49.99"
    }
  }
}
```

**Error — disabled currency (400):**

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Whish payments in EUR are not enabled. Enabled: USD."
  }
}
```

(A bad `currency` enum value fails earlier at zod validation, also `VALIDATION_ERROR` with zod issues in `details`. An upstream Whish outage surfaces as `WHISH_ERROR`, HTTP 502.)

---

### 2. Look up a payment (poll for settlement)

`GET https://portal.rivalpayments.com/v1/integrations/whish/payments/:reference`

`:reference` is the numeric `externalId`. Returns the **stored** payment as-is (no upstream call) — use this to poll `status` after the customer pays. To force a fresh pull from Whish instead, use the refresh endpoint below.

```bash
curl "https://portal.rivalpayments.com/v1/integrations/whish/payments/100237" \
  -H "Authorization: Bearer tsk_live_xxx"
```

**200 OK** (settled):

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "id": "9b1d4c2a-5f3e-4a8b-9c7d-1e2f3a4b5c6d",
    "companyId": "1a2b3c4d-5e6f-7081-9a0b-1c2d3e4f5061",
    "externalId": "100237",
    "status": "PAID",
    "amount": "49.99",
    "currency": "USD",
    "invoice": "Order #1043",
    "collectUrl": "https://whish.money/collect/abc123",
    "payerPhoneNumber": "9613xxxxxx",
    "transactionId": "7c8d9e0f-1a2b-3c4d-5e6f-7081a2b3c4d5",
    "needsAttention": false,
    "createdAt": "2026-06-22T10:15:00.000Z",
    "paidAt": "2026-06-22T10:18:42.000Z"
  }
}
```

**404 — unknown reference (or not yours):**

```json
{
  "success": false,
  "statusCode": 404,
  "error": { "code": "NOT_FOUND", "message": "WhishPayment 100238 not found" }
}
```

**400 — non-integer reference:**

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "reference must be a positive integer (externalId)"
  }
}
```

---

### 3. Refresh status (force reconcile)

`POST https://portal.rivalpayments.com/v1/integrations/whish/payments/:reference/refresh`

Forces an **authoritative status pull from Whish** and settles if paid. Use this if a callback was missed (e.g. your webhook was down) and the payment still shows `PENDING` after the customer says they paid. Idempotent — a `PAID` payment is returned unchanged, and a double settle is prevented by the `(source, externalId)` unique constraint, so it's safe to call repeatedly.

```bash
curl -X POST "https://portal.rivalpayments.com/v1/integrations/whish/payments/100237/refresh" \
  -H "Authorization: Bearer tsk_live_xxx"
```

Returns the (possibly updated) payment object under a **200** envelope, same shape as the lookup. If Whish says the payment succeeded but settlement into the ledger fails (e.g. the commission rule changed after the link was minted), the payment stays `PENDING` with `needsAttention: true` and the call surfaces the error — contact the platform operator.

---

### Outbound webhook (avoid polling)

Instead of polling, register an endpoint and the platform will POST you a signed `whish.payment.paid` event when a payment settles. Webhook config (`company/whish/webhook`) is manageable with **either** a company API key (`Authorization: Bearer tsk_…`, no CSRF) **or** a dashboard cookie session (with the CSRF token): `GET` requires `COMPANY_OWNER` / `COMPANY_MANAGER` / `COMPANY_VIEWER`; `PUT` (set), `POST rotate-secret`, and `DELETE` (clear) require `COMPANY_OWNER`. (API-key callers act as a `COMPANY_OWNER` surrogate, so all pass.) Once set, delivery is best-effort (2 attempts, never blocks settlement); always keep polling/refresh as a fallback.

Delivered request:

- Headers: `x-whish-event: whish.payment.paid`, `x-whish-timestamp: <unix-seconds>`, and (if a secret is configured) `x-whish-signature: t=<ts>,sha256=<hex>`.
- Signature = `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`. Verify the HMAC **and** that the timestamp is recent to reject replays.
- Body:

```json
{
  "event": "whish.payment.paid",
  "data": {
    "externalId": "100237",
    "status": "PAID",
    "amount": "49.99",
    "currency": "USD",
    "invoice": "Order #1043",
    "payerPhoneNumber": "9613xxxxxx",
    "transactionId": "7c8d9e0f-1a2b-3c4d-5e6f-7081a2b3c4d5",
    "paidAt": "2026-06-22T10:18:42.000Z"
  }
}
```

The signing secret is `whsec_…`, returned **once** when you first set the URL or rotate the secret. Your endpoint must be HTTPS and publicly reachable (private/loopback addresses are rejected).

---

### `company/whish/payments/*` equivalents (UUID-addressed)

Same payment object, addressed by UUID `id`; accepts a company API key **or** a dashboard session. Useful if you prefer listing/UUID semantics. Note the **per-IP** rate limit (global throttler) rather than the per-key limit of `integrations/whish`. (A company API key authenticates against these as an owner-level principal, so it passes the role checks for every action below.)

| Method & path                                                                        | Purpose                                                                                                                                      | Roles (session)        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `GET https://portal.rivalpayments.com/v1/company/whish/payments`                     | List payments (paginated). Query: `page` (≥1, default 1), `pageSize` (1–100, default 20), `status?`, `needsAttention?` (`"true"`/`"false"`). | OWNER, MANAGER, VIEWER |
| `GET https://portal.rivalpayments.com/v1/company/whish/payments/:id`                 | Get one by UUID.                                                                                                                             | OWNER, MANAGER, VIEWER |
| `POST https://portal.rivalpayments.com/v1/company/whish/payments`                    | Create (same body as §1).                                                                                                                    | OWNER, MANAGER         |
| `POST https://portal.rivalpayments.com/v1/company/whish/payments/:id/refresh-status` | Force reconcile (same as §3).                                                                                                                | OWNER, MANAGER         |

List response uses the standard paginated shape (`data.data` array + `data.meta` with `page`/`pageSize`/`total`/`totalPages`):

```bash
curl "https://portal.rivalpayments.com/v1/company/whish/payments?status=PAID&page=1&pageSize=20" \
  -H "Authorization: Bearer tsk_live_xxx"
```

> **Note:** the **refresh action has different path segments** between the two families — `/refresh` on `integrations/whish`, `/refresh-status` on `company/whish/payments`.

### Config (currencies)

`GET https://portal.rivalpayments.com/v1/company/whish/config` → `{ "enabledCurrencies": ["USD"] }`. This tells the UI which currencies are live. **This endpoint requires a dashboard session (JWT) — it does NOT accept an API key.** API-key integrators cannot read it programmatically; treat `USD` as the default and rely on the create-time `VALIDATION_ERROR` if a currency is disabled.

### Recommended integration flow

1. (Once) Mint a company API key under the dashboard; optionally register an outbound webhook.
2. `POST integrations/whish/payments` with `amount` + `invoice` (+ `idempotencyKey` for safe retries). Redirect the customer to `data.collectUrl`. Store `data.externalId`.
3. Learn the result via webhook **or** poll `GET integrations/whish/payments/:externalId` for `status === "PAID"`.
4. If a callback was missed and it's still `PENDING`, call `POST .../:externalId/refresh`.
5. On `PAID`, `data.transactionId` links to the settled ledger transaction (also visible in the transactions API as reference `whish:<externalId>`).

---

## Outbound CRM Notifications (Webhooks)

The platform pushes the status lifecycle of every **deposit** (transaction) and **withdrawal** to **your own CRM** via an outbound HTTP `POST`, so you never have to poll. You configure one callback URL + the API key your CRM expects; we then `POST` a small JSON event each time a record changes state — a deposit moves `PENDING → COMPLETED` (or `FAILED / REVERSED`), a withdrawal moves `PENDING → COMPLETED / REJECTED / CANCELLED`. Delivery is **durable and retried** — an outage on your side cannot silently drop an event.

> **Payouts and loads are not pushed here.** Only deposits (transaction events) and withdrawals (withdrawal events) emit CRM webhooks. Manage payouts and loads over the REST API (poll their `GET /company/{flow}/:id` status).

There are **two independent outbound channels** — do not confuse them:

| Channel                                       | Configured at           | Events                                                       | Signed?                                             |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| **CRM events** (this section, the main one)   | `company/crm/config`    | deposit lifecycle (5 event types) + withdrawal lifecycle (4) | **Yes** — HMAC-SHA256, `x-crm-signature` (additive) |
| **Whish payment webhook** (legacy, paid-only) | `company/whish/webhook` | only `whish.payment.paid`                                    | **Yes** — HMAC-SHA256, `x-whish-signature`          |

> Security note for integrators: the **CRM events channel IS HMAC-signed.** Every POST carries `x-crm-signature` (HMAC-SHA256 over `${x-crm-timestamp}.${rawBody}`, keyed by your CRM key) **in addition to** the `Authorization: Bearer <your CRM key>` header. For the strongest verification, check **both**: confirm the Bearer token matches the key you configured, and verify the `x-crm-signature` (which also makes replays detectable via the timestamp). See the verification example below.

---

### How a company configures its CRM callback

All routes are under `https://portal.rivalpayments.com/v1/company/crm` and are reachable with **either** a dashboard session **or** a company API key (`Authorization: Bearer tsk_...`). API-key callers act as `COMPANY_OWNER`, so an integration can fully manage this config programmatically; API-key requests skip CSRF. Session callers need role `COMPANY_OWNER` to mutate (`PUT`/`DELETE`/demo); `COMPANY_MANAGER`/`COMPANY_VIEWER` may read (`GET`).

#### `GET /company/crm/config` — read current config

One-line: returns the configured CRM URL and whether a key/demo is set (never returns the stored key itself).

Response `data` fields:

| Field       | Type           | Notes                                                                       |
| ----------- | -------------- | --------------------------------------------------------------------------- |
| `apiUrl`    | string \| null | The CRM endpoint we POST to.                                                |
| `hasApiKey` | boolean        | Whether a Bearer key is stored. The key value is **never** returned.        |
| `enabled`   | boolean        | Whether outbound delivery is active.                                        |
| `demoUrl`   | string \| null | Public demo-inbox URL if the built-in demo CRM was ever enabled, else null. |

```bash
curl https://portal.rivalpayments.com/v1/company/crm/config \
  -H "Authorization: Bearer tsk_live_xxx"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "apiUrl": "https://crm.acme.example/hooks/loadless",
    "hasApiKey": true,
    "enabled": true,
    "demoUrl": null
  }
}
```

#### `PUT /company/crm/config` — point us at your CRM

One-line: sets the callback URL + the API key we send to it, and enables delivery.

Request body (`setCrmConfigSchema`):

| Field    | Type         | Req | Notes                                                                                                                                                                                      |
| -------- | ------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apiUrl` | string (URL) | yes | Must be a valid URL, **`https://` only**, no embedded credentials, and must not resolve to a private/loopback/link-local/reserved address (SSRF policy). Otherwise `400 VALIDATION_ERROR`. |
| `apiKey` | string       | yes | 1–200 chars (trimmed). We send this verbatim as `Authorization: Bearer <apiKey>` on every delivery. Stored encrypted-at-rest semantics — never returned.                                   |

Setting config implicitly sets `enabled: true`. Returns the same shape as `GET`.

```bash
curl -X PUT https://portal.rivalpayments.com/v1/company/crm/config \
  -H "Authorization: Bearer tsk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"apiUrl":"https://crm.acme.example/hooks/loadless","apiKey":"acme_crm_secret_123"}'
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "apiUrl": "https://crm.acme.example/hooks/loadless",
    "hasApiKey": true,
    "enabled": true,
    "demoUrl": null
  }
}
```

A non-https or private-address URL fails fast:

```json
{
  "success": false,
  "statusCode": 400,
  "error": { "code": "VALIDATION_ERROR", "message": "Webhook URL must use https" }
}
```

#### `DELETE /company/crm/config` — disable delivery

One-line: clears the URL + key and sets `enabled: false`. No more events are sent. Returns the (now-empty) config.

#### `POST /company/crm/demo/enable` — try it without a real CRM

One-line: wires the config to a built-in demo inbox (a first-party endpoint) so you can watch events arrive end-to-end. Returns config with a populated `demoUrl`. Owner-only.

#### `GET /company/crm/demo/inbox` — read the demo feed

One-line: returns the most recent demo events (max 50), newest first — byte-identical to what a real CRM would receive. Each item: `{ reference, event, status, transaction, withdrawal, receivedAt }` — exactly one of `transaction` / `withdrawal` is populated, the other is `null` (see payload below).

---

### The outbound payload we POST to your CRM

For every event we send a single JSON body (`crmEventPayloadSchema`). The request looks like:

```http
POST /hooks/loadless HTTP/1.1
Host: crm.acme.example
Content-Type: application/json
Authorization: Bearer acme_crm_secret_123
x-crm-event: transaction.completed
x-crm-timestamp: 1750579200
x-crm-signature: t=1750579200,sha256=9f86d0818...e3b0c44298fc1c149afbf4c8996fb
```

```json
{
  "event": "transaction.completed",
  "reference": "whish:184523",
  "sentAt": "2026-06-22T09:20:00.123Z",
  "transaction": {
    "id": "0f8d2c4e-1a2b-4c3d-9e8f-7a6b5c4d3e2f",
    "status": "COMPLETED",
    "source": "whish",
    "externalTransactionId": "184523",
    "amount": "100.00",
    "currency": "USD",
    "netAmount": "97.50",
    "commissionAmount": "2.50",
    "customer": "John Doe",
    "tradingAccount": "ACC-99821",
    "phone": "+9613000000",
    "note": "Invoice #5512",
    "occurredAt": "2026-06-22T09:19:58.000Z"
  }
}
```

**Top-level fields:**

| Field         | Type              | Notes                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`       | enum              | A **deposit** event — `transaction.pending`, `transaction.completed`, `transaction.failed`, `transaction.reversed` (a lapsed/expired Whish link arrives as `transaction.failed`; there is no separate `expired` event) — **or** a **withdrawal** event — `withdrawal.pending`, `withdrawal.completed`, `withdrawal.rejected`, `withdrawal.cancelled`. |
| `reference`   | string            | **Stable idempotency/correlation key**, identical across the whole lifecycle of one record. Deposits: `"<source>:<externalTransactionId>"` (e.g. `whish:184523`). Withdrawals: `"withdrawal:<id>"`. **Upsert your CRM record on this** — the same reference moves through its lifecycle in place.                                                     |
| `sentAt`      | string (ISO-8601) | When we built this delivery attempt's payload.                                                                                                                                                                                                                                                                                                        |
| `transaction` | object \| absent  | The deposit body — present on `transaction.*` events, absent on withdrawal events. See **`transaction` fields** below.                                                                                                                                                                                                                                |
| `withdrawal`  | object \| absent  | The withdrawal body — present on `withdrawal.*` events, absent on deposit events. See **Withdrawal events** below.                                                                                                                                                                                                                                    |

> Exactly one of `transaction` / `withdrawal` is present on any event, selected by the event family. Branch on the `event` prefix (or on which body is present).

**`transaction` fields** (`crmEventTransactionSchema`) — deposit events only:

| Field                   | Type                     | Notes                                                                                                                                                              |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | string (uuid) \| null    | Ledger transaction id. **`null`** for Whish `PENDING`/`FAILED` events (no ledger row exists yet); populated on `COMPLETED`/`REVERSED`.                             |
| `status`                | enum                     | `PENDING` \| `COMPLETED` \| `FAILED` \| `REVERSED` — derived from `event`.                                                                                         |
| `source`                | string                   | Source code (e.g. `whish`, or your source's code).                                                                                                                 |
| `externalTransactionId` | string                   | Your/the provider's id for this transaction.                                                                                                                       |
| `amount`                | string (decimal)         | Gross amount, decimal string (never a float).                                                                                                                      |
| `currency`              | string                   | ISO currency code.                                                                                                                                                 |
| `netAmount`             | string (decimal) \| null | Amount after platform fee. **`null` until `COMPLETED`** (fee unknown earlier; always null for Whish PENDING/FAILED).                                               |
| `commissionAmount`      | string (decimal) \| null | Platform fee. Same null rule as `netAmount`. NOTE: unlike the source-facing _ingest_ response, CRM events to the **company** intentionally **do** include fee/net. |
| `customer`              | string \| null           | Customer name/label, if known.                                                                                                                                     |
| `tradingAccount`        | string \| null           | The trading account (internally `target`). Null for Whish lifecycle events.                                                                                        |
| `phone`                 | string \| null           | Payer phone, if known.                                                                                                                                             |
| `note`                  | string \| null           | Free-text note / invoice.                                                                                                                                          |
| `occurredAt`            | string (ISO-8601)        | When the underlying status change happened (`processedAt` if present, else `createdAt`; for Whish lifecycle, the emit time).                                       |

#### Withdrawal events

A `withdrawal.*` event carries a `withdrawal` body **instead of** `transaction`. It mirrors the [`GET /company/withdrawals/:id`](#get-one-request) resource field-for-field, so the webhook and the REST API speak the same language. Example:

```http
POST /hooks/loadless HTTP/1.1
Host: crm.acme.example
Content-Type: application/json
Authorization: Bearer acme_crm_secret_123
x-crm-event: withdrawal.completed
x-crm-timestamp: 1750579200
x-crm-signature: t=1750579200,sha256=…
```

```json
{
  "event": "withdrawal.completed",
  "reference": "withdrawal:d4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "sentAt": "2026-06-22T09:20:00.123Z",
  "withdrawal": {
    "id": "d4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "status": "COMPLETED",
    "totalAmount": "500.00",
    "feeAmount": "5.00",
    "netAmount": "495.00",
    "currency": "USD",
    "payoutMethod": "CASH",
    "recipient": "Acme Ltd",
    "externalReference": "WIRE-88231",
    "note": "Weekly settlement",
    "adminNote": null,
    "occurredAt": "2026-06-22T09:19:58.000Z"
  }
}
```

**`withdrawal` fields** (`crmEventWithdrawalSchema`):

| Field               | Type              | Notes                                                                                                            |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                | string (uuid)     | The withdrawal id. Stable across the lifecycle; `reference` is `"withdrawal:<id>"`.                              |
| `status`            | enum              | `PENDING` \| `COMPLETED` \| `REJECTED` \| `CANCELLED` — derived from `event`.                                    |
| `totalAmount`       | string (decimal)  | What left your wallet = `netAmount + feeAmount`.                                                                 |
| `feeAmount`         | string (decimal)  | The platform fee we charged on this payout (`"0"` if no rule).                                                   |
| `netAmount`         | string (decimal)  | What the recipient receives. **`totalAmount − feeAmount = netAmount`.**                                          |
| `currency`          | string            | ISO currency code.                                                                                               |
| `payoutMethod`      | string            | `CASH` \| `WISH` \| `CRYPTO` \| `BANK_TRANSFER` \| `OTHER`.                                                      |
| `recipient`         | string \| null    | Destination label — recipient name, account holder, or wallet address, by method. Null when none applies.        |
| `externalReference` | string \| null    | Your off-platform proof the money moved (wire id, tx hash, receipt…). Set on `COMPLETED`; null before.           |
| `note`              | string \| null    | The company's own request note (immutable).                                                                      |
| `adminNote`         | string \| null    | The admin's note — e.g. the reason a request was `REJECTED`. Kept separate so neither note overwrites the other. |
| `occurredAt`        | string (ISO-8601) | When the status change happened (`processedAt` if present, else `createdAt`).                                    |

#### Which events fire, and when

**Deposit events** (`transaction.*`):

| Event                   | Trigger (verified in code)                                                                                                                                                  | `id` | net/commission |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------- |
| `transaction.pending`   | A Whish payment link is minted (`POST /integrations/whish/payments`).                                                                                                       | null | null           |
| `transaction.completed` | Any transaction is ingested/settled into the ledger (incl. Whish settlement, same `reference` as its earlier pending).                                                      | uuid | present        |
| `transaction.failed`    | Whish link creation fails, or a Whish payment is marked FAILED — via the failure callback or the background reconciler (Whish reported failure, or the link lapsed unpaid). | null | null           |
| `transaction.reversed`  | A ledger transaction is reversed.                                                                                                                                           | uuid | present        |

> A Whish payment therefore typically produces two events with the **same `reference`** (`whish:<externalId>`): `transaction.pending` then `transaction.completed`. Upsert on `reference` so it becomes one evolving record, not two.

**Withdrawal events** (`withdrawal.*`):

| Event                  | Trigger (verified in code)                                                                          | `status`  |
| ---------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `withdrawal.pending`   | A withdrawal is requested (`POST /company/withdrawals`).                                            | PENDING   |
| `withdrawal.completed` | An operator approves it — funds paid out, the fee is realized, and `externalReference` is recorded. | COMPLETED |
| `withdrawal.rejected`  | An operator rejects it — reserved funds are released; the reason is in `adminNote`.                 | REJECTED  |
| `withdrawal.cancelled` | The company cancels its own still-pending request (`POST /company/withdrawals/:id/cancel`).         | CANCELLED |

> A withdrawal produces a `withdrawal.pending` then exactly one terminal event (`completed` / `rejected` / `cancelled`), all sharing the `reference` `withdrawal:<id>`. **Payouts and loads emit no CRM events** — read their status over the REST API.

---

### Delivery, retries & how to respond

**Authenticate us**, then **respond `2xx` quickly**:

- We send `Authorization: Bearer <the apiKey you configured>`. Verify it matches before trusting the body.
- **`x-crm-signature`** — an HMAC-SHA256 signature, format `t=<unixSeconds>,sha256=<hex>`, computed over the string `` `${x-crm-timestamp}.${rawRequestBody}` `` keyed by **your configured CRM key**. This lets you verify the request truly came from us and that the body wasn't tampered with — recompute it over the **raw** body (before JSON parsing) and compare in constant time. The `t` is also the signed timestamp, so you can reject anything older than e.g. 5 minutes to defeat replays. (Sent whenever a CRM key is configured; it's additive — receivers that only check the Bearer key keep working.)
- Helper headers: `x-crm-event` (= `event`) and `x-crm-timestamp` (unix seconds, the same `t` that is signed).

Verify (Node example):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, crmKey) {
  const [, ts, sig] = header.match(/^t=(\d+),sha256=([0-9a-f]+)$/) ?? [];
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject stale (replay)
  const expected = createHmac('sha256', crmKey).update(`${ts}.${rawBody}`).digest('hex');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

- We treat **any `2xx`** as an ack (`res.ok`). Return `200` once you've persisted (or queued) the event.
- Respond within **5 seconds** — that's our hard per-attempt timeout (`AbortSignal.timeout`). A slow response is treated as a failed attempt.
- We follow redirects **manually** (`redirect: 'manual'`), i.e. a `3xx` is **not** followed and counts as a non-2xx response. Return `200` directly; don't redirect.
- Deliveries are **at-least-once**. Network blips, retries, or a duplicate immediate+sweep attempt can re-send the same `reference`/`event`. **Make your handler idempotent** (upsert by `reference`, ignore an event whose `status` you've already applied).

**Retry / backoff policy (verified in `crm-delivery.service.ts`):**

- One immediate best-effort attempt on the event, then a background sweep retries due deliveries (sweep runs ~every 20s, 50 rows/tick, cross-instance locked to avoid double-send).
- **Total attempts = 6** (1 immediate + 5 retries). Retry delays after each failure: **60s, 5m, 15m, 1h, 6h**.
- **Only transient failures are retried**: a network error/timeout, HTTP `429`, or any `5xx`. A `4xx` (`400/401/403/404/409/422`, etc.) is treated as a **permanent config error and is NOT retried** — fix your endpoint/key, the event will not come back on its own. A URL that becomes non-https/private is also failed permanently.
- Delivery state lives in `webhook_deliveries` (status `PENDING → RETRYING → DELIVERED | FAILED`); the stored response body is truncated to 2000 chars. This table is internal — there is currently **no public endpoint to query delivery status or replay a failed delivery** (see issues).

**Reference: stored delivery statuses** (`WebhookDeliveryStatus`): `PENDING`, `RETRYING`, `DELIVERED`, `FAILED`.

A minimal compliant receiver:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"received": true}
```

---

### Aside: the separate Whish "payment.paid" webhook (`company/whish/webhook`)

A distinct, older, **HMAC-signed** outbound channel that fires only when a Whish payment is paid. Configure via `GET/PUT/DELETE https://portal.rivalpayments.com/v1/company/whish/webhook` and `POST .../rotate-secret`. `PUT {"url":"https://..."}` returns `{ url, hasSecret, secret? }` — the `secret` (`whsec_…`) is returned **only** on first set / rotation, so capture it then.

Verification (verified in `whish-webhook.service.ts`): we send headers `x-whish-event: whish.payment.paid`, `x-whish-timestamp: <unix s>`, and `x-whish-signature: t=<timestamp>,sha256=<hex>`. The HMAC-SHA256 is computed over the string **`<timestamp>.<rawBody>`** keyed by your secret. To verify: recompute the HMAC over `timestamp.body`, compare in constant time, and reject if `timestamp` is not recent (replay guard). Body shape: `{ "event": "whish.payment.paid", "data": { externalId, status, amount, currency, invoice, payerPhoneNumber, transactionId, paidAt } }`. Delivery here is best-effort only (**2 attempts**, 5s timeout, no durable retry) — fall back to polling `GET /integrations/whish/payments/:ref` if you miss one.

---

_This guide documents API `v1` and is verified against the live service. Questions or an integration issue? Contact your Rival Payments account manager._
