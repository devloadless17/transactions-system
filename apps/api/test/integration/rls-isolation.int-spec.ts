/**
 * Integration tests for Row-Level Security. These prove the tenant boundary is
 * enforced by the database — not just by application `where` clauses — so a
 * forgotten filter (or a future refactor) cannot leak or mis-book across
 * tenants. Reads are scoped; cross-tenant writes are rejected by WITH CHECK.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  USD,
  type Harness,
} from './harness';

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('RLS tenant isolation', () => {
  it('scopes reads to the acting tenant', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    const sourceId = await createEnabledSource(h, a.companyId);
    await addTransactionFee(h, a.companyId, '10');

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(a.companyId, '100'),
    );

    // A sees its own transaction; B sees nothing of A's.
    const aRows = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.transaction.findMany({ where: {} }),
    );
    const bRows = await h.prisma.runAsTenant(b.companyId, (tx) =>
      tx.transaction.findMany({ where: {} }),
    );
    expect(aRows.some((r) => r.id === txn.id)).toBe(true);
    expect(bRows).toHaveLength(0);

    // A direct id lookup is invisible across the tenant boundary.
    const seenByB = await h.prisma.runAsTenant(b.companyId, (tx) =>
      tx.transaction.findUnique({ where: { id: txn.id } }),
    );
    expect(seenByB).toBeNull();
    const seenByA = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.transaction.findUnique({ where: { id: txn.id } }),
    );
    expect(seenByA).not.toBeNull();
  });

  it('isolates ledger entries and wallets per tenant', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    const sourceId = await createEnabledSource(h, a.companyId);
    await addTransactionFee(h, a.companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(a.companyId, '100'));

    const bLedger = await h.prisma.runAsTenant(b.companyId, (tx) =>
      tx.ledgerEntry.findMany({ where: {} }),
    );
    const bWallets = await h.prisma.runAsTenant(b.companyId, (tx) =>
      tx.wallet.findMany({ where: {} }),
    );
    expect(bLedger).toHaveLength(0);
    expect(bWallets).toHaveLength(0);
  });

  it('rejects a cross-tenant write via the WITH CHECK policy', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);

    // Scoped to B, try to insert a row owned by A — RLS WITH CHECK must reject.
    await expect(
      h.prisma.runAsTenant(b.companyId, (tx) =>
        tx.wallet.create({ data: { companyId: a.companyId, currency: USD } }),
      ),
    ).rejects.toThrow();

    // And A still has no wallet (the rejected write left nothing behind).
    const aWallets = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.wallet.findMany({ where: {} }),
    );
    expect(aWallets).toHaveLength(0);
  });

  it('lets an admin (RLS bypass) read across tenants', async () => {
    const a = await createCompany(h);
    const sourceId = await createEnabledSource(h, a.companyId);
    await addTransactionFee(h, a.companyId, '10');
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(a.companyId, '100'),
    );

    const found = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: txn.id } }),
    );
    expect(found).not.toBeNull();
    expect(found!.companyId).toBe(a.companyId);
  });
});
