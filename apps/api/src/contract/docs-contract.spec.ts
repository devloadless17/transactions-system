import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createLoadSchema,
  createPayoutSchema,
  createWhishPaymentSchema,
  createWithdrawalSchema,
  listNotificationsQuerySchema,
  loadResponseSchema,
  paginationSchema,
  payoutResponseSchema,
  whishPaymentResponseSchema,
  withdrawalResponseSchema,
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
    it('the ingest docs list the 422 NO_COMMISSION_RULE outcome (audit #6)', () => {
      expect(INGEST_DOC).toContain('NO_COMMISSION_RULE');
      expect(GUIDE).toContain('NO_COMMISSION_RULE');
    });

    it('the whish payments list is documented with real params, not phantom from/to (audit #12)', () => {
      const line = GUIDE.split('\n').find(
        (l) => l.includes('/v1/company/whish/payments') && /List payments/.test(l),
      );
      expect(line, 'the whish payments list row should exist in the guide').toBeTruthy();
      expect(line).toContain('needsAttention');
      expect(line).not.toMatch(/`from`|`to`/);
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
});
