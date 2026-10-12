'use client';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { publicApiBase } from '@/lib/api';

const API_BASE = typeof window !== 'undefined' ? publicApiBase() : 'http://localhost:3001/v1';

const WALLETS_CURL = `curl ${API_BASE}/company/wallets \\
  -H "Authorization: Bearer tsk_<company-key>"

# Response — the wallets array is at data.data (the envelope wraps the list body)
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "currency": "USD",
        "availableBalance": "1250",
        "pendingBalance": "0",
        "reservedBalance": "200"
      }
    ]
  }
}`;

const TRANSACTIONS_CURL = `curl "${API_BASE}/company/transactions?page=1&pageSize=20" \\
  -H "Authorization: Bearer tsk_<company-key>"
# The list array is at data.data, with paging info at data.meta.
# Page with ?page=N&pageSize=M (pageSize max 100).`;

const WITHDRAWAL_CASH_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "500.00",
    "currency": "USD",
    "notes": "Weekly settlement",
    "payout": {
      "method": "CASH",
      "recipientName": "Acme Ltd",
      "recipientPhone": "+961-3-000-000"
    }
  }'`;

const WITHDRAWAL_WISH_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "200.00",
    "currency": "USD",
    "payout": {
      "method": "WISH",
      "recipientName": "John Doe",
      "recipientPhone": "+961-70-000-000"
    }
  }'`;

const WITHDRAWAL_CRYPTO_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "100.00",
    "currency": "USD",
    "payout": {
      "method": "CRYPTO",
      "network": "TRC20",
      "walletAddress": "TXyz...abc"
    }
  }'`;

const WITHDRAWAL_RESPONSE = `{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "PENDING",
    "amount": "500",
    "currency": "USD",
    "feeAmount": "5",               // the platform fee (commission) on this payout
    "networkFeeAmount": "0",        // the optional network fee ("0" if you're not charged one)
    "feeApplication": "DEDUCTED",   // DEDUCTED or ON_TOP, for both fees (see below)
    "netAmount": "495",             // what the recipient receives
    "totalAmount": "500",           // what leaves your wallet (net + fee + network fee)
    "payoutMethod": "CASH",
    "createdAt": "2026-06-10T10:00:00.000Z"
  }
}
# Fees are returned up front. DEDUCTED → recipient gets netAmount (amount − fee − network fee).
# ON_TOP → recipient gets the full amount and the fees are added on top, so
# totalAmount = amount + feeAmount + networkFeeAmount.
# Money fields drop trailing zeros ("500", "2.5", "0") — compare them numerically.`;

const STATUS_CURL = `curl ${API_BASE}/company/withdrawals/<id> \\
  -H "Authorization: Bearer tsk_<company-key>"

# Response — the live status and the full fee breakdown.
# (Same path shape for payouts and loads: /company/payouts/<id>, /company/loads/<id>.)
{
  "success": true,
  "statusCode": 200,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "COMPLETED",
    "amount": "500",
    "currency": "USD",
    "feeAmount": "5",                    // the platform fee we charged
    "networkFeeAmount": "0",             // the optional network fee ("0" if not charged)
    "feeApplication": "DEDUCTED",
    "netAmount": "495",                  // what the recipient received
    "totalAmount": "500",                // what left your wallet (net + fee + network fee)
    "payoutMethod": "CASH",
    "externalReference": "WIRE-88231",   // our proof we sent it (set on approval)
    "notes": "Weekly settlement",        // your original request note (never overwritten)
    "adminNotes": null,                  // set to the reason if a request is REJECTED
    "createdAt": "2026-06-10T10:00:00.000Z",
    "processedAt": "2026-06-10T11:30:00.000Z"
  }
}`;

const CANCEL_CURL = `curl -X POST ${API_BASE}/company/withdrawals/<id>/cancel \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{ "notes": "No longer needed" }'`;

