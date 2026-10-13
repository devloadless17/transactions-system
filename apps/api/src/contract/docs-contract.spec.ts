import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  activityItemSchema,
  createLoadSchema,
  createPayoutSchema,
  createWhishPaymentSchema,
  createWithdrawalSchema,
  crmEventTransactionSchema,
  crmEventWithdrawalSchema,
  Money,
  WHISH_AMOUNT_RULES,
  listNotificationsQuerySchema,
  listWhishPaymentsQuerySchema,
  loadResponseSchema,
  paginationSchema,
  payoutResponseSchema,
  transactionResponseSchema,
  whishPaymentResponseSchema,
  withdrawalResponseSchema,
  WithdrawalStatus,
} from '@app/shared';
import { FLOW_CSV_HEADER } from '../common/flow-csv';
import { computeNetworkFee } from '../modules/commissions/network-fee';
import { feesConsumeAmountError, netOfFee, reservedTotal } from '../modules/ledger/flow-ledger';
import { UPSTREAM_ERROR_STATUS, WhishError } from '../modules/whish/whish.client';

// Fields on a company-facing response schema that are deliberately NOT shown in the
// example field table (admin/internal projections or rarely-needed extras). Adding a
// NEW schema field that isn't here forces a conscious doc decision — the reverse-
// coverage test below fails until the field is either documented or allow-listed.
const WHISH_RESPONSE_UNDOCUMENTED_OK = new Set([
  'companyId',
  'payerPhoneNumber',
  'settlementError',
]);

/**
 * Docs ↔ API-schema contract (anti-drift).
 *
 * The 2026-06-11 full-app audit's single largest finding cluster was the
 * integration documentation drifting from the real Zod schemas — a Whish create
 * body the schema rejects, a missing `422`, phantom query params. Those are
 * silent, partner-breaking, and invisible to typecheck.
 *
 * These tests pin the documented contract to the ACTUAL schemas, so the whole
 * class can't regress: change `createWhishPaymentSchema` without updating the
 * guide (or re-introduce a bogus documented body) and one of these fails. It's
 * pure Zod + a few string assertions, so it runs in the infra-free unit suite
 * (`pnpm test`) — no DB, no network.
 */

