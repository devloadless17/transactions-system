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
import { Money, UserRole } from '@app/shared';
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

  it('books an ingest for a company with NO commission rule at net 0 — deposits never bounce', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    // Deliberately NO commission rule configured for this company. The deposit
    // already happened at the source, so it must BOOK, not 422: the full amount
    // is withheld as platform fee (net 0) and, in production, ops is alerted
    // (txn_ingest_no_rule_total + deduped operator alert) to fix pricing and
    // compensate. Withholding is recoverable by a later credit; bouncing would
    // strand money the source cannot re-send.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'ext-norule-1' }),
    );
    expect(txn.status).toBe('COMPLETED');
    expect(Money.of(txn.amount).eq(Money.of('100'))).toBe(true);
    expect(Money.of(txn.commissionAmount).eq(Money.of('100'))).toBe(true);
    expect(Money.of(txn.netAmount).eq(Money.of('0'))).toBe(true);

    // Durable compensation marker: the row is queryable via pricing_issue.
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: txn.id }, select: { pricingIssue: true } }),
    );
    expect(row?.pricingIssue).toBe('unpriced');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Money.of(snap.availableLedger).eq(Money.zero())).toBe(true);
    expect(snap.wallet === null || Money.of(snap.wallet.available).eq(Money.zero())).toBe(true);
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
        operations: [
          {
            operationType: 'TRANSACTION',
            feeApplication: 'DEDUCTED',
            tiers: [
              {
                minAmount: '0',
                maxAmount: null,
                commissionType: 'PERCENTAGE',
                commissionValue: '0',
              },
            ],
          },
        ],
        priority: 100,
        active: true,
      },
    });
    const companyId = created.company.id;
    const sourceId = await createEnabledSource(h, companyId);

    // No addTransactionFee() call here — the starter rule from company creation
    // is what prices this ingest. Net 100 (0% rule) proves it was priced by the
    // starter rule and did NOT fall into the unpriced net-0 fallback.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'starter-ext-1' }),
    );
    expect(txn.replayed).toBe(false);
    expect(Money.of(txn.netAmount).eq(Money.of('100'))).toBe(true);

    const snap = await snapshot(h, companyId);
    expect(Money.of(snap.wallet!.available).eq(Money.of('100'))).toBe(true);
  });

  it('ingests for a hidden (visible:false) but ACTIVE company — visibility is discovery-only, NOT an ingest gate', async () => {
    // Regression guard: a prod incident stranded paid Whish deposits when a
    // company was hidden from source discovery — the old ingest path wrongly
    // 403'd on `visible:false`, so already-collected money couldn't settle.
    // `visible` must gate ONLY GET /v1/ingest/companies; ACTIVE companies still
    // ingest (and Whish links still settle) regardless. Deactivation (status) is
    // the real off-switch.
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');
    await h.prisma.runAsAdmin((tx) =>
      tx.company.update({ where: { id: companyId }, data: { visible: false } }),
    );

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100', { externalTransactionId: 'hidden-ext-1' }),
    );
    expect(txn.replayed).toBe(false);
    expect(Money.of(txn.netAmount).eq(Money.of('100'))).toBe(true);

    const snap = await snapshot(h, companyId);
    expect(Money.of(snap.wallet!.available).eq(Money.of('100'))).toBe(true);
  });

  it('books a deposit smaller than a fixed DEDUCTED fee at net 0 (fee capped at amount) — deposits never bounce', async () => {
    // Money-IN policy: the deposit already happened at the source. A DEDUCTED
    // fixed fee larger than the amount used to 422 the ingest and strand the
    // money; now the fee is capped AT the amount — the platform keeps all of
    // it, the company nets 0, and the ledger stays balanced with no AVAILABLE
    // leg (EXTERNAL debit == FEE credit).
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await h.prisma.runAsAdmin((tx) =>
      tx.commissionRule.create({
        data: {
          companyId,
          sourceId: null,
          operationType: 'TRANSACTION',
          feeApplication: 'DEDUCTED',
          minAmount: '0.01',
          maxAmount: '100000000',
          commissionType: 'FIXED',
          commissionValue: '3',
          priority: 100,
          active: true,
        },
      }),
    );

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '1', { externalTransactionId: 'capped-fee-ext-1' }),
    );
    expect(txn.status).toBe('COMPLETED');
    expect(Money.of(txn.amount).eq(Money.of('1'))).toBe(true);
    expect(Money.of(txn.commissionAmount).eq(Money.of('1'))).toBe(true);
    expect(Money.of(txn.netAmount).eq(Money.of('0'))).toBe(true);
    const capRow = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: txn.id }, select: { pricingIssue: true } }),
    );
    expect(capRow?.pricingIssue).toBe('capped');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    // Company received nothing; the full amount is platform fee revenue.
    expect(Money.of(snap.availableLedger).eq(Money.zero())).toBe(true);
    expect(snap.wallet === null || Money.of(snap.wallet.available).eq(Money.zero())).toBe(true);

    // A normal-sized deposit for the same company still prices normally.
    const ok = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '50', { externalTransactionId: 'capped-fee-ext-2' }),
    );
    expect(Money.of(ok.commissionAmount).eq(Money.of('3'))).toBe(true);
    expect(Money.of(ok.netAmount).eq(Money.of('47'))).toBe(true);
  });
});

describe('slug tombstones — a renamed-away slug can never route to another tenant', () => {
  const SUPER = { actorRole: UserRole.SUPER_ADMIN };
  const companies = () => new CompaniesService(h.prisma, fakeRealtime);

  it('blocks another company from claiming a retired slug (create AND rename), but lets the owner reclaim it', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    const aSlug = (await h.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({ where: { id: a.companyId }, select: { slug: true } }),
    ))!.slug;

    // A renames away — old slug is tombstoned.
    const renamed = `${aSlug}-v2`;
    await companies().update(a.companyId, { slug: renamed }, SUPER);

    // B cannot take A's old slug by rename…
    await expect(companies().update(b.companyId, { slug: aSlug }, SUPER)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });

    // …nor can a brand-new company be created with it.
    const uniq = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    await expect(
      companies().create({
        name: `Squatter ${uniq}`,
        slug: aSlug,
        defaultCurrency: 'USD',
        ownerEmail: `squatter-${uniq}@example.test`,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });

    // The original owner MAY reclaim its own retired slug.
    const back = await companies().update(a.companyId, { slug: aSlug }, SUPER);
    expect(back.slug).toBe(aSlug);
  });
});
