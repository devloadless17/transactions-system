# Company Developer Guide

A single, self-contained reference for integrating with the platform over the API — everything the in-dashboard **Documentation** pages cover, in one document you can hand to your engineering team.

It is organised as four sections, in the order you'll meet them:

1. **[Getting started](#1-getting-started)** — base URL, authentication, the response envelope, error codes, rate limits.
2. **[Whish Pay](#2-whish-pay)** — collect payments with a hosted link.
3. **[Company API](#3-company-api)** — wallets, transactions, withdrawals, payouts, loads, and reading your data.
4. **[CRM integration](#4-crm-integration)** — receive every deposit and withdrawal event as it happens.

> Throughout this guide the API base URL is written as `https://<your-dashboard-domain>/v1`. The API shares an origin with your dashboard, so it is simply the same domain you sign in to, followed by `/v1`. Replace `tsk_<company-key>` with a real key minted under **Settings → API keys**.

---

## 1. Getting started

Everything you need to call the API: one base URL, a single Bearer key, and the same response shape everywhere. Plain HTTPS and JSON — no SDK required.

### Base URL

Every endpoint lives under this base. All paths in this guide are written relative to it and are prefixed with `/v1`.

```
https://<your-dashboard-domain>/v1
```

### Authentication

Send your key as a Bearer token on **every** request. No cookies and no CSRF header — these are server-to-server keys.

```
Authorization: Bearer tsk_<prefix>_<secret>
```

**Company key** — _You, the company._ Full access to your own company's money and data: wallets, transactions, withdrawals, payouts, loads, Whish Pay, and activity. This is the key you'll use for every call in the [Company API](#3-company-api) section.

> **Management actions are dashboard-only.** Minting/rotating/revoking API keys, managing team members, and setting or clearing your CRM webhook config (`PUT`/`DELETE /company/crm/config`, `POST /company/crm/demo/enable`) cannot be done with an API key — they require a signed-in dashboard session and return `403 FORBIDDEN` otherwise. Reading that config with a key is fine. This is deliberate: a leaked key can never be used to mint more keys, add users, or redirect your CRM traffic.

> Secrets are shown **once**, at creation. Mint, rotate, or revoke a company key under **Settings → API keys** in the dashboard.

**Send the header exactly as shown — it is case-sensitive.** `bearer tsk_...`, `BEARER tsk_...`, `Bearer TSK_...`, a bare `tsk_...` with no scheme, or a quoted value are not recognised as keys and come back as `401 UNAUTHORIZED` ("Malformed API key credential…"). If one call 401s while others with the same key succeed, compare that request's header byte-for-byte — and make sure your client actually substituted the key variable — before rotating anything. Keys never expire unless you set an expiry when creating them.

**No IP allowlisting.** There is no allowlist to register and no IP check anywhere, so you can call us from any server and move or scale freely. Your credential is the key (keep it server-side); our webhooks prove themselves with an HMAC signature you verify, not with a source IP.

### Every response has the same shape

Success or failure, responses come back wrapped in an envelope. Read your payload from `data`.

**Success**

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    /* your payload */
  }
}
```

**Error**

```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "amount must be a positive decimal",
    "details": {
      /* optional, field-level */
    }
  }
}
```

- **Lists** nest one level deeper — the array is at `data.data` alongside a total count / paging info in `meta`.
- **A few endpoints** return raw bodies (no envelope): CSV exports (`/export.csv`), the health check, and inbound webhook/callback acknowledgements.

### Error codes

Branch on the stable `error.code`, never on the message.

| Code                 | HTTP | Meaning                                            |
| -------------------- | ---- | -------------------------------------------------- |
| `VALIDATION_ERROR`   | 400  | The request body or query failed validation.       |
| `UNAUTHORIZED`       | 401  | Missing, invalid, or revoked API key.              |
| `FORBIDDEN`          | 403  | The key is valid but not allowed to do this.       |
| `NOT_FOUND`          | 404  | No such resource for your company.                 |
| `CONFLICT`           | 409  | Duplicate or conflicting request (e.g. reused id). |
| `NO_COMMISSION_RULE` | 422  | No active commission rule covers this amount.      |
| `RATE_LIMITED`       | 429  | Too many requests — slow down and retry.           |

### Rate limits

The per-key integration endpoint — `/v1/integrations/whish/*` — allows **300 requests per 60 seconds, per key**. Go over and you get a `429 RATE_LIMITED` with the limit echoed in `error.details`, plus `RateLimit-*` headers on every response so you can self-pace.

Everything under `/v1/company/*` (wallets, transactions, withdrawals, payouts, loads, and `/company/whish/payments`) sits behind the global safety throttle instead — **100 requests per 60 seconds, per IP** by default, with no `RateLimit-*` headers. Note that `/v1/company/whish/payments` is the dashboard-side twin of the Whish Pay endpoints and is throttled per IP, not per key.

### Your first call

Check connectivity (no key needed), then read your balances with your company key.

```bash
# 1) Is the API up?  (no key needed)
curl https://<your-dashboard-domain>/v1/health

# 2) Read your balances  (company key)
curl https://<your-dashboard-domain>/v1/company/wallets \
  -H "Authorization: Bearer tsk_<company-key>"
```

---

## 2. Whish Pay

Collect payments with a hosted link — by hand on the **Whish Pay** page in the dashboard, or from your own backend via the API below. Share the link with your customer and the money settles into your wallet automatically once they pay — net of commission, with no card details ever touching your system.

### How it works

1. **Create a link** — On the Whish Pay page (or via the API below), enter the amount and an invoice label.
2. **Share it** — Send the generated link to your customer; they pay on the secure Whish page.
3. **It settles automatically** — Once paid, we verify with Whish, apply your commission, and credit your wallet with the net.
4. **Stay in sync** — The transaction is pushed to your CRM at every step (pending, then paid or failed), so your records update on their own.

### Create links from your backend (API)

Authenticate with your company key (see [Getting started](#1-getting-started)). These are server-to-server endpoints — Bearer key, no cookies, no CSRF.

**1. Create a payment link**

```bash
curl -X POST https://<your-dashboard-domain>/v1/integrations/whish/payments \
  -H "Authorization: Bearer tsk_<company-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "25.00",
    "currency": "USD",
    "invoice": "Order #4821"
  }'
```

**Request fields**

| Field                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount`             | A decimal **string in quotes** — `"25.00"`, never the bare number `25.00`. Whish recommends at most **2 decimal places** (cents) and a **minimum 1.00** for USD; other amounts are still accepted and forwarded. A commission rule (set by your platform admin) must cover it, otherwise you get `422 NO_COMMISSION_RULE`. The amount is **fixed on the hosted page** — your customer cannot pay more or less, so partial and over-payments are impossible and every callback carries this exact figure. |
| `currency`           | Exactly `"USD"` (uppercase) — the only currency this platform currently enables for Whish links. Anything else is a `400 VALIDATION_ERROR`.                                                                                                                                                                                                                                                                                                                                                              |
| `invoice`            | **Required.** Your own order/reference label (1–200 chars). Shown back on the payment.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `idempotencyKey`     | Optional (8–120 chars). A retried create with the same key returns the original link instead of minting a duplicate — safe to retry on a network error. Matching is on the **key alone**: reuse it with a different amount and you silently get the first payment back, so use a fresh key per order.                                                                                                                                                                                                    |
| `successRedirectUrl` | Optional (http/https). Where your customer is sent after a successful payment — overrides your saved default for this one link. We append `?ref=<externalId>` so your page can identify it.                                                                                                                                                                                                                                                                                                              |
| `failureRedirectUrl` | Optional. Same, for a failed or abandoned payment.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Response**

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "6729acd0-16c4-40ff-8474-4ef864538587",
    "companyId": "b3f1c2d4-...-e9",
    "externalId": "1781018591",
    "status": "PENDING",
    "amount": "25.00",
    "currency": "USD",
    "invoice": "Order #4821",
    "collectUrl": "https://whish.money/collect/7kEo2a7",
    "payerPhoneNumber": null,
    "transactionId": null,
    "needsAttention": false,
    "settlementError": null,
    "paidAt": null,
    "createdAt": "2026-06-04T12:00:00.000Z"
  }
}
```

> `needsAttention: true` means Whish took the money but settlement into your wallet failed (e.g. a commission rule changed). `settlementError` holds the reason; once your platform admin fixes the cause, refresh the payment and it settles.

Send `collectUrl` to your customer and store `externalId` on your order — it is the reference you use to look the payment up and the same id every CRM event carries.

> **Where your customer lands after paying:** set default success / failure pages once on the Whish Pay page, or override per link with `successRedirectUrl` / `failureRedirectUrl` above. Set neither and we use our own confirmation pages. We always append `?ref=<externalId>` so your page knows which payment it was. (These are customer redirects only — the money reaches you via the CRM / status, not these URLs.)

**2. Check a payment's status**

```bash
curl https://<your-dashboard-domain>/v1/integrations/whish/payments/1781018591 \
  -H "Authorization: Bearer tsk_<company-key>"
```

Same shape as create. Watch `status` (and `transactionId` once PAID). This object shows only the **gross** amount. For the fee we took + your net, read the settled transaction (reference `whish:<externalId>`): `GET /company/transactions` returns `commissionAmount` + `netAmount` (also sent on the `transaction.completed` CRM event).

Force a fresh pull from Whish (e.g. after a missed callback) with:

```
POST /integrations/whish/payments/{externalId}/refresh
```

**Statuses**

| Status    | Meaning                                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING` | Link created, waiting for the customer to pay.                                                                                                                                                                                                                                                           |
| `PAID`    | Customer paid — settled into your wallet (net of commission); `transactionId` is set.                                                                                                                                                                                                                    |
| `FAILED`  | The payment will not be collected — the link lapsed unpaid, or a completed payment was refunded. (Whish reports no separate "expired", so a lapsed link also arrives as FAILED.) A single failed _attempt_ does NOT close the link: the customer can retry on the same link while it is still `PENDING`. |

> **These are payment-link statuses.** The same deposit also exists as a ledger **transaction**, with its own names: link `PAID` = transaction `COMPLETED` (event `transaction.completed`), link `FAILED` = event `transaction.failed`, link `PENDING` = event `transaction.pending` (no transaction row yet). There is no `EXPIRED` status in practice — nothing ever writes it. **Withdrawals are a third set again** — `PENDING` → `COMPLETED` / `REJECTED` / `CANCELLED`, plus a transient `PROCESSING` — so a withdrawal is never `PAID` and a link is never `CANCELLED`. Validate statuses against the object you actually queried.

**Common errors**

| Error                           | Meaning                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 VALIDATION_ERROR`          | A field is malformed — most often `amount` sent as a number instead of a `"string"`, a currency other than `"USD"`, or a missing `invoice`. The error body names the offending field.                                                                                                                                                                                      |
| `422 NO_COMMISSION_RULE`        | No commission rule covers this amount for your company, so the link is refused before any customer pays. Ask your platform admin to add a rule covering your amounts.                                                                                                                                                                                                      |
| `422 COMMISSION_EXCEEDS_AMOUNT` | The configured fee for this amount is larger than the amount itself, so the link is refused before any customer pays. Ask your platform admin to review the rule for small amounts.                                                                                                                                                                                        |
| `401 / 403`                     | Auth failed. Send your company key as `Authorization: Bearer tsk_…` — these are server-to-server (no cookies/session).                                                                                                                                                                                                                                                     |
| `502 WHISH_ERROR`               | Whish itself errored or was unreachable. Safe to retry (reuse your `idempotencyKey`); if it persists, contact support.                                                                                                                                                                                                                                                     |
| `502 WHISH_PENDING`             | We could not confirm the outcome with Whish — **this is not a failure.** The payment may exist upstream. Do **not** create a second payment under a new key. `error.details` carries `externalId` and `paymentId`; retry the create with the **same** `idempotencyKey` (we re-attempt the same payment and return it with its `collectUrl`), or look it up by `paymentId`. |
| `needsAttention: true`          | Created and paid, but settlement into your wallet failed — read `settlementError` for the reason. Once the cause is fixed, refresh the payment and it settles.                                                                                                                                                                                                             |

> **No need to poll:** every payment is pushed to your CRM automatically — `transaction.pending` when the link is created, then `transaction.completed` once it settles (or `transaction.failed` if it is declined or lapses), all under the same `whish:<externalId>` reference (see the [CRM](#4-crm-integration) section). The status endpoint above is just for reconciliation or if you do not use a CRM.

---

## 3. Company API

Your company key unlocks your whole account over plain HTTPS — read transactions, wallets, ledger, and analytics, and request withdrawals, payouts, and loads. Authentication and the response envelope are covered in [Getting started](#1-getting-started).

### 3.1 Check your balances

Returns `availableBalance` (spendable) and `reservedBalance` (held for pending outflows) per currency. Check this before requesting a withdrawal to avoid an insufficient-funds error.

```bash
curl https://<your-dashboard-domain>/v1/company/wallets \
  -H "Authorization: Bearer tsk_<company-key>"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "currency": "USD",
        "availableBalance": "1250.00",
        "pendingBalance": "0",
        "reservedBalance": "200.00"
      }
    ]
  }
}
```

> The wallets array is at `data.data` (the envelope wraps the list body).

### 3.2 Request a withdrawal, payout, or load

All three share the **same body** — only the path differs: `/company/withdrawals`, `/company/payouts`, or `/company/loads`. Requests land in **PENDING** and need platform-admin approval before any funds move.

**Payout method — choose one**

| Method   | Required                          | Optional                         |
| -------- | --------------------------------- | -------------------------------- |
| `CASH`   | `recipientName`, `recipientPhone` | `pickupLocation`, `instructions` |
| `WISH`   | `recipientName`, `recipientPhone` | `instructions`                   |
| `CRYPTO` | `network`, `walletAddress`        | `memo`, `instructions`           |

> **`recipientPhone` format.** The `+961-3-000-000` style used in these examples is just an example — send the number however suits you (6–15 digits, with optional `+`, spaces, dashes or parens; plain international like `+96170000000` is simplest, and separators are stripped before the payout runs). One extra rule applies on create for **Lebanese** numbers: after the `961` / `00961` country code there must be exactly **8 digits**, or **7** when the national part starts with `3`. So `+96170000000` and `+9613702825` pass, while `9617075183` is rejected with `400 VALIDATION_ERROR`. This applies to withdrawals, payouts and loads; `CASH` recipient phones are free-form (4–30 characters).

**CASH example**

```bash
curl -X POST https://<your-dashboard-domain>/v1/company/withdrawals \
  -H "Authorization: Bearer tsk_<company-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "500.00",
    "currency": "USD",
    "notes": "Weekly settlement",
    "payout": {
      "method": "CASH",
      "recipientName": "Acme Ltd",
      "recipientPhone": "+961-3-000-000"
    }
  }'
```

**WISH example**

```bash
curl -X POST https://<your-dashboard-domain>/v1/company/withdrawals \
  -H "Authorization: Bearer tsk_<company-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "200.00",
    "currency": "USD",
    "payout": {
      "method": "WISH",
      "recipientName": "John Doe",
      "recipientPhone": "+961-70-000-000"
    }
  }'
```

**CRYPTO example**

```bash
curl -X POST https://<your-dashboard-domain>/v1/company/withdrawals \
  -H "Authorization: Bearer tsk_<company-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "100.00",
    "currency": "USD",
    "payout": {
      "method": "CRYPTO",
      "network": "TRC20",
      "walletAddress": "TXyz...abc"
    }
  }'
```

**Response (201 Created)**

```json
{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "PENDING",
    "amount": "500.00",
    "currency": "USD",
    "feeAmount": "5.00",
    "feeApplication": "DEDUCTED",
    "netAmount": "495.00",
    "totalAmount": "500.00",
    "payoutMethod": "CASH",
    "createdAt": "2026-06-10T10:00:00.000Z"
  }
}
```

Fees are returned up front:

- `feeAmount` — the platform fee on this payout.
- `feeApplication` — `DEDUCTED` → recipient gets `netAmount` (amount − fee). `ON_TOP` → recipient gets the full `amount` and the fee is added, so `totalAmount = amount + fee`.
- `netAmount` — what the recipient receives.
- `totalAmount` — what leaves your wallet (net + fee).

> **You can't choose `feeApplication` per request.** It comes from the commission rule your platform admin configures for your company and operation type; sending it in the body has no effect. If you'd rather recipients received the full requested amount and the fee were billed to your wallet, ask your account manager to set that rule to `ON_TOP`.

> **No idempotency key, and no field for your own order number.** Retrying a create after a timeout makes a **second** request and reserves the funds again — so on an ambiguous failure, call `GET /company/withdrawals?status=PENDING` and match on amount + payout details before retrying. To carry your own reference, put it in `notes` (≤ 500 chars): it is stored immutably, comes back on every read, and is echoed as `note` on the matching CRM event. For matching our records, use the `id` from the create response — the CRM event's `reference` is just `withdrawal:` + that id.

### 3.3 Status lifecycle

Every withdrawal, payout, and load moves through these statuses.

| Status       | Meaning                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING`    | Submitted — awaiting review.                                                                                                                                                                                                                                                                             |
| `PROCESSING` | Withdrawals only: the payout is being sent to the provider. Transient — it settles to `COMPLETED`, or returns to `PENDING` if the transfer doesn't go through. **You cannot cancel while `PROCESSING`** — `POST /company/withdrawals/:id/cancel` returns `409 CONFLICT`; wait for it to leave the state. |
| `APPROVED`   | Exists in the status enum but is **not produced today** — approvals settle straight to `COMPLETED` in one step. Accepted as a `?status=` filter, it simply matches nothing.                                                                                                                              |
| `COMPLETED`  | Funds delivered. Ledger entry finalised.                                                                                                                                                                                                                                                                 |
| `REJECTED`   | The request was rejected. Reserved funds released.                                                                                                                                                                                                                                                       |
| `CANCELLED`  | You cancelled it (only possible while PENDING). Reserved funds released.                                                                                                                                                                                                                                 |

> Treat this list as open-ended: handle unknown statuses gracefully rather than failing, so a future status can't break your integration. `PENDING`, `COMPLETED`, `REJECTED` and `CANCELLED` are the four you'll see in normal operation.

> **These are the same values the webhooks carry.** `GET /company/withdrawals/:id` and the matching `withdrawal.*` CRM event report identical statuses, so you can poll, subscribe, or do both without translating anything. Note these are withdrawal statuses — Whish payment links use a different set (`PENDING` / `PAID` / `FAILED`); see [§2](#2-whish-pay).

> **Withdrawals push to your CRM.** Every withdrawal status change — pending, completed, rejected, cancelled — is delivered to your [CRM webhook](#4-crm-integration) in real time, carrying the same `feeAmount` / `netAmount` / `totalAmount` breakdown, so you never have to poll. Payouts and loads are managed over this API only — read their status with the GET below.

**Check a request's status**

Fetch a single request by id anytime to read its current `status`: `GET /company/withdrawals/:id` (same shape for `payouts` and `loads`). For a rejected request the reason is in `adminNotes`; your original request note stays in `notes`. You can also list and filter by status, e.g. `GET /company/withdrawals?status=PENDING`.

```bash
curl https://<your-dashboard-domain>/v1/company/withdrawals/<id> \
  -H "Authorization: Bearer tsk_<company-key>"
```

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "COMPLETED",
    "amount": "500.00",
    "currency": "USD",
    "feeAmount": "5.00",
    "feeApplication": "DEDUCTED",
    "netAmount": "495.00",
    "totalAmount": "500.00",
    "payoutMethod": "CASH",
    "externalReference": "WIRE-88231",
    "notes": "Weekly settlement",
    "adminNotes": null,
    "createdAt": "2026-06-10T10:00:00.000Z",
    "processedAt": "2026-06-10T11:30:00.000Z"
  }
}
```

- `externalReference` — our proof we sent it (set on approval).
- `notes` — your original request note (never overwritten).
- `adminNotes` — set to the reason if a request is `REJECTED`.

Same path shape for payouts and loads: `/company/payouts/<id>`, `/company/loads/<id>`.

**Cancel while still PENDING** — `POST /company/withdrawals/:id/cancel` (same path shape for payouts and loads):

```bash
curl -X POST https://<your-dashboard-domain>/v1/company/withdrawals/<id>/cancel \
  -H "Authorization: Bearer tsk_<company-key>" \
  -H "Content-Type: application/json" \
  -d '{ "notes": "No longer needed" }'
```

### 3.4 Read your data

Transactions, ledger, and analytics are all read with a simple GET. Lists are paginated (the array is at `data.data`); CSV exports stream the raw file.

```bash
curl "https://<your-dashboard-domain>/v1/company/transactions?page=1&pageSize=20" \
  -H "Authorization: Bearer tsk_<company-key>"
```

The list array is at `data.data`, with paging info at `meta`. Page with `?page=N&pageSize=M` (`pageSize` max 100).

> **Fees are transparent.** Every transaction returns `amount` (gross), `commissionAmount` (the platform fee we took), and `netAmount` (what you were credited). Withdrawals, payouts and loads return the same breakdown as `totalAmount` / `feeAmount` / `netAmount` — so after any completed transaction you always know exactly what we charged.

### 3.5 All endpoints at a glance

These `company/*` routes accept your company key.

| Group        | Endpoints                                                             |
| ------------ | --------------------------------------------------------------------- |
| Wallets      | `GET /company/wallets`                                                |
| Transactions | `GET /company/transactions` · `/:id` · `/:id/detail` · `/export.csv`  |
| Ledger       | `GET /company/ledger` · `/export.csv`                                 |
| Analytics    | `GET /company/analytics/overview` · `/wallet-summary`                 |
| Activity     | `GET /company/activity` · `/operations/counts`                        |
| Withdrawals  | `GET /company/withdrawals` · `GET /:id` · `POST` · `POST /:id/cancel` |
| Payouts      | `GET /company/payouts` · `GET /:id` · `POST` · `POST /:id/cancel`     |
| Loads        | `GET /company/loads` · `GET /:id` · `POST` · `POST /:id/cancel`       |

**Dashboard session only — these reject an API key with `403 FORBIDDEN`:** `company/api-keys` (list, create, rotate, revoke), `company/team` (list, invite, update, remove), `PUT`/`DELETE /company/crm/config`, and `POST /company/crm/demo/enable`. Use the dashboard for these. Reading the CRM config (`GET /company/crm/config`) does work with a key.

Collecting payments? See [Whish Pay](#2-whish-pay). Pushing transactions to your CRM? See [CRM integration](#4-crm-integration).

### 3.6 Health check

A no-auth, no-side-effects sanity check.

```bash
curl https://<your-dashboard-domain>/v1/health
```

---

## 4. CRM integration

We POST every deposit and withdrawal to your CRM as its status changes — a deposit moves pending → completed (or failed if it doesn't go through / lapses, and reversed); a withdrawal moves pending → completed, rejected, or cancelled. Records are matched by a stable `reference`, so your CRM updates the same row in place. (Payouts and loads are managed over the API only — they are not pushed here.)

### 4.1 Configure your CRM endpoint

Set the POST URL of your CRM and the API key it expects in the dashboard (**Documentation → CRM**). This is a dashboard-only action — `PUT /company/crm/config` rejects API keys, so a leaked key can't redirect your CRM traffic. We send the key as `Authorization: Bearer <key>` on every request.

- **CRM POST URL** — e.g. `https://your-crm.com/api/transactions`
- **API key** — the secret your CRM expects; also used to sign every request (see below). Saved keys are never returned; the field shows a masked placeholder once set.

A built-in **demo CRM** is available to preview the integration live without standing up your own endpoint — but note that enabling it **overwrites** any real CRM URL + key you have configured, so only use it before you've connected your production CRM.

### 4.2 What we send

Each event is a POST carrying a stable `reference` and one body — `transaction` for deposit events (`transaction.*`) or `withdrawal` for withdrawal events (`withdrawal.*`). **Upsert by `reference`** so one record moves through its lifecycle in place.

**Which id to match on.** A deposit event carries three identifiers and they are not interchangeable:

- **`reference`** — our stable key for the record's entire lifecycle: `"<source>:<externalTransactionId>"` for deposits (e.g. `whish:184523`), always `"withdrawal:<id>"` for withdrawals. **Match on this.**
- **`transaction.externalTransactionId`** — the provider's id (for Whish, the `externalId` from create, which is also the tail of `reference`). Use it to reconcile with the provider or to search our API.
- **`transaction.id`** — our ledger transaction UUID. It is **`null` on `transaction.pending` and `transaction.failed`**, because no ledger row exists until the money settles, so it must never be your match key.

For withdrawals, the `id` you got back from `POST /company/withdrawals` is all you need — the event's `reference` is just `withdrawal:` + that id. The `status` on an event is always the same value the REST endpoint returns for that record.

Every request carries these headers:

- `Authorization: Bearer <your-api-key>` — your saved CRM key.
- `x-crm-event: <event name>` — e.g. `transaction.completed`.
- `x-crm-timestamp: <unixSeconds>` — the signing timestamp.
- `x-crm-signature: t=<unixSeconds>,sha256=<hex>` — an **HMAC-SHA256** of `{timestamp}.{rawBody}` keyed by your API key.

**To verify a call came from us:** recompute the HMAC-SHA256 of `{x-crm-timestamp}.{rawRequestBody}` using your API key as the secret, and compare it (constant-time) to the `sha256=` value in `x-crm-signature`. Reject the request if it doesn't match, or if the timestamp is stale.

**Deposit event — body: `transaction`**

```
POST https://your-crm.com/api/transactions
Authorization: Bearer <your-api-key>
Content-Type: application/json
x-crm-event: transaction.completed
x-crm-timestamp: 1781018591
x-crm-signature: t=1781018591,sha256=<hex>

{
  "event": "transaction.completed",
  "reference": "whish:10231",
  "sentAt": "2026-06-04T12:00:00.000Z",
  "transaction": {
    "id": "0e1c…",
    "status": "COMPLETED",
    "source": "whish",
    "externalTransactionId": "10231",
    "amount": "25.00",
    "currency": "USD",
    "netAmount": "24.50",
    "commissionAmount": "0.50",
    "customer": "John Doe",
    "tradingAccount": null,
    "phone": "+961…",
    "note": "Order #1234",
    "occurredAt": "2026-06-04T12:00:00.000Z"
  }
}
```

**Withdrawal event — body: `withdrawal`**

```
x-crm-event: withdrawal.completed
(same Authorization / x-crm-timestamp / x-crm-signature headers as above)

{
  "event": "withdrawal.completed",
  "reference": "withdrawal:d4f2a1c0-…",
  "sentAt": "2026-06-10T11:30:00.000Z",
  "withdrawal": {
    "id": "d4f2a1c0-…",
    "status": "COMPLETED",              // approved by an admin & paid out
    "amount": "500.00",                 // the amount you requested
    "totalAmount": "500.00",            // what left your wallet (net + fee)
    "feeAmount": "5.00",                // the platform fee we charged
    "netAmount": "495.00",              // what the recipient received
    "feeApplication": "DEDUCTED",       // DEDUCTED or ON_TOP
    "currency": "USD",
    "payoutMethod": "CASH",
    "payoutDetails": {                  // recipient + all instructions, one place
      "method": "CASH",
      "recipientName": "Acme Ltd",
      "recipientPhone": "+961-3-000-000",
      "pickupLocation": "Beirut – Hamra",
      "instructions": "Call on arrival"
    },
    "note": "Weekly settlement",        // your request note (immutable)
    "adminNote": "Verified",            // admin's note (the reason if REJECTED)
    "externalReference": "WIRE-88231",  // proof of payment (set once approved)
    "createdAt": "2026-06-10T10:00:00.000Z",  // when you requested it
    "processedAt": "2026-06-10T11:30:00.000Z", // when the admin decided (null if PENDING)
    "occurredAt": "2026-06-10T11:30:00.000Z"
  }
}
```

The withdrawal body mirrors the `GET /company/withdrawals/:id` resource field-for-field. **The decision is in `status`:** `COMPLETED` = approved & paid (proof in `externalReference`), `REJECTED` = declined (reason in `adminNote`), `CANCELLED` = you cancelled it — and `processedAt` is when it was decided (null while `PENDING`). The full payout instructions — phone, pickup, wallet / bank details — are in `payoutDetails`. Money: `totalAmount − feeAmount = netAmount`.

### 4.3 Event types

**Deposit events** (`transaction.*`)

| Event                   | Meaning                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction.pending`   | A deposit was created and is awaiting settlement.                                                                                                 |
| `transaction.completed` | It settled — funds credited.                                                                                                                      |
| `transaction.failed`    | The collection did not go through — declined, or the payment link lapsed unpaid. (Whish reports no separate "expired", so both arrive as failed.) |
| `transaction.reversed`  | A settled deposit was reversed.                                                                                                                   |

**Withdrawal events** (`withdrawal.*`)

| Event                  | Meaning                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `withdrawal.pending`   | Requested — status PENDING, awaiting an admin's decision.                                   |
| `withdrawal.completed` | Approved by an admin and paid out — status COMPLETED, with `externalReference` as proof.    |
| `withdrawal.rejected`  | Rejected by an admin — status REJECTED, the reason in `adminNote`. Reserved funds released. |
| `withdrawal.cancelled` | Cancelled by the company while still pending — status CANCELLED. Reserved funds released.   |

> Payouts and loads are **not** pushed to your CRM — manage those over the REST API.

> **Events that never fire.** `transaction.expired` (and the `EXPIRED` status) exist in our shared enums but are never emitted — a lapsed link arrives as `transaction.failed`. Likewise there is no event for the transient `PROCESSING` state; a withdrawal being auto-processed stays `PENDING` in your CRM until it reaches a terminal event. Ignore any event name you don't recognise rather than erroring, so future additions can't break your endpoint.

### 4.4 Delivery & retries

Respond **2xx** to acknowledge. We attempt delivery up to **6 times** — one immediate, then 5 retries with backoff. Only transient failures (timeouts, `429`, and `5xx`) are retried; a `4xx` is treated as permanent and stops further attempts.

---

_This document consolidates the in-dashboard Documentation pages (Getting started, Whish Pay, Company API, CRM). If anything here disagrees with the live dashboard, the dashboard is authoritative._