// Resolve a repo file by walking up from the test runner's cwd (works whether
// invoked via `pnpm --filter @app/api test` or `pnpm -r test`).
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate ${rel} from cwd=${process.cwd()}`);
}
const read = (rel: string): string => fs.readFileSync(repoFile(rel), 'utf8');

// The integration guides were renamed from rival-* to the company/source split.
const GUIDE = read('docs/companies-integration-docs.md');
const INGEST_DOC = read('docs/sources-integration-docs.md');
const DEV_GUIDE = read('docs/company-developer-guide.md');

describe('docs ↔ API schema contract (anti-drift)', () => {
  describe('POST /company/whish/payments — create body (audit #1)', () => {
    it('the documented example body is ACCEPTED by createWhishPaymentSchema', () => {
      const documented = { amount: '50.00', currency: 'USD', invoice: 'Order #9912' };
      expect(createWhishPaymentSchema.safeParse(documented).success).toBe(true);
    });

    it('the OLD wrong body (externalId/description, no invoice) is REJECTED — locks the fix', () => {
      const oldWrong = {
        amount: '50.00',
        currency: 'USD',
        externalId: 'order-9912',
        description: 'Payment for order #9912',
      };
      expect(createWhishPaymentSchema.safeParse(oldWrong).success).toBe(false);
    });

    it('the guide documents `invoice` and no longer the bogus externalId/description body', () => {
      expect(GUIDE).toContain('"invoice"');
      expect(GUIDE).not.toContain('"externalId": "order-9912"');
      expect(GUIDE).not.toContain('"description": "Payment for order #9912"');
    });

    // Whish DOCUMENTS per-currency amount rules but does not enforce them (the
    // live sandbox mints a link for "0.50" and "10.005"), so we must not be
    // stricter than the payment provider and refuse money it would collect.
    it.each(['0.50', '0.99', '10.005', '25.000', '1', '1.00', '50.00'])(
      'accepts the amount %o rather than being stricter than Whish',
      (amount) => {
        const body = { amount, currency: 'USD', invoice: 'Order #9912' };
        expect(createWhishPaymentSchema.safeParse(body).success).toBe(true);
      },
    );

    // Read the limit from config, so changing the rule FORCES a docs change.
    it('the guide states the amounts Whish recommends', () => {
      expect(GUIDE).toContain(`minimum ${WHISH_AMOUNT_RULES.USD.minAmount}`);
      expect(GUIDE).toContain(`${WHISH_AMOUNT_RULES.USD.maxDecimals} decimal places`);
    });

    // BOTH public guides, not just the companies one. The developer guide was
    // silently left on the old contract by the v1.4.4 pass, which would have sent
    // integrators down the WHISH_ERROR "safe to retry" path and minted duplicates.
    it.each([
      ['companies-integration-docs.md', () => GUIDE],
      ['company-developer-guide.md', () => DEV_GUIDE],
    ])('%s explains that WHISH_PENDING is not a failure', (_name, doc) => {
      expect(doc()).toContain('WHISH_PENDING');
    });

    it.each([
      ['companies-integration-docs.md', () => GUIDE],
      ['company-developer-guide.md', () => DEV_GUIDE],
    ])('%s states the real amount limits, not the old 8-decimal rule', (_name, doc) => {
      expect(doc()).toContain(`${WHISH_AMOUNT_RULES.USD.maxDecimals} decimal places`);
      expect(doc()).not.toMatch(/Up to 8 decimal places, must be greater than 0/);
    });
  });

  describe('Whish payment response example fields', () => {
    it('every response field the docs reference exists on whishPaymentResponseSchema', () => {
      const realKeys = Object.keys(whishPaymentResponseSchema.shape);
      const documentedFields = [
        'id',
        'externalId',
        'status',
        'amount',
        'currency',
        'invoice',
        'collectUrl',
        'transactionId',
        'needsAttention',
        'createdAt',
        'paidAt',
      ];
      for (const field of documentedFields) {
        expect(realKeys, `documented response field "${field}" must exist on the schema`).toContain(
          field,
        );
      }
    });
  });

  describe('POST /company/withdrawals — CASH body', () => {
    it('the documented CASH withdrawal example is accepted by createWithdrawalSchema', () => {
      const documented = {
        amount: '100.00',
        currency: 'USD',
        notes: 'Weekly settlement',
        payout: { method: 'CASH', recipientName: 'ACME Ltd', recipientPhone: '+961-3-000-000' },
      };
      expect(createWithdrawalSchema.safeParse(documented).success).toBe(true);
    });
  });

  describe('Documented outcomes & query params match reality', () => {
    // Deposits never bounce on pricing: an unpriced or over-fee'd ingest books
    // at net 0 (full amount withheld as fee) instead of throwing, and the
    // sources doc documents exactly that. The company-facing guide still
    // documents NO_COMMISSION_RULE for the create-time Whish dry-run, where
    // rejecting BEFORE money moves is correct.
    it('the ingest docs document the net-0 booking for pricing gaps (deposits never bounce)', () => {
      expect(INGEST_DOC).toMatch(/net 0|net-0/);
      expect(INGEST_DOC).toContain('NO_COMMISSION_RULE');
      expect(GUIDE).toContain('NO_COMMISSION_RULE');
    });

    // Sources must never see the commission model: the sources doc documents
    // the neutral ENTITY_NOT_READY translation (behavior itself is pinned by
    // ingest-source-errors.spec.ts), and the partner-facing doc mentions no
    // pricing concept at all — deposits cannot bounce on pricing there.
    it('the source boundary hides the commission model (docs)', () => {
      expect(INGEST_DOC).toContain('ENTITY_NOT_READY');
      const partnerDoc = read('docs/rival-ingest-api-integration.md');
      expect(partnerDoc).not.toMatch(/422|ENTITY_NOT_READY|COMMISSION/i);
    });

    it('the whish payments list documents its REAL query params (audit #12)', () => {
      const line = GUIDE.split('\n').find(
        (l) => l.includes('/v1/company/whish/payments') && /List payments/.test(l),
      );
      expect(line, 'the whish payments list row should exist in the guide').toBeTruthy();
      expect(line).toContain('needsAttention');
      // `from`/`to`/`search` used to be phantom (documented but unimplemented); the
      // dashboard filter + CSV export made them real backend params, so the guide
      // must now document them — the opposite of the original audit #12 assertion.
      const real = listWhishPaymentsQuerySchema.shape;
      expect(real.from).toBeDefined();
      expect(real.to).toBeDefined();
      expect(real.search).toBeDefined();
      expect(line).toMatch(/`from\??`/);
      expect(line).toMatch(/`to\??`/);
      expect(line).toContain('search');
    });
  });

  // The 2026-06-30 audit found this exact drift survived a green contract test: the
  // sources doc still claimed a hidden company → 403 on ingest after `visible` became
  // discovery-only. These assertions pin the corrected semantics so it can't recur.
  describe('ingest visibility semantics (visible is discovery-only)', () => {
    it('the sources doc no longer claims a hidden company is rejected (403) on ingest', () => {
      expect(INGEST_DOC).not.toMatch(/hidden company → `403/);
      expect(INGEST_DOC).not.toMatch(/`403 FORBIDDEN` \(company not `visible`/);
    });

    it('the sources doc states `visible` only governs discovery, not ingest', () => {
      expect(INGEST_DOC).toMatch(
        /still accepts ingest|discovery list only|only controls \*\*discovery\*\*/i,
      );
      expect(INGEST_DOC).toMatch(/not\*\* an ingest gate|does not gate ingest|discovery-only/i);
    });
  });

  describe('ingest response omits platform fee/net (sources never see the margin)', () => {
    it('the sources doc states the response omits the fee and net amounts', () => {
      expect(INGEST_DOC).toMatch(/deliberately omits the fee/i);
    });
  });

  describe('whish response field table is COMPLETE (reverse drift: schema → docs)', () => {
    it('every whishPaymentResponseSchema field is documented or explicitly allow-listed', () => {
      const documented = new Set([
        'id',
        'externalId',
        'status',
        'amount',
        'currency',
        'invoice',
        'collectUrl',
        'transactionId',
        'needsAttention',
        'createdAt',
        'paidAt',
        'refundedAt',
      ]);
      const undocumented = Object.keys(whishPaymentResponseSchema.shape).filter(
        (k) => !documented.has(k) && !WHISH_RESPONSE_UNDOCUMENTED_OK.has(k),
      );
      expect(
        undocumented,
        `whishPaymentResponseSchema has fields neither documented nor allow-listed: ${undocumented.join(', ')}. Document them in companies-integration-docs.md or add to WHISH_RESPONSE_UNDOCUMENTED_OK.`,
      ).toEqual([]);
    });
  });

  describe('Whish errors are documented with the status the API really sends', () => {
    // Behind Cloudflare an origin 502 is replaced by Cloudflare's own page, so a
    // documented "502 WHISH_ERROR" would describe a JSON body nobody receives.
    it('WHISH_ERROR / WHISH_PENDING go out as 503 and both company guides say so', () => {
      expect(UPSTREAM_ERROR_STATUS).toBe(503);
      expect(new WhishError('x').httpStatus).toBe(503);
      for (const [name, doc] of [
        ['companies guide', GUIDE],
        ['developer guide', DEV_GUIDE],
      ] as const) {
        expect(doc, `${name} must document the 503`).toMatch(/503/);
        expect(doc, `${name} still documents a Whish 502`).not.toMatch(
          /502 WHISH_|WHISH_ERROR`, HTTP 502|WHISH_PENDING` \(502\)|"statusCode": 502/,
        );
      }
    });
  });

  describe('error envelope codes are documented', () => {
    it('both guides describe the standard error codes integrators key off', () => {
      for (const code of ['VALIDATION_ERROR', 'UNAUTHORIZED']) {
        expect(GUIDE, `companies guide should document ${code}`).toContain(code);
      }
      expect(INGEST_DOC).toContain('VALIDATION_ERROR');
      expect(INGEST_DOC).toContain('DUPLICATE_TRANSACTION');
      // A repeat with different money is refused, not replayed — sources must
      // be told, in both the internal and the partner doc.
      expect(INGEST_DOC).toContain('TRANSACTION_MISMATCH');
      expect(read('docs/rival-ingest-api-integration.md')).toContain('TRANSACTION_MISMATCH');
    });

    it('every company-facing money/limit error code appears in the companies guide', () => {
      for (const code of [
        'INSUFFICIENT_BALANCE',
        'RATE_LIMITED',
        'NO_COMMISSION_RULE',
        'WRITE_CONFLICT',
        'WHISH_ERROR',
        // v1.4.4: an indeterminate Whish outcome. Documented separately from
        // WHISH_ERROR because it must NOT be treated as a failure.
        'WHISH_PENDING',
        'FORBIDDEN',
      ]) {
        expect(GUIDE, `companies guide should document ${code}`).toContain(code);
      }
    });
  });

  // ------------------------------------------------------------------
  // 2026-07-03 audit: the contract test only guarded Whish + the CASH
  // withdrawal example — loads, payouts, the full withdrawal response, and
  // pagination could all drift silently. The blocks below close that gap.
  // ------------------------------------------------------------------

  describe('loads & payouts — documented example bodies parse (audit 2026-07-03)', () => {
    it('the documented WISH load body is accepted by createLoadSchema', () => {
      const documented = {
        amount: '1000.00',
        currency: 'USD',
        notes: 'Sent via Whish from +9613XXXXXX',
        payout: { method: 'WISH', recipientName: 'Acme Treasury', recipientPhone: '+9613000000' },
      };
      expect(createLoadSchema.safeParse(documented).success).toBe(true);
    });

    it('the withdrawal-identical CASH body is accepted by createPayoutSchema (the docs say "identical body")', () => {
      const documented = {
        amount: '250.00',
        currency: 'USD',
        notes: 'Vendor invoice #4471',
        payout: {
          method: 'CASH',
          recipientName: 'Jane Vendor',
          recipientPhone: '+9611234567',
          pickupLocation: 'Beirut HQ',
        },
      };
      expect(createPayoutSchema.safeParse(documented).success).toBe(true);
    });

    it('the documented WISH and CRYPTO withdrawal bodies are accepted by createWithdrawalSchema', () => {
      const wish = {
        amount: '200.00',
        currency: 'USD',
        payout: { method: 'WISH', recipientName: 'John Doe', recipientPhone: '+961-70-000-000' },
      };
      const crypto = {
        amount: '100.00',
        currency: 'USD',
        payout: {
          method: 'CRYPTO',
          network: 'TRC20',
          walletAddress: 'TQ1234567890ABCDEFGHIJ1234567890XYZ',
        },
      };
      expect(createWithdrawalSchema.safeParse(wish).success).toBe(true);
      expect(createWithdrawalSchema.safeParse(crypto).success).toBe(true);
    });
  });

  describe('flow response tables are COMPLETE (reverse drift: schema → docs)', () => {
    // A company API key receives every one of these fields — each must appear in
    // the guide (as a `field` table row or a "field": example) or be consciously
    // allow-listed. Catches exactly the roundingRemainder/adminNotes/autoApproval
    // gap the 2026-07-03 audit found.
    const documentedInGuide = (field: string) =>
      GUIDE.includes(`\`${field}\``) || GUIDE.includes(`"${field}"`);

    it('every withdrawalResponseSchema field is documented in the companies guide', () => {
      const missing = Object.keys(withdrawalResponseSchema.shape).filter(
        (k) => !documentedInGuide(k),
      );
      expect(
        missing,
        `withdrawal response fields not documented anywhere in the guide: ${missing.join(', ')}`,
      ).toEqual([]);
    });

    it('every load/payout response field is documented in the companies guide', () => {
      for (const [name, schema] of [
        ['load', loadResponseSchema],
        ['payout', payoutResponseSchema],
      ] as const) {
        const missing = Object.keys(schema.shape).filter((k) => !documentedInGuide(k));
        expect(missing, `${name} response fields not documented: ${missing.join(', ')}`).toEqual(
          [],
        );
      }
    });
  });

  describe('pagination contract matches the documented caps', () => {
    it('paginationSchema hard-caps pageSize at 100 and the guide says so', () => {
      expect(paginationSchema.safeParse({ page: 1, pageSize: 100 }).success).toBe(true);
      expect(paginationSchema.safeParse({ page: 1, pageSize: 101 }).success).toBe(false);
      expect(GUIDE).toMatch(/Hard cap 100/);
    });

    it('notifications pageSize caps at 50 and the endpoints are documented', () => {
      expect(listNotificationsQuerySchema.safeParse({ pageSize: 50 }).success).toBe(true);
      expect(listNotificationsQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false);
      expect(GUIDE).toContain('/v1/notifications');
      expect(GUIDE).toMatch(/`active`.*`unread`.*`cleared`|active.*unread.*cleared/);
    });

    it('the transactions deep-offset cap documented (100,000) matches the code', () => {
      const svc = read('apps/api/src/modules/transactions/transactions.service.ts');
      const code = svc.match(/MAX_LIST_OFFSET\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, '');
      expect(code, 'transactions.service.ts should define MAX_LIST_OFFSET').toBe('100000');
      expect(GUIDE).toMatch(/100,000/);
    });
  });

  describe('whish outbound-webhook management is documented as dashboard-only (audit 2026-07-03 High)', () => {
    it('the guide states PUT/rotate/DELETE require a dashboard session (API key → 403)', () => {
      expect(GUIDE).toMatch(/Changing it is dashboard-only|change via the dashboard only/i);
      // and it no longer promises API-key write access to the webhook config
      expect(GUIDE).not.toMatch(
        /Webhook config \(`company\/whish\/webhook`\) is manageable with \*\*either\*\*/,
      );
    });
  });

  // The company developer guide is the hand-to-your-engineers document, so the
  // same anti-drift rule applies to it as to the older guides above. These pin
  // the two claims that are actively DANGEROUS when wrong: the SessionOnlyGuard
  // boundary (a doc promising API-key access to key/team/CRM management invites
  // "fixing" the guard, turning a leaked key into full account takeover), and
  // the status list a CRM switches on.
  describe('company developer guide ↔ SessionOnlyGuard boundary', () => {
    it('does NOT claim every company/* route accepts an API key', () => {
      expect(DEV_GUIDE).not.toMatch(/Every `company\/\*` route accepts your company key/);
    });

    it('states that key, team and CRM-config management need a dashboard session', () => {
      expect(DEV_GUIDE).toMatch(/[Dd]ashboard[- ]only|dashboard session/);
      expect(DEV_GUIDE).toMatch(/403 FORBIDDEN/);
    });

    it('the guarded controllers really are session-only — the doc claim is true', () => {
      for (const rel of [
        'apps/api/src/modules/team/team.controller.ts',
        'apps/api/src/modules/api-keys/api-keys.controller.ts',
        'apps/api/src/modules/crm/crm.controller.ts',
      ]) {
        expect(read(rel), `${rel} must keep SessionOnlyGuard`).toContain('SessionOnlyGuard');
      }
    });

    it('documents every WithdrawalStatus the API can return (reverse coverage)', () => {
      const table = DEV_GUIDE.slice(DEV_GUIDE.indexOf('### 3.3 Status lifecycle'));
      for (const status of Object.values(WithdrawalStatus)) {
        expect(table, `status ${status} is undocumented in the guide`).toContain(`\`${status}\``);
      }
    });
  });
});

