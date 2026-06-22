import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createWhishPaymentSchema,
  createWithdrawalSchema,
  whishPaymentResponseSchema,
} from '@app/shared';

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
});
