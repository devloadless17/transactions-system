# Rival Payments — Sources Integration Guide

**Audience:** the technical team of a transaction **source** — a provider (e.g. Whish, OMT, a bank, a crypto gateway) that pushes transactions _into_ the Rival Payments platform.

This guide documents the **Ingest API**: how to discover the operating entities you may post transactions for, and how to submit a transaction. It is the only API a source needs.

> **Companies, read elsewhere.** If you are a company _receiving_ transactions and integrating your CRM / back office, see the **Companies Integration Guide** (`companies-integration-docs.md`). The company API and CRM webhooks are out of scope here.

|                    |                                                                |
| ------------------ | -------------------------------------------------------------- |
| **Base URL**       | `https://portal.rivalpayments.com/v1`                          |
| **Protocol**       | HTTPS only                                                     |
| **Content type**   | `application/json` (request and response), UTF-8               |
| **Authentication** | `Authorization: Bearer tsk_<prefix>_<secret>` (source API key) |
| **Max body size**  | 256 KB                                                         |

## Contents

- [Authentication](#authentication)
- [The response envelope](#the-response-envelope)
- [Error codes](#error-codes)
- [Money & currencies](#money--currencies)
- [Rate limits](#rate-limits)
- [Idempotency](#idempotency)
- [Ingest API](#ingest-api-source-key)

---

## Authentication

Ingest is authenticated with a **source API key** sent as a Bearer token:

```
Authorization: Bearer tsk_<prefix>_<secret>
```

- **Format** — `tsk_<prefix>_<secret>`: a `tsk` product tag, an 8-character lookup prefix, then a 64-hex-character secret. The full plaintext is shown **once** when the key is issued and is stored only as an argon2id hash — Rival can never display it again, so capture it at issuance and keep it secret.
- **Bound to one source.** Your key is tied to exactly one source. Every ingest URL contains a `:sourceCode` segment (your source code, e.g. `whish`, `omt`); it must resolve to the same source your key is bound to, or the request is rejected with **403** (`API key is not bound to this source`).
- **Issued by Rival.** Source keys are provisioned, rotated, and revoked by the Rival operations team (not self-serve). Contact your Rival account manager to obtain or roll a key. Treat rotation as: receive the new key, deploy it, confirm traffic, then have the old key revoked.
- **No CSRF.** API-key requests are not subject to CSRF (they are a server-to-server trust model).
- **Scope.** A source key may only call the ingest endpoints in this guide; company endpoints reject it with **403** (`this endpoint requires a source API key`). Keys may carry an optional expiry; expired or revoked keys verify as **401**.

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

| Code                   | HTTP   | When / `details`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`     | 400    | Request body/query failed Zod validation. `details` is the raw array of Zod issues (`[{ code, path, message, ... }]`). Also returned for invalid DB query input.                                                                                                                                                                                                                                                                                                                                 |
| `BAD_REQUEST`          | 400    | Generic 400 from a framework `HttpException` not mapped to a domain code.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `UNAUTHORIZED`         | 401    | Missing/invalid/revoked/expired API key or session.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FORBIDDEN`            | 403    | Authenticated, but not allowed for this resource or action (e.g. a failing CSRF check on a session write). Tenant isolation never surfaces here — another company's data simply doesn't exist for your key.                                                                                                                                                                                                                                                                                      |
| `NOT_FOUND`            | 404    | Entity missing. Domain `details`: `{ entity, id }`. Prisma `P2025` → bare `NOT_FOUND` (`Record not found`, no `details`).                                                                                                                                                                                                                                                                                                                                                                        |
| `CONFLICT`             | 409    | Unique/FK/state conflict. Prisma `P2002` → `details.target`; `P2003` → `details.field`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WRITE_CONFLICT`       | 409    | Serializable write conflict / deadlock (Prisma `P2034`). **Safe to retry** the same request.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `INSUFFICIENT_BALANCE` | 409    | Not enough available balance for amount (+fee). `details`: `{ currency, required, available, shortfall }`.                                                                                                                                                                                                                                                                                                                                                                                       |
| domain 422 codes       | 422    | Semantically invalid request that passed schema validation — surfaced with a **domain code**. On the source-facing ingest endpoint the internal pricing codes (`NO_COMMISSION_RULE`, `COMMISSION_EXCEEDS_AMOUNT`) are **translated at the boundary** to the neutral `ENTITY_NOT_READY` (`details: { companySlug }` only) — a source must never see our commission model or internal ids. The bare `UNPROCESSABLE` code only appears as a fallback for a framework `HttpException` raised at 422. |
| `RATE_LIMITED`         | 429    | Rate limit exceeded (see [Rate limits](#rate-limits)).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `INTERNAL_ERROR`       | 500    | Unexpected server error. Internals are never leaked in `message`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DB_<code>`            | 400    | Unmapped known Prisma error; surfaces the Prisma code (e.g. `DB_P2000`) but no internals.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `HTTP_<status>`        | varies | Framework `HttpException` at a status with no named mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
- At most **2 fractional digits** (whole cents — the platform money scale) and at most **12 integer digits**. A value with more precision is **not rejected**: we quantize it to cents once, on receipt, and everything downstream derives from that figure. The deposit already happened on your side, so we will never 400 it back to you over a sub-cent tail.

Always send and parse amounts as strings to avoid floating-point drift.

| Field      | Type             | Req | Notes                                                                                           |
| ---------- | ---------------- | --- | ----------------------------------------------------------------------------------------------- |
| `amount`   | string (decimal) | yes | e.g. `"250.00"`. Max 12 integer digits; quantized to 2 fractional digits on receipt.            |
| `currency` | enum             | yes | Validated by `currencySchema`. **Supported values: `USD` only** today (`SUPPORTED_CURRENCIES`). |

Timestamps are ISO-8601 strings (e.g. `"2026-06-22T14:05:00.000Z"`).

### Rate limits

**Accepted ingest is NOT rate-limited by default.** A source calling this endpoint is pushing money that has already left the payer, so refusing it cannot slow anything down — it can only strand real funds behind a partner's retry logic. Ingest also opts out of the global per-IP throttle, so a high-volume provider egressing from one IP is never capped.

- `INGEST_RATE_LIMIT_MAX` (server env, **default `0` = unlimited**) can set a per-key, per-minute ceiling to rein in one misbehaving partner. Tunable without a deploy. **If you ever set it, add a `429` row to the partner-facing guide** — otherwise a throttled partner has no documented recovery path.
- What IS always limited is **failed authentication**: `AUTH_FAILURE_MAX_PER_MIN` (default 20) per client IP. That is the surface an attacker hammers — key guessing, plus argon2 CPU burn once a valid 8-char prefix is known — and the check runs _before_ verification, so a blocked attacker never costs a hash. A valid key never counts toward it, and a successful auth clears the IP's budget, so a real partner sharing an egress IP can't be locked out.
- Both limiters fail **open** if the backing store is briefly unavailable (traffic is allowed through unmetered).
- When a ceiling IS configured, every response carries `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` (seconds until the window resets); a 429 additionally sets `Retry-After`.

A 429 (from either limiter) uses the standard flat envelope:

```json
{
  "success": false,
  "statusCode": 429,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded: 20 requests per 60s",
    "details": { "limit": 20, "windowSeconds": 60 }
  }
}
```

### Idempotency

Every ingest request may carry an optional **`idempotencyKey`** (8–120 chars) in the body. Send a stable key per logical transaction so that a retry — after a network timeout, a `WRITE_CONFLICT` (409), or any ambiguous failure — returns the original booking instead of creating a duplicate. A replay is flagged in the response with **`"replayed": true`** (and books no new money). The `(source, externalTransactionId)` pair is also deduplicated, so even without an `idempotencyKey` a repeat returns the original. See [Ingest API](#ingest-api-source-key) for exact semantics.

---

## Ingest API (source-key)

Endpoints for external payment/transfer providers ("sources" — OMT, Whish, bank transfer, …) to push completed transactions into the platform and discover which companies they may push to. **These two endpoints are the only ones that accept a SOURCE API key**, and a source key is rejected on every other (`company/*`) route.

- **Auth:** `Authorization: Bearer tsk_<prefix>_<secret>` where the key is a _source_ key. The key is bound to exactly one source; for the POST route the `:sourceCode` in the URL **must** name that same source or the call is rejected `403 FORBIDDEN`.
- **No CSRF.** API-key requests skip CSRF entirely.
- **Rate limit:** accepted ingest is **unlimited by default** (`IngestRateLimitGuard`, `INGEST_RATE_LIMIT_MAX=0`) — see [Rate limits](#rate-limits). Failed authentication is limited per IP (`AUTH_FAILURE_MAX_PER_MIN`, default 20). Both fail **open** if Redis is unavailable.
- **Envelope:** standard `{ success, statusCode, data }` on success, `{ success, statusCode, error }` on failure. `POST` returns **201**, `GET` returns **200**.
- Every ingest attempt that reaches the endpoint handler — success **and** 4xx/5xx rejection — is recorded server-side as a `TransactionLog` (raw request body + the exact response envelope you received), best-effort and off the money path. Guard-stage rejections (401 invalid key, 403 wrong source, 429) happen before the handler and are captured in the server logs, not in `transaction_logs`.

---

### POST /v1/ingest/:sourceCode/transactions

Ingest one completed transaction for a company. The transaction is booked atomically as `status: "COMPLETED"` — the platform computes its own fee from a commission rule, credits the company's wallet with the net, and writes the double-entry ledger. **The response deliberately omits the fee and net amounts** — a source must never see what the platform charges.

`:sourceCode` is a lowercase slug (`omt`, `wish_money_code`, `bank_transfer`), regex `^[a-z0-9][a-z0-9_-]{0,49}$`. It must resolve to a source **and** match the source your key is bound to.

#### Request body

| Field                    | Type             | Req | Notes                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companySlug`            | string           | yes | The target company's slug, as provided by Rival (or from `GET /v1/ingest/companies`). Company must be `ACTIVE`. `visible` only controls **discovery** (`GET /v1/ingest/companies`); a hidden-but-`ACTIVE` company still accepts ingest. An unknown or inactive company → `400 VALIDATION_ERROR`. Company UUIDs are never exposed to sources. |
| `externalTransactionId`  | string           | yes | Your reference for this transaction. Trimmed, 1–200 chars. **Forms the natural idempotency key** with the source — see Idempotency.                                                                                                                                                                                                          |
| `amount`                 | string (decimal) | yes | Decimal **string**, never a float. ≤12 integer digits; extra fractional precision is quantized to cents rather than rejected. Must be **positive after rounding to cents** (a value that rounds to 0 is rejected `400`).                                                                                                                     |
| `currency`               | string           | yes | ISO-4217 enum. **Only `USD` is currently supported** — any other value → `400 VALIDATION_ERROR`.                                                                                                                                                                                                                                             |
| `payload`                | object           | no  | Descriptive details, defaults to `{}`. Known string fields below; **any extra keys are stored verbatim** (passthrough) for audit.                                                                                                                                                                                                            |
| `payload.customer`       | string           | no  | Who paid. ≤200 chars.                                                                                                                                                                                                                                                                                                                        |
| `payload.tradingAccount` | string           | no  | The account/wallet they paid into. ≤200 chars. (Stored internally as `target`; echoed back as `tradingAccount`.)                                                                                                                                                                                                                             |
| `payload.phone`          | string           | no  | Contact phone. ≤40 chars.                                                                                                                                                                                                                                                                                                                    |
| `payload.note`           | string           | no  | Free note. ≤1000 chars.                                                                                                                                                                                                                                                                                                                      |
| `idempotencyKey`         | string           | no  | Optional explicit key, 8–120 chars. If omitted, `(source, externalTransactionId)` is the idempotency key.                                                                                                                                                                                                                                    |

> Note the field-name boundary: externally you send `companySlug` and `payload.tradingAccount`; the rest of the platform (other APIs, CSV exports, dashboard) speaks `companyId` (a UUID, resolved from the slug at this boundary) and `target`. The translation exists **only** on these two ingest endpoints — internal UUIDs never cross them in either direction.

#### Pricing & ledger (what happens on a new ingest)

The platform resolves a **commission rule** for `(company, source, amount)`:

- `DEDUCTED`: company is credited `amount − fee`; the outside owes `amount`.
- `ON_TOP`: company is credited the full `amount`; the outside owes `amount + fee`.

The wallet's available balance increases by the net; the fee is platform revenue. **Pricing can never bounce a deposit** — money that already entered the system must book:

- **No active commission rule matches** (internally `NO_COMMISSION_RULE` — no longer thrown on this endpoint): the deposit books **unpriced at net 0** — the full amount is withheld as platform fee, the company is credited nothing, and operators are alerted automatically (metric + deduped alert) to configure pricing and compensate. Withholding is recoverable by a later credit; bouncing would strand money the source cannot re-send.
- **A `DEDUCTED` fee computes larger than the amount** (internally `COMMISSION_EXCEEDS_AMOUNT` — no longer thrown on this endpoint): the fee is **capped at the amount** — same net-0 booking, operators warned to fix the rule. Both codes remain possible on money-out flows and on the internal Whish settlement path (which deliberately stays strict: a parked link later settles at the CORRECT fee), where rejecting is the safe behaviour.

Both net-0 cases are stamped on the row (`pricing_issue` = `unpriced` \| `capped`), so the operator compensation set is one query away, and each increments `txn_ingest_pricing_issue_total` plus a deduped operator alert.

Companies are configured with pricing at onboarding (a starter rule is seeded at company creation), so both cases are near-impossible in practice. As defense in depth, if any future pricing error ever did surface on this endpoint, the boundary translates it to the neutral **`ENTITY_NOT_READY`** (`422`, `details: { companySlug }`) — the commission model and internal identifiers never cross the source boundary. It is deliberately absent from the partner-facing doc because it cannot occur.

#### Idempotency (precise)

A repeat is treated as a **replay** (no new money, no duplicate row) when **either**:

1. **Explicit key:** a transaction already exists for the **same company** with the same `idempotencyKey`, **or**
2. **Natural key:** a transaction already exists for the **same source** with the same `externalTransactionId`.

A replay returns the **existing** transaction with the **same `201`** status, plus **`"replayed": true`** in the body so you can distinguish it from a fresh booking (a newly-created transaction has `"replayed": false`). A replay books no new money.

**Cross-company collision:** the `(source, externalTransactionId)` uniqueness is **global across companies** (`@@unique([sourceId, externalTransactionId])`). Reusing one `externalTransactionId` for a _different_ `companySlug` is **not** a replay — it hits the global unique constraint and fails **`409 DUPLICATE_TRANSACTION`** (with `error.details.externalTransactionId`). Always keep `externalTransactionId` unique per real-world transaction across all companies you push to.

#### Success response (201)

> Amounts are echoed in canonical decimal form with trailing zeros dropped — e.g. an `amount` of `"150.00"` round-trips as `"150"`. Compare numerically, not by raw string equality.

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "8f2c1a9e-3b4d-4e21-9c7a-1d2e3f405162",
    "companySlug": "acme-trading",
    "sourceCode": "omt",
    "externalTransactionId": "OMT-2026-0001",
    "amount": "150",
    "currency": "USD",
    "status": "COMPLETED",
    "customer": "Jane Doe",
    "tradingAccount": "ACC-55",
    "phone": "+9613000000",
    "note": "branch 12",
    "processedAt": "2026-06-22T10:15:30.000Z",
    "createdAt": "2026-06-22T10:15:30.000Z",
    "replayed": false
  }
}
```

There is **no `commissionAmount` / `netAmount`** in this payload — by design. `replayed` is `true` only when this request matched an existing transaction (idempotent replay); see [Idempotency](#idempotency-precise).

#### Example request

```bash
curl -X POST "https://portal.rivalpayments.com/v1/ingest/omt/transactions" \
  -H "Authorization: Bearer tsk_omtlive_9a8b7c6d5e4f..." \
  -H "Content-Type: application/json" \
  -d '{
    "companySlug": "acme-trading",
    "externalTransactionId": "OMT-2026-0001",
    "amount": "150",
    "currency": "USD",
    "idempotencyKey": "omt-20260622-0001",
    "payload": {
      "customer": "Jane Doe",
      "tradingAccount": "ACC-55",
      "phone": "+9613000000",
      "note": "branch 12",
      "branchCode": "B-12"
    }
  }'
```

#### Error responses

Key/URL mismatch — the bearer key is not bound to the `:sourceCode` in the path:

```json
{
  "success": false,
  "statusCode": 403,
  "error": { "code": "FORBIDDEN", "message": "API key is not bound to this source" }
}
```

Defensive-only (cannot occur today — unpriced/over-fee'd deposits book at net 0
instead; kept for completeness in case a future pricing error is ever surfaced):

```json
{
  "success": false,
  "statusCode": 422,
  "error": {
    "code": "ENTITY_NOT_READY",
    "message": "Entity 'acme-trading' cannot accept transactions right now. Contact Rival Payments.",
    "details": { "companySlug": "acme-trading" }
  }
}
```

Validation failure (e.g. bad currency or non-decimal amount):

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": ["currency"], "message": "Invalid enum value..." }]
  }
}
```

Other statuses you may see: `401 UNAUTHORIZED` (missing/invalid/revoked key), `403 FORBIDDEN` (your key's source doesn't match `:sourceCode`, or that source is inactive — `visible` is **not** an ingest gate, so a hidden company is never a 403), `400 VALIDATION_ERROR` (unknown/inactive `companySlug`, or — defensively — an inactive source), `409 DUPLICATE_TRANSACTION` (cross-company `externalTransactionId` collision), `429 RATE_LIMITED`. (`422 ENTITY_NOT_READY` is defensive-only and cannot occur today — pricing gaps book at net 0 instead; see Pricing & ledger.)

---

### GET /v1/ingest/companies

Discovery: list every company you may ingest for. Call once on startup, cache the `slug`s, then use them as `companySlug` in `POST`. Returns only companies that are **`ACTIVE` and flagged `visible`** by a platform admin. `visible` governs **this discovery list only** — it does not gate ingest, so a company hidden after you cached its slug still accepts deposits. Source-key only. In practice most sources never call this — Rival hands them their slugs directly (this endpoint is intentionally left out of partner-facing docs).

#### Query / params

None.

#### Response fields (per item in `data`)

| Field             | Type   | Notes                                             |
| ----------------- | ------ | ------------------------------------------------- |
| `slug`            | string | Use this as `companySlug` in the POST body.       |
| `name`            | string | Company display name.                             |
| `defaultCurrency` | string | The company's default currency (currently `USD`). |

#### Success response (200)

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "slug": "acme-trading",
        "name": "Acme Trading Co.",
        "defaultCurrency": "USD"
      }
    ]
  }
}
```

> The list lives at `data.data` (the handler returns `{ data: [...] }`, which the envelope then wraps under `data`). The array is **unpaginated** — it returns all visible companies in one response, ordered by `slug`.

#### Example request

```bash
curl "https://portal.rivalpayments.com/v1/ingest/companies" \
  -H "Authorization: Bearer tsk_omtlive_9a8b7c6d5e4f..."
```

A company key (or no key) → `403 FORBIDDEN` "this endpoint requires a source API key".

---

_This guide documents API `v1` and is verified against the live service. Questions? Contact your Rival Payments integration contact._