/**
 * Client-question regressions (2026-08).
 *
 * Every assertion below pins a fact a real integrator got wrong because the docs
 * were silent, stale, or contradicted the code. They are cheap string/schema
 * checks, and each names the question it prevents so the intent survives.
 */
describe('docs contract — facts clients asked about', () => {
  const WEB_COMPANY_API = read('apps/web/src/features/company/company-api-view.tsx');
  const WEB_GETTING_STARTED = read('apps/web/src/features/company/getting-started-view.tsx');

  it('does not claim CRM config can be managed with an API key (it is SessionOnlyGuard)', () => {
    // The guide used to say "an integration can fully manage this config
    // programmatically", which is false and would have a partner build against a 403.
    expect(GUIDE).not.toMatch(/fully manage this config programmatically/);
    const crmSection = GUIDE.slice(GUIDE.indexOf('### How a company configures its CRM callback'));
    expect(crmSection).toMatch(/dashboard[- ]only|dashboard session/i);
    expect(crmSection).toMatch(/403 FORBIDDEN/);
  });

  it('the in-app Company API page does not claim every company/* route takes a key', () => {
    // Same dangerous claim the markdown is already pinned against; the React
    // mirror is not covered by any other test, so it drifted.
    expect(WEB_COMPANY_API).not.toMatch(
      /Every[\s\S]{0,60}company\/\*[\s\S]{0,60}accepts your company key/,
    );
    expect(WEB_COMPANY_API).toMatch(/403 FORBIDDEN/);
    expect(WEB_COMPANY_API).toMatch(/dashboard session/i);
    expect(WEB_GETTING_STARTED).toMatch(/dashboard[- ]only/i);
  });

  it('withdrawals still have no idempotency key, and both guides say so', () => {
    // If one is ever added, this fails and the "retry double-reserves" warning
    // must be rewritten rather than left as a lie.
    expect('idempotencyKey' in createWithdrawalSchema.shape).toBe(false);
    expect(GUIDE).toMatch(/no idempotency key/i);
    expect(DEV_GUIDE).toMatch(/[Nn]o idempotency key/);
  });

  it('documents the create-only Lebanese phone rule that the schema enforces', () => {
    const wish = (phone: string) => ({
      amount: '100',
      currency: 'USD',
      payout: { method: 'WISH', recipientName: 'John Doe', recipientPhone: phone },
    });
    expect(createWithdrawalSchema.safeParse(wish('+96170000000')).success).toBe(true);
    expect(createWithdrawalSchema.safeParse(wish('+9613702825')).success).toBe(true);
    // 9 national digits — the shape check alone would accept this.
    expect(createWithdrawalSchema.safeParse(wish('9617075183')).success).toBe(false);

    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
    ] as const) {
      expect(doc, `${name} must document the 961 rule`).toMatch(/961/);
      expect(doc, `${name} must state the digit count`).toMatch(/8 digits/);
    }
  });

  it('documents PROCESSING as reachable for withdrawals and blocking cancel', () => {
    // The guide used to say PROCESSING "is not produced by these flows today",
    // which stopped being true once the auto-transfer pipeline landed.
    expect(GUIDE).not.toMatch(
      /`APPROVED` and `PROCESSING` exist in the shared status enum but are not produced/,
    );
    expect(read('apps/api/src/modules/withdrawals/withdrawals.service.ts')).toContain(
      "status: 'PROCESSING'",
    );
    // `PROCESSING` is mentioned in several sections (transactions, loads), so
    // require that at least ONE mention explains the cancel conflict rather than
    // anchoring on whichever happens to come first.
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
    ] as const) {
      const windows: string[] = [];
      for (let i = doc.indexOf('PROCESSING'); i !== -1; i = doc.indexOf('PROCESSING', i + 1)) {
        windows.push(doc.slice(i, i + 600));
      }
      expect(windows.length, `${name} never mentions PROCESSING`).toBeGreaterThan(0);
      expect(
        windows.some((w) => /409/.test(w) && /cancel/i.test(w)),
        `${name} must state that PROCESSING blocks cancel with a 409`,
      ).toBe(true);
    }
  });

  it('does not promise a Whish EXPIRED status or transaction.expired event', () => {
    // Both exist in the enums but nothing ever writes/emits them; a lapsed link
    // closes as FAILED. Clients waited for an expiry event that never comes.
    expect(read('apps/api/src/modules/whish/whish-payments.service.ts')).not.toContain(
      'WhishPaymentStatus.EXPIRED',
    );
    expect(GUIDE).toMatch(/no code path writes it|never emitted/i);
    expect(DEV_GUIDE).toMatch(/no `EXPIRED` status|never emitted/i);
  });

  it('scopes the per-key rate limiter to the endpoints that actually mount it', () => {
    // The company Whish Pay API keeps per-key safety brakes (its calls fan out
    // to Whish's own API); source ingest mounts its own guard, unlimited by
    // default, because that traffic is money that already left the payer.
    expect(
      read('apps/api/src/modules/whish/integrations-whish.controller.ts'),
      'integrations-whish should mount ApiKeyRateLimitGuard',
    ).toContain('ApiKeyRateLimitGuard');
    expect(
      read('apps/api/src/modules/transactions/ingest.controller.ts'),
      'ingest should mount IngestRateLimitGuard',
    ).toContain('IngestRateLimitGuard');
    // …and so do a payment link's own calls on the dashboard twin, which
    // companies also call with their key (never refuse a deposit's start).
    expect(read('apps/api/src/modules/whish/whish-payments.controller.ts')).toContain(
      'ApiKeyRateLimitGuard',
    );
    // Other company/* routes are per-IP only — the docs must not imply the
    // per-key brakes apply there.
    expect(
      read('apps/api/src/modules/withdrawals/withdrawals.controller.ts'),
      'withdrawals are per-IP throttled only',
    ).not.toContain('ApiKeyRateLimitGuard');
    expect(GUIDE).toMatch(/per-IP/);
    expect(DEV_GUIDE).toMatch(/per IP|per-IP/);
  });

  it('tells integrators the Authorization header is matched exactly', () => {
    // A valid key sent as `bearer tsk_…` fell through to the session guard and
    // reported an access-token error, costing a partner two days.
    expect(read('apps/api/src/modules/api-keys/guards/company-access.guard.ts')).toContain(
      "startsWith('Bearer tsk_')",
    );
    expect(GUIDE).toMatch(/case-sensitive/i);
    expect(DEV_GUIDE).toMatch(/case-sensitive/i);
  });

  it('states that no IP allowlisting exists or is required', () => {
    expect(GUIDE).toMatch(/IP allowlist/i);
    expect(DEV_GUIDE).toMatch(/IP allowlist/i);
  });

  it('states the Whish link amount is fixed (no partial or over-payment)', () => {
    expect(GUIDE).toMatch(/fixed on the hosted link/i);
    expect(DEV_GUIDE).toMatch(/fixed on the hosted page/i);
  });
});

