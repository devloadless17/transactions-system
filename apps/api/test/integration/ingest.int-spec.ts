/**
 * Integration tests for ingest idempotency / replay semantics and the
 * cross-company duplicate guard. These lock the source-facing contract:
 *   - a repeat of the same (source, externalId) OR idempotencyKey for the same
 *     company is an idempotent REPLAY — same row, no new money, `replayed: true`;
 *   - the same (source, externalId) reused by a DIFFERENT company is a clean
 *     `DUPLICATE_TRANSACTION` 409 (the global unique constraint), not a raw
 *     Prisma error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { RealtimeService } from '../../src/modules/realtime/realtime.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  type Harness,
} from './harness';

// Minimal stand-in for the realtime gateway (no socket in tests).
const fakeRealtime = {
  company: () => undefined,
  admin: () => undefined,
} as unknown as RealtimeService;

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('ingest idempotency & replay', () => {
  it('flags a natural (source, externalId) replay and books no new money', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');

    const first = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'ext-replay-1' }),
    );
    expect(first.replayed).toBe(false);

    const second = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'ext-replay-1' }),
    );
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    // The replay booked nothing: available reflects exactly ONE ingest of 100.
    const snap = await snapshot(h, companyId);
    expect(Money.of(snap.wallet!.available).eq(Money.of('100'))).toBe(true);
  });

  it('flags an explicit idempotencyKey replay (even with a different externalId)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');

    const a = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '50', {
        externalTransactionId: 'ext-k-1',
        idempotencyKey: 'idem-key-1',
      }),
    );
    expect(a.replayed).toBe(false);

    const b = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '50', {
        externalTransactionId: 'ext-k-2',
        idempotencyKey: 'idem-key-1',
      }),
    );
    expect(b.replayed).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it('rejects a (source, externalId) reused by a DIFFERENT company with DUPLICATE_TRANSACTION 409', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    const sourceId = await createEnabledSource(h, a.companyId); // one shared source
    await addTransactionFee(h, a.companyId, '0');
    await addTransactionFee(h, b.companyId, '0');

    await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(a.companyId, '100', { externalTransactionId: 'shared-ext-1' }),
    );

    await expect(
      h.transactions.ingest(
        { kind: 'source', sourceId },
        ingestInput(b.companyId, '100', { externalTransactionId: 'shared-ext-1' }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_TRANSACTION', httpStatus: 409 });
  });

  it('rejects an ingest for a company with no commission rule (NO_COMMISSION_RULE 422)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    // Deliberately NO commission rule configured for this company → the ingest
    // can't be priced. It must fail 422 (and, in production, increments
    // txn_ingest_no_rule_total + emits a deduped operator alert).
    await expect(
      h.transactions.ingest(
        { kind: 'source', sourceId },
        ingestInput(companyId, '100', { externalTransactionId: 'ext-norule-1' }),
      ),
    ).rejects.toMatchObject({ code: 'NO_COMMISSION_RULE', httpStatus: 422 });
  });

  it('a company created WITH a starter commission rule can ingest immediately (prevents the trap)', async () => {
    const companies = new CompaniesService(h.prisma, fakeRealtime);
    const uniq = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const created = await companies.create({
      name: `Starter Co ${uniq}`,
      slug: `starter-${uniq}`,
      defaultCurrency: 'USD',
      ownerEmail: `owner-${uniq}@example.test`,
      // 0% deducted on TRANSACTION so net == amount and the math is obvious.
      commission: {
        name: 'starter',
        operations: [{ operationType: 'TRANSACTION', feeApplication: 'DEDUCTED' }],
        priority: 100,
        active: true,
        tiers: [
          { minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '0' },
        ],
      },
    });
    const companyId = created.company.id;
    const sourceId = await createEnabledSource(h, companyId);

    // No addTransactionFee() call here — the starter rule from company creation
    // is what prices this ingest. It must succeed, not throw NO_COMMISSION_RULE.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'starter-ext-1' }),
    );
    expect(txn.replayed).toBe(false);
    expect(Money.of(txn.netAmount).eq(Money.of('100'))).toBe(true);

    const snap = await snapshot(h, companyId);
    expect(Money.of(snap.wallet!.available).eq(Money.of('100'))).toBe(true);
  });
});
