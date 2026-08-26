import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createLoadSchema,
  createPayoutSchema,
  createWhishPaymentSchema,
  createWithdrawalSchema,
  WHISH_AMOUNT_RULES,
  listNotificationsQuerySchema,
  listWhishPaymentsQuerySchema,
  loadResponseSchema,
  paginationSchema,
  payoutResponseSchema,
  whishPaymentResponseSchema,
  withdrawalResponseSchema,
  WithdrawalStatus,
} from '@app/shared';

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

  describe('error envelope codes are documented', () => {
    it('both guides describe the standard error codes integrators key off', () => {
      for (const code of ['VALIDATION_ERROR', 'UNAUTHORIZED']) {
        expect(GUIDE, `companies guide should document ${code}`).toContain(code);
      }
      expect(INGEST_DOC).toContain('VALIDATION_ERROR');
      expect(INGEST_DOC).toContain('DUPLICATE_TRANSACTION');
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
    const keyLimited = [
      'apps/api/src/modules/whish/integrations-whish.controller.ts',
      'apps/api/src/modules/transactions/ingest.controller.ts',
    ];
    for (const rel of keyLimited) {
      expect(read(rel), `${rel} should mount ApiKeyRateLimitGuard`).toContain(
        'ApiKeyRateLimitGuard',
      );
    }
    // company/* routes are per-IP only — the docs must not imply the 300/60s allowance.
    for (const rel of [
      'apps/api/src/modules/withdrawals/withdrawals.controller.ts',
      'apps/api/src/modules/whish/whish-payments.controller.ts',
    ]) {
      expect(read(rel), `${rel} is per-IP throttled only`).not.toContain('ApiKeyRateLimitGuard');
    }
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