/**
 * The network fee (2026-10): an optional second platform fee charged next to
 * the commission, surfaced as `networkFeeAmount` / `networkFee` /
 * `network_fee_amount`. Most companies integrate over the API, so every place
 * the docs list fee fields must carry it, the reconciliation invariant must be
 * the three-term one, and sources must still never hear of it.
 */
describe('docs contract — network fee', () => {
  const WEB_CRM = read('apps/web/src/features/company/crm-view.tsx');
  const WEB_COMPANY_API = read('apps/web/src/features/company/company-api-view.tsx');
  const WEB_WHISH = read('apps/web/src/features/company/whish-pay-docs-view.tsx');

  const documentedIn = (doc: string, field: string) =>
    doc.includes(`\`${field}\``) || doc.includes(`"${field}"`);

  // The text of `doc` from the heading `from` up to the next `to` — so a field
  // has to be documented in the RIGHT section, not just somewhere in the file.
  const section = (doc: string, from: string, to: string): string => {
    const start = doc.indexOf(from);
    expect(start, `section "${from}" not found`).toBeGreaterThan(-1);
    const end = doc.indexOf(to, start + from.length);
    expect(end, `end of section "${from}" ("${to}") not found`).toBeGreaterThan(start);
    return doc.slice(start, end);
  };

  // The column names of the `header` array literal that follows `anchor` in a
  // service file: one quoted name per line, so comment lines are skipped.
  const csvHeaderAfter = (src: string, anchor: string): string[] => {
    const at = src.indexOf(anchor);
    expect(at, `anchor "${anchor}" not found`).toBeGreaterThan(-1);
    const open = src.indexOf('[', at);
    const close = src.indexOf(']', open);
    return [...src.slice(open, close).matchAll(/^\s*'([a-z_]+)',?\s*$/gm)].map((m) => m[1]!);
  };

  it('every transactionResponseSchema field is in the TransactionResponse table', () => {
    const table = section(GUIDE, '### `TransactionResponse` fields', '### Status lifecycle');
    const missing = Object.keys(transactionResponseSchema.shape).filter(
      (k) => !documentedIn(table, k),
    );
    expect(missing, `transaction fields not documented: ${missing.join(', ')}`).toEqual([]);
  });

  it('every activityItemSchema field is documented in the activity section', () => {
    const activity = section(
      GUIDE,
      '### GET `/company/activity`',
      '### GET `/company/operations/counts`',
    );
    const missing = Object.keys(activityItemSchema.shape).filter((k) => !documentedIn(activity, k));
    expect(missing, `activity fields not documented: ${missing.join(', ')}`).toEqual([]);
  });

  it('every CRM event body field is documented in the CRM payload section', () => {
    const payload = section(
      GUIDE,
      '### The outbound payload we POST to your CRM',
      '#### Which events fire, and when',
    );
    for (const [name, schema] of [
      ['transaction', crmEventTransactionSchema],
      ['withdrawal', crmEventWithdrawalSchema],
    ] as const) {
      const missing = Object.keys(schema.shape).filter((k) => !documentedIn(payload, k));
      expect(missing, `${name} event fields not documented: ${missing.join(', ')}`).toEqual([]);
    }
  });

  // The invariant a CRM reconciles a withdrawal on. The two-term form silently
  // stops tying out the moment a company is charged a network fee.
  const OLD_INVARIANT = 'totalAmount − feeAmount = netAmount';
  const NEW_INVARIANT = 'totalAmount − feeAmount − networkFeeAmount = netAmount';
  it.each([
    ['companies-integration-docs.md', () => GUIDE],
    ['company-developer-guide.md', () => DEV_GUIDE],
    ['crm-view.tsx', () => WEB_CRM],
  ])('%s states the three-term withdrawal invariant, never the two-term one', (_name, doc) => {
    expect(doc()).not.toContain(OLD_INVARIANT);
    expect(doc()).toContain(NEW_INVARIANT);
  });

  it.each([
    [
      'transactions',
      () =>
        csvHeaderAfter(
          read('apps/api/src/modules/transactions/transactions.service.ts'),
          'TRANSACTIONS_CSV_HEADER = [',
        ),
    ],
    ['withdrawals / payouts / loads', (): string[] => [...FLOW_CSV_HEADER]],
    [
      'activity',
      () =>
        csvHeaderAfter(
          read('apps/api/src/modules/activity/activity.service.ts'),
          'ACTIVITY_CSV_HEADER = [',
        ),
    ],
  ])('the %s CSV header is documented exactly, ending in network_fee_amount', (_name, cols) => {
    const header = cols();
    expect(header.length, 'the header extraction found no columns').toBeGreaterThan(10);
    expect(header[header.length - 1]).toBe('network_fee_amount');
    expect(GUIDE).toContain(header.join(','));
  });

  it('explains the network fee is an optional platform fee, not a blockchain fee', () => {
    const fees = section(GUIDE, '### Fees: commission and network fee', '### Pagination');
    expect(fees).toMatch(/not a blockchain fee/i);
    expect(fees).toContain('payoutDetails.network');
    expect(fees).toMatch(/cannot set, change or remove it through the API/);
    expect(DEV_GUIDE).toMatch(/not a blockchain fee/i);
  });

  it('the worked examples match what the money code computes', () => {
    // $100 deposit, $2 commission, 1% network fee (DEDUCTED) → 2 / 1 / 97.
    const network = computeNetworkFee(Money.of('100'), { feeType: 'PERCENTAGE', feeValue: '1' });
    const deposit = { commission: Money.of('2'), network };
    expect(network.toString()).toBe('1');
    expect(netOfFee(Money.of('100'), deposit, 'DEDUCTED').toString()).toBe('97');
    // Withdrawal of 100, ON_TOP $2 fee + $1 network fee → 103 debited, 100 received.
    const withdrawal = { commission: Money.of('2'), network: Money.of('1') };
    expect(reservedTotal(Money.of('100'), withdrawal, 'ON_TOP').toString()).toBe('103');
    expect(netOfFee(Money.of('100'), withdrawal, 'ON_TOP').toString()).toBe('100');

    const fees = section(GUIDE, '### Fees: commission and network fee', '### Pagination');
    for (const line of ['"networkFeeAmount": "1"', '"netAmount": "97"', '"totalAmount": "103"']) {
      expect(fees).toContain(line);
    }
  });

  it('documents the exact error when DEDUCTED fees consume the whole amount', () => {
    const both = feesConsumeAmountError(
      Money.of('10'),
      { commission: Money.of('5'), network: Money.of('5') },
      'USD',
      'the recipient would receive 0',
    );
    expect(both.code).toBe('VALIDATION_ERROR');
    expect(both.details).toEqual({ amount: '10', fee: '5', networkFee: '5' });
    expect(GUIDE).toContain(both.message);
    expect(GUIDE).toContain('"details": { "amount": "10", "fee": "5", "networkFee": "5" }');
    const commissionOnly = feesConsumeAmountError(
      Money.of('10'),
      { commission: Money.of('10'), network: Money.zero() },
      'USD',
      'nothing would be credited',
    );
    expect(commissionOnly.message.endsWith('Increase the amount or fix the fee rule.')).toBe(true);
    expect(GUIDE).toContain('Increase the amount or fix the fee rule.');
  });

  it('tells integrators to treat a missing networkFeeAmount on an older event as "0"', () => {
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
      ['crm-view.tsx', WEB_CRM],
    ] as const) {
      expect(doc, `${name} must cover events queued before the field existed`).toMatch(
        /treat a missing[\s\S]{0,60}networkFeeAmount/,
      );
    }
  });

  it('the developer guide and in-app pages mirror the new fields', () => {
    for (const [name, doc] of [
      ['developer guide', DEV_GUIDE],
      ['company-api-view.tsx', WEB_COMPANY_API],
    ] as const) {
      expect(doc, `${name} should document networkFeeAmount`).toContain('networkFeeAmount');
      expect(doc, `${name} should document the CSV column`).toContain('network_fee_amount');
    }
    // Both CRM sample payloads (deposit + withdrawal) carry the field.
    expect(WEB_CRM.match(/"networkFeeAmount": "0"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(WEB_WHISH).toContain('networkFeeAmount');
  });

  it('the sources doc states the ingest response omits the network fee too', () => {
    expect(INGEST_DOC).toMatch(/deliberately omits the fee/i);
    expect(INGEST_DOC).toContain('no `commissionAmount` / `networkFeeAmount` / `netAmount`');
  });

  it('the partner doc never mentions a network fee (sources never see pricing)', () => {
    expect(read('docs/rival-ingest-api-integration.md')).not.toMatch(/network ?fee/i);
  });
});