export function CompanyApiView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Company API</h1>
        <p className="text-sm text-muted-foreground">
          Your company key unlocks your whole account over plain HTTPS — read transactions, wallets,
          ledger, and analytics, and request withdrawals, payouts, and loads. Authentication and the
          response envelope are covered in{' '}
          <Link href="/app/documentation" className="text-primary hover:underline">
            Getting started
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Check your balances</CardTitle>
          <CardDescription>
            Returns <code className="font-mono">availableBalance</code> (spendable) and{' '}
            <code className="font-mono">reservedBalance</code> (held for pending outflows) per
            currency. Check this before requesting a withdrawal to avoid an insufficient-funds
            error.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={WALLETS_CURL} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Request a withdrawal, payout, or load</CardTitle>
          <CardDescription>
            All three share the same body — only the path differs:{' '}
            <code className="font-mono font-semibold text-foreground">/company/withdrawals</code>,{' '}
            <code className="font-mono font-semibold text-foreground">/company/payouts</code>, or{' '}
            <code className="font-mono font-semibold text-foreground">/company/loads</code>.
            Requests land in <strong>PENDING</strong> and need platform-admin approval before any
            funds move.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-medium">Payout method — choose one</p>
            <div className="space-y-1 text-xs">
              <MethodRow
                method="CASH"
                required="recipientName, recipientPhone"
                optional="pickupLocation, instructions"
              />
              <MethodRow
                method="WISH"
                required="recipientName, recipientPhone"
                optional="instructions"
              />
              <MethodRow
                method="CRYPTO"
                required="network, walletAddress"
                optional="memo, instructions"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              <strong className="text-foreground">recipientPhone format:</strong> the formatting in
              these examples is illustrative — send 6–15 digits with optional{' '}
              <code className="font-mono">+</code>, spaces, dashes or parens (plain international
              like <code className="font-mono">+96170000000</code> is simplest). One extra rule on
              create for <strong>Lebanese</strong> numbers: after the{' '}
              <code className="font-mono">961</code> country code there must be exactly{' '}
              <strong>8 digits</strong>, or <strong>7</strong> when the national part starts with{' '}
              <code className="font-mono">3</code> — so{' '}
              <code className="font-mono">9617075183</code> is rejected with{' '}
              <code className="font-mono">400 VALIDATION_ERROR</code>. CASH recipient phones are
              free-form.
            </p>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">CASH example</p>
            <CodeBlock code={WITHDRAWAL_CASH_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">WISH example</p>
            <CodeBlock code={WITHDRAWAL_WISH_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              CRYPTO example
            </p>
            <CodeBlock code={WITHDRAWAL_CRYPTO_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              Response (201 Created)
            </p>
            <CodeBlock code={WITHDRAWAL_RESPONSE} />
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong className="text-foreground">
                  You can&apos;t choose feeApplication per request.
                </strong>{' '}
                It comes from the commission rule your platform admin configures (the network fee
                follows the same application); sending it in the body has no effect. Want recipients
                to receive the full amount with the fees billed to your wallet? Ask your account
                manager to set that rule to <code className="font-mono">ON_TOP</code>.
              </li>
              <li>
                <strong className="text-foreground">Network fee.</strong> Rival may charge your
                company an optional second platform fee, set per flow (deposits, withdrawals,
                payouts, loads) as a percentage or a fixed amount. It is returned as{' '}
                <code className="font-mono">networkFeeAmount</code> —{' '}
                <code className="font-mono">&quot;0&quot;</code> when you&apos;re not charged one —
                applied the same way as the fee and frozen on each request, so{' '}
                <code className="font-mono">
                  totalAmount = netAmount + feeAmount + networkFeeAmount
                </code>{' '}
                always holds. E.g. a 100 withdrawal with an{' '}
                <code className="font-mono">ON_TOP</code> $2 fee and a $1 network fee debits 103 and
                pays the recipient the full 100. You can&apos;t set it through the API, and it is a
                platform fee — not a blockchain fee, and unrelated to{' '}
                <code className="font-mono">payoutDetails.network</code>. If{' '}
                <code className="font-mono">DEDUCTED</code> fees would consume the whole amount, the
                request is refused with <code className="font-mono">400 VALIDATION_ERROR</code>;{' '}
                <code className="font-mono">error.details</code> carries the amount and both fees.
              </li>
              <li>
                <strong className="text-foreground">
                  No idempotency key, and no field for your own order number.
                </strong>{' '}
                Retrying a create after a timeout makes a <em>second</em> request and reserves the
                funds again — so on an ambiguous failure, call{' '}
                <code className="font-mono">GET /company/withdrawals?status=PENDING</code> and match
                before retrying. Carry your own reference in{' '}
                <code className="font-mono">notes</code> (≤ 500 chars): it is stored immutably,
                returned on every read, and echoed on the matching CRM event.
              </li>
              <li>
                <strong className="text-foreground">Determining success:</strong> a create succeeded
                when the response is <code className="font-mono">success: true</code> with{' '}
                <code className="font-mono">statusCode 201</code>. The two never disagree, so
                testing <code className="font-mono">success</code> alone is enough.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Status lifecycle</CardTitle>
          <CardDescription>
            Every withdrawal, payout, and load moves through these statuses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <StatusRow status="PENDING" desc="Submitted — awaiting platform-admin review." />
            <StatusRow
              status="PROCESSING"
              desc="Withdrawals only: a transfer is in flight. Transient — it settles to COMPLETED, or returns to PENDING if the transfer doesn't go through. You cannot cancel while PROCESSING (409 CONFLICT); wait for it to leave the state."
            />
            <StatusRow
              status="COMPLETED"
              desc="Admin approved and funds delivered — approval settles in one step. Ledger entry finalised."
            />
            <StatusRow
              status="REJECTED"
              desc="Admin rejected the request. Reserved funds released."
            />
            <StatusRow
              status="CANCELLED"
              desc="You cancelled it (only possible while PENDING). Reserved funds released."
            />
            <StatusRow
              status="APPROVED"
              desc="Exists in the status enum but is not produced today — approvals settle straight to COMPLETED. Accepted as a ?status= filter, it simply matches nothing."
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Handle unknown statuses gracefully rather than failing, so a future status can&apos;t
            break your integration. These are the same values the CRM events carry, so polling and
            webhooks never need translating — but note Whish payment links use a different set (
            <code className="font-mono">PENDING</code> / <code className="font-mono">PAID</code> /{' '}
            <code className="font-mono">FAILED</code>).
          </p>
          <p className="mt-4 rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Withdrawals push to your CRM.</strong> Every
            withdrawal status change — pending, completed, rejected, cancelled — is delivered to
            your{' '}
            <Link href="/app/documentation?tab=crm" className="text-primary hover:underline">
              CRM webhook
            </Link>{' '}
            in real time, carrying the same <code className="font-mono">feeAmount</code> /{' '}
            <code className="font-mono">networkFeeAmount</code> /{' '}
            <code className="font-mono">netAmount</code> /{' '}
            <code className="font-mono">totalAmount</code> breakdown, so you never have to poll.
            Payouts and loads are managed over this API only — read their status with the GET below.
          </p>
          <p className="mt-4 text-xs font-medium text-foreground">Check a request&apos;s status</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fetch a single request by id anytime to read its current{' '}
            <code className="font-mono">status</code>:{' '}
            <code className="font-mono font-semibold text-foreground">
              GET /company/withdrawals/:id
            </code>{' '}
            (same shape for <code className="font-mono">payouts</code> and{' '}
            <code className="font-mono">loads</code>). For a rejected request the reason is in{' '}
            <code className="font-mono">adminNotes</code>; your original request note stays in{' '}
            <code className="font-mono">notes</code>. You can also list and filter by status, e.g.{' '}
            <code className="font-mono">GET /company/withdrawals?status=PENDING</code>.
          </p>
          <div className="mt-3">
            <CodeBlock code={STATUS_CURL} />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Cancel while still PENDING:{' '}
            <code className="font-mono font-semibold text-foreground">
              POST /company/withdrawals/:id/cancel
            </code>{' '}
            (same path shape for payouts and loads).
          </p>
          <div className="mt-3">
            <CodeBlock code={CANCEL_CURL} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Read your data</CardTitle>
          <CardDescription>
            Transactions, ledger, and analytics are all read with a simple GET. Lists are paginated
            (the array is at <code className="font-mono">data.data</code>); CSV exports stream the
            raw file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code={TRANSACTIONS_CURL} />
          <p className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Fees are transparent.</strong> Every transaction
            returns <code className="font-mono">amount</code> (gross),{' '}
            <code className="font-mono">commissionAmount</code> (the platform fee we took),{' '}
            <code className="font-mono">networkFeeAmount</code> (the optional network fee —{' '}
            <code className="font-mono">&quot;0&quot;</code> if you&apos;re not charged one), and{' '}
            <code className="font-mono">netAmount</code> (what you were credited) — e.g. a $100
            deposit with a $2 commission and a 1% network fee credits $97. Withdrawals, payouts and
            loads return the same breakdown as <code className="font-mono">totalAmount</code> /{' '}
            <code className="font-mono">feeAmount</code> /{' '}
            <code className="font-mono">networkFeeAmount</code> /{' '}
            <code className="font-mono">netAmount</code> — so after any completed transaction you
            always know exactly what we charged.
          </p>
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">CSV exports.</strong> Transactions, withdrawals,
            payouts, loads, ledger and activity each have an{' '}
            <code className="font-mono">/export.csv</code> (same filters as the list; the raw file,
            no envelope). Columns are only ever appended, so parse by header name. The newest is{' '}
            <code className="font-mono">network_fee_amount</code> — the last column of the
            transactions, withdrawals, payouts, loads and activity exports,{' '}
            <code className="font-mono">0.00</code> when you&apos;re not charged a network fee. In
            the withdrawals, payouts, loads and activity exports,{' '}
            <code className="font-mono">
              gross_amount = fee_amount + network_fee_amount + net_amount
            </code>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5. Fees: single fee or dual fee</CardTitle>
          <CardDescription>
            Rival runs two fee models side by side. Which one applies to your company is set by
            Rival — no API call changes it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong className="text-foreground">Single fee — the default.</strong> You are
                charged the commission only. <code className="font-mono">networkFeeAmount</code> is
                always <code className="font-mono">&quot;0&quot;</code>, every existing field keeps
                its meaning, and{' '}
                <strong className="text-foreground">your integration needs no change</strong>.
              </li>
              <li>
                <strong className="text-foreground">
                  Dual fee — switched on by Rival on request.
                </strong>{' '}
                What you pay Rival is split into the commission and a{' '}
                <strong className="text-foreground">network fee</strong>, so that you can pass the
                network fee on to your own customer and absorb only the commission. Rival never
                charges your customer: you do, in your own system, using the{' '}
                <code className="font-mono">networkFeeAmount</code> on each record.
              </li>
            </ul>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              Example — a customer deposits $100
            </p>
            <div className="rounded-md border px-3 text-xs">
              <FeeModelRow
                label=""
                single="Single fee — 2.5% commission"
                dual="Dual fee — 1.5% commission + 1% network fee"
                head
              />
              <FeeModelRow label="commissionAmount" single='"2.5"' dual='"1.5"' mono />
              <FeeModelRow label="networkFeeAmount" single='"0"' dual='"1"' mono />
              <FeeModelRow
                label="netAmount (credited to your wallet)"
                single='"97.5"'
                dual='"97.5"'
                mono
              />
              <FeeModelRow
                label="You credit your customer"
                single="$100"
                dual="$99 (amount − networkFeeAmount)"
              />
              <FeeModelRow label="Absorbed by you" single="$2.50" dual="$1.50" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              The rates are an illustration; yours are agreed with Rival. Your wallet is credited
              the same either way — what changes is who bears the cost.
            </p>
          </div>

          <div className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">
              Moving to the dual-fee model — what to change in your code
            </p>
            <p className="mb-1">
              Ask your account manager and agree the switch-on time: it applies to every new
              operation from that moment. Ship these first:
            </p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                Read <code className="font-mono">networkFeeAmount</code> on every record and webhook
                (a missing or <code className="font-mono">null</code> value in a webhook means{' '}
                <code className="font-mono">&quot;0&quot;</code>).
              </li>
              <li>
                Charge your customer the figure on the record — credit{' '}
                <code className="font-mono">amount − networkFeeAmount</code> on a deposit you pass
                on. Never recompute it from a rate.
              </li>
              <li>
                Stop deriving the net: on a deposit <code className="font-mono">netAmount</code> is
                now <code className="font-mono">amount − commissionAmount − networkFeeAmount</code>.
                Use the <code className="font-mono">netAmount</code> we send.
              </li>
              <li>
                On money out, check balances against <code className="font-mono">totalAmount</code>{' '}
                (<code className="font-mono">netAmount + feeAmount + networkFeeAmount</code>).
              </li>
              <li>
                Let reconciliation accept the <code className="font-mono">NETWORK_FEE</code> ledger
                account and the last CSV column,{' '}
                <code className="font-mono">network_fee_amount</code>.
              </li>
            </ol>
            <p className="mt-1">
              If it is switched off again, new operations go back to{' '}
              <code className="font-mono">&quot;0&quot;</code>; records already booked or pending
              keep their fees. Dual-fee code is also correct on the single-fee model.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All endpoints at a glance</CardTitle>
          <CardDescription>
            These <code className="font-mono font-semibold text-foreground">company/*</code> routes
            accept your company key, except the dashboard-only ones noted below. Whish Pay and CRM
            have their own tabs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <EndpointGroup label="Wallets" endpoints="GET /company/wallets" />
            <EndpointGroup
              label="Transactions"
              endpoints="GET /company/transactions · /:id · /:id/detail · /export.csv"
            />
            <EndpointGroup label="Ledger" endpoints="GET /company/ledger · /export.csv" />
            <EndpointGroup
              label="Analytics"
              endpoints="GET /company/analytics/overview · /wallet-summary"
            />
            <EndpointGroup
              label="Activity"
              endpoints="GET /company/activity · /export.csv · GET /company/operations/counts"
            />
            <EndpointGroup
              label="Withdrawals"
              endpoints="GET /company/withdrawals · GET /:id · /export.csv · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="Payouts"
              endpoints="GET /company/payouts · GET /:id · /export.csv · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="Loads"
              endpoints="GET /company/loads · GET /:id · /export.csv · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="API keys (dashboard session only)"
              endpoints="GET · POST /company/api-keys · POST /:id/rotate · /:id/revoke"
            />
            <EndpointGroup
              label="Team (dashboard session only)"
              endpoints="GET · POST /company/team · PATCH · DELETE /:id"
            />
          </div>
          <p className="mt-3 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">
              Dashboard session only — these reject an API key with 403 FORBIDDEN:
            </strong>{' '}
            <code className="font-mono">company/api-keys</code>,{' '}
            <code className="font-mono">company/team</code>, <code className="font-mono">PUT</code>/
            <code className="font-mono">DELETE</code>{' '}
            <code className="font-mono">/company/crm/config</code>, and{' '}
            <code className="font-mono">POST /company/crm/demo/enable</code>. Reading the CRM config
            with a key does work. This is deliberate: a leaked key must not be able to mint keys,
            add users, or redirect your CRM traffic.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Collecting payments?{' '}
            <Link href="/app/documentation?tab=whish" className="text-primary hover:underline">
              Whish Pay tab
            </Link>
            . Pushing transactions to your CRM?{' '}
            <Link href="/app/documentation?tab=crm" className="text-primary hover:underline">
              CRM tab
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Health check</CardTitle>
          <CardDescription>A no-auth, no-side-effects sanity check.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={`curl ${API_BASE}/health`} />
        </CardContent>
      </Card>
    </div>
  );
}

// One line of the single-fee vs dual-fee comparison.
function FeeModelRow({
  label,
  single,
  dual,
  head = false,
  mono = false,
}: {
  label: string;
  single: string;
  dual: string;
  head?: boolean;
  mono?: boolean;
}) {
  const value = head ? 'font-medium text-foreground' : mono ? 'font-mono' : '';
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-1.5 last:border-0">
      <span className={`col-span-4 ${mono ? 'font-mono' : ''} text-muted-foreground`}>{label}</span>
      <span className={`col-span-4 ${value}`}>{single}</span>
      <span className={`col-span-4 ${value}`}>{dual}</span>
    </div>
  );
}

function EndpointGroup({ label, endpoints }: { label: string; endpoints: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
      <span className="col-span-3 text-xs font-medium">{label}</span>
      <span className="col-span-9 font-mono text-xs text-muted-foreground">{endpoints}</span>
    </div>
  );
}

function MethodRow({
  method,
  required,
  optional,
}: {
  method: string;
  required: string;
  optional: string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-1.5 last:border-0">
      <code className="col-span-2 font-mono font-semibold">{method}</code>
      <span className="col-span-5 text-muted-foreground">
        <span className="text-foreground">required: </span>
        {required}
      </span>
      <span className="col-span-5 text-muted-foreground">
        <span className="text-foreground">optional: </span>
        {optional}
      </span>
    </div>
  );
}

function StatusRow({ status, desc }: { status: string; desc: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
      <code className="col-span-3 font-mono text-xs font-semibold">{status}</code>
      <span className="col-span-9 text-xs text-muted-foreground">{desc}</span>
    </div>
  );
}