/**
 * Review regressions (2026-10-12). Each pins a statement the docs got wrong, or
 * a thing integrators must be told — in the markdown guides AND the in-app
 * pages, which are a hand-written mirror and drift silently.
 */
describe('docs contract — fee models, CRM ordering, rate-limit headers', () => {
  const WEB_COMPANY_API = read('apps/web/src/features/company/company-api-view.tsx');
  const WEB_CRM = read('apps/web/src/features/company/crm-view.tsx');
  const WEB_GETTING_STARTED = read('apps/web/src/features/company/getting-started-view.tsx');
  // JSX wraps text across lines; compare on single-spaced text.
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('explains both fee models everywhere: single-fee companies change nothing', () => {
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
      ['company-api-view.tsx', WEB_COMPANY_API],
    ] as const) {
      const text = flat(doc);
      expect(text, `${name}: the single-fee model`).toMatch(/Single fee/);
      expect(text, `${name}: the dual-fee model`).toMatch(/Dual fee/);
      // The promise a single-fee company relies on.
      expect(text, `${name}: single-fee integrations need no change`).toMatch(
        /needs no change|Nothing\.\*\* Everything works exactly as it always has|keeps working without a single change/,
      );
      // How a dual-fee company passes the network fee on to its own customer.
      expect(text, `${name}: credit the customer amount − networkFeeAmount`).toMatch(
        /amount − networkFeeAmount/,
      );
      expect(text, `${name}: Rival never charges the company's customer`).toMatch(
        /Rival never charges your customer/,
      );
    }
  });

  it('the dual-fee example is the arithmetic the engine actually performs', () => {
    // $100 deposit, 1.5% commission + 1% network fee, DEDUCTED → 97.50 credited.
    const amount = Money.of('100');
    const commission = amount.percent('1.5').round();
    const network = computeNetworkFee(amount, { feeType: 'PERCENTAGE', feeValue: '1' });
    const net = netOfFee(amount, { commission, network }, 'DEDUCTED');
    expect([commission.toString(), network.toString(), net.toString()]).toEqual([
      '1.5',
      '1',
      '97.5',
    ]);
    // …and the single-fee twin: 2.5% commission, no network fee → the same 97.50.
    const single = netOfFee(
      amount,
      { commission: amount.percent('2.5').round(), network: Money.zero() },
      'DEDUCTED',
    );
    expect(single.toString()).toBe('97.5');
    for (const doc of [GUIDE, DEV_GUIDE]) {
      expect(doc).toContain('`"1.5"`');
      expect(doc).toContain('`"97.5"`');
      expect(doc).toMatch(/\*\*\$99\*\* \(`amount − networkFeeAmount`\)/);
    }
    expect(WEB_COMPANY_API).toContain('$99 (amount − networkFeeAmount)');
  });

  it('does not claim the fees-consume-amount error always names both fees', () => {
    expect(GUIDE).not.toMatch(/the message names both fees and/);
    expect(DEV_GUIDE).not.toMatch(/\(the message names both fees\)/);
    // With no commission on the flow, only the network fee is named.
    const networkOnly = feesConsumeAmountError(
      Money.of('1'),
      { commission: Money.zero(), network: Money.of('1') },
      'USD',
      'the recipient would receive 0',
    );
    expect(networkOnly.details).toEqual({ amount: '1', fee: '0', networkFee: '1' });
    expect(networkOnly.message.startsWith('The 1 USD network fee consumes the entire amount')).toBe(
      true,
    );
    expect(GUIDE).toContain('The 1 USD network fee consumes the entire amount');
  });

  it('tells CRMs that deliveries are unordered and how to stay correct', () => {
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
      ['crm-view.tsx', WEB_CRM],
    ] as const) {
      const text = flat(doc);
      expect(text, `${name}: never say a bare upsert is safe`).not.toMatch(
        /upserting by (<code[^>]*>)?`?reference`?(<\/code>)? makes that harmless/,
      );
      expect(text, `${name}: deliveries are not ordered`).toMatch(/not ordered/);
      expect(text, `${name}: order by sentAt`).toMatch(
        /never let an older event overwrite a newer one/i,
      );
      expect(text, `${name}: names the field to order by`).toContain('sentAt');
    }
  });

  it('documents rate-limit headers in seconds, on both limiters', () => {
    expect(GUIDE).toContain('**Every value is in seconds.**');
    expect(GUIDE).toContain('`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`');
    expect(GUIDE).not.toMatch(/does not carry these details\/headers/);
    expect(DEV_GUIDE).toMatch(/`Retry-After`[^.]*seconds/);
    expect(flat(WEB_GETTING_STARTED)).toMatch(/Retry-After/);
    // Not "the only exemptions are …" — other (non-company) surfaces are exempt too.
    expect(GUIDE).not.toMatch(/The only exemptions are/);
  });
});

/**
 * "Deposits are never rate-limited" (2026-10-13). A company's customers start
 * their deposits by getting a Whish payment link from the company's server, so
 * a per-IP cap would refuse customers at the company's busiest minute. Pinned:
 * the code has no per-IP cap there, the per-key brakes are the documented
 * numbers, and every guide says so.
 */
describe('docs contract — deposits are never rate-limited', () => {
  const ENV_SCHEMA = read('apps/api/src/config/env.schema.ts');
  const WEB_GETTING_STARTED = read('apps/web/src/features/company/getting-started-view.tsx');
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const envDefault = (name: string): number => {
    const m = new RegExp(`${name}: z\\.coerce\\.number\\(\\)[^\\n]*\\.default\\((\\d+)\\)`).exec(
      ENV_SCHEMA,
    );
    expect(m, `${name} default not found`).not.toBeNull();
    return Number(m![1]);
  };

  it('the Whish Pay API has no per-IP cap — only its per-key brakes', () => {
    const controller = read('apps/api/src/modules/whish/integrations-whish.controller.ts');
    expect(controller).toMatch(/@SkipThrottle\(\)/);
    expect(controller).toContain("@IntegrationBudget('create')");
    expect(controller).toContain("@IntegrationBudget('lookup')");
    expect(controller).toContain("@IntegrationBudget('refresh')");
    // …and Whish's payment confirmations are not per-IP capped either.
    expect(read('apps/api/src/modules/whish/whish-callback.controller.ts')).toMatch(
      /@SkipThrottle\(\)/,
    );
  });

  it('documents the brakes the code actually enforces', () => {
    expect(envDefault('INTEGRATION_CREATE_RATE_LIMIT_MAX')).toBe(6000);
    expect(envDefault('INTEGRATION_LOOKUP_RATE_LIMIT_MAX')).toBe(30000);
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
      ['getting-started-view.tsx', WEB_GETTING_STARTED],
    ] as const) {
      const text = flat(doc);
      expect(text, `${name}: the principle`).toMatch(/Deposits are never rate-limited/);
      expect(text, `${name}: no per-IP limit on link creation`).toMatch(/no per-IP limit/);
      expect(text, `${name}: link-creation brake`).toMatch(/6,000 a minute/);
      expect(text, `${name}: lookup brake`).toMatch(/30,000 a minute/);
      expect(text, `${name}: no stale 300/60s allowance`).not.toMatch(/300 requests/);
    }
  });

  it('never reads the retired INTEGRATION_RATE_LIMIT_MAX — staging still carries =300', () => {
    // The old combined cap. Its line is still in staging's hand-kept env file, so
    // reading that name again would silently cap link creation at 300 a minute.
    expect(ENV_SCHEMA).not.toMatch(/^\s*INTEGRATION_RATE_LIMIT_MAX:/m);
    expect(read('apps/api/src/modules/api-keys/guards/api-key-rate-limit.guard.ts')).not.toMatch(
      /'INTEGRATION_RATE_LIMIT_MAX'/,
    );
    for (const f of ['docker-compose.prod.yml', 'docker-compose.staging.yml']) {
      const compose = read(f);
      expect(compose, f).not.toMatch(/\bINTEGRATION_RATE_LIMIT_MAX\b/);
      expect(compose, f).toContain(
        'INTEGRATION_CREATE_RATE_LIMIT_MAX: ${INTEGRATION_CREATE_RATE_LIMIT_MAX:-6000}',
      );
    }
  });

  it('never says link creation is capped per IP any more', () => {
    // …not on the Whish Pay API, nor on its dashboard twin (/company/whish/payments).
    for (const [name, doc] of [
      ['companies guide', GUIDE],
      ['developer guide', DEV_GUIDE],
      ['getting-started-view.tsx', WEB_GETTING_STARTED],
    ] as const) {
      const text = flat(doc);
      expect(text, `${name}: twin capped per IP`).not.toMatch(/twin is capped per IP/);
      expect(text, `${name}: steering volume off the twin`).not.toMatch(/create links at volume/);
    }
    expect(GUIDE).not.toMatch(/100 link creations a minute/);
    expect(GUIDE).not.toMatch(/governed by \*\*both\*\* limiters/);
    expect(DEV_GUIDE).not.toMatch(/\*\*and\*\* `\/v1\/integrations\/whish\/\*`/);
  });
});
