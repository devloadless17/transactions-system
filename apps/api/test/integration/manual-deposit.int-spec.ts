import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  setNetworkFee,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * Manual deposits: a super admin records by hand a deposit a source has made
 * but is not yet sending through the ingest API. The promise is that it is the
 * SAME deposit the API would book — so these tests pin it against a real API
 * ingest — and that when the source later DOES send it, it is never credited
 * twice.
 */

const legsOf = async (h: Harness, transactionId: string) =>
  (
    await h.prisma.runAsAdmin((tx) =>
      tx.ledgerEntry.findMany({
        where: { transactionId },
        select: { accountType: true, direction: true, amount: true },
      }),
    )
  )
    .map((l) => `${l.direction} ${l.accountType} ${Number(l.amount.toString())}`)
    .sort();

describe('Manual deposits — the same deposit the source API books', () => {
  let h: Harness;
  beforeAll(() => {
    h = buildHarness();
  });
  beforeEach(() => h.crm.reset());

  /** A priced company + source pair: 2% deposit fee, optional 1% network fee. */
  async function pricedPair(opts: { networkFee?: boolean } = {}) {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '2');
    if (opts.networkFee) {
      await setNetworkFee(h, companyId, {
        enabled: true,
        rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
      });
    }
    return { companyId, sourceId };
  }

  const manual = (
    sourceId: string,
    companyId: string,
    externalTransactionId: string,
    amount = '100.00',
    extra: Record<string, string> = {},
  ) =>
    h.transactions.createManualDeposit({
      sourceId,
      companyId,
      externalTransactionId,
      amount,
      currency: USD,
      payload: extra,
    });

  it('books exactly what the source API books — fees, net, ledger legs, CRM event', async () => {
    const { companyId, sourceId } = await pricedPair({ networkFee: true });

    const viaApi = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100.00', { externalTransactionId: 'api-1' }),
    );
    const viaForm = await manual(sourceId, companyId, 'form-1');

    for (const k of [
      'amount',
      'commissionAmount',
      'networkFeeAmount',
      'netAmount',
      'status',
    ] as const) {
      expect(viaForm[k]).toBe(viaApi[k]);
    }
    expect(Number(viaForm.commissionAmount)).toBe(2);
    expect(Number(viaForm.networkFeeAmount)).toBe(1);
    expect(Number(viaForm.netAmount)).toBe(97);
    expect(await legsOf(h, viaForm.id)).toEqual(await legsOf(h, viaApi.id));
    // The company's CRM hears about it exactly like an API deposit.
    expect(h.crm.names()).toEqual(['transaction.completed', 'transaction.completed']);
    const snap = await snapshot(h, companyId);
    expect(Number(snap.wallet?.available)).toBe(194);
    expect(snap.balanced).toBe(true);
  });

  it('the preview shows exactly what the booking then books', async () => {
    const { companyId, sourceId } = await pricedPair({ networkFee: true });

    const preview = await h.transactions.previewManualDeposit({
      sourceId,
      companyId,
      amount: '250.00',
      currency: USD,
    });
    const booked = await manual(sourceId, companyId, 'form-preview', '250.00');

    expect(preview).toEqual({
      amount: booked.amount,
      currency: USD,
      feeApplication: 'DEDUCTED',
      commissionAmount: booked.commissionAmount,
      networkFeeAmount: booked.networkFeeAmount,
      netAmount: booked.netAmount,
    });
  });

  it('when the source later sends the same deposit through the API, it is NOT credited twice', async () => {
    const { companyId, sourceId } = await pricedPair();
    const booked = await manual(sourceId, companyId, 'SRC-REF-42');
    h.crm.reset();
    const before = await snapshot(h, companyId);

    const fromApi = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100.00', { externalTransactionId: 'SRC-REF-42' }),
    );

    expect(fromApi.replayed).toBe(true);
    expect(fromApi.id).toBe(booked.id);
    const after = await snapshot(h, companyId);
    expect(after.wallet?.available).toBe(before.wallet?.available);
    expect(after.totalCredit).toBe(before.totalCredit);
    expect(h.crm.names()).toEqual([]);
  });

  it('refuses a reference this source already has — never books it twice, never says "done"', async () => {
    const { companyId, sourceId } = await pricedPair();
    await manual(sourceId, companyId, 'dup-1');
    const before = await snapshot(h, companyId);

    await expect(manual(sourceId, companyId, 'dup-1', '55.00')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const after = await snapshot(h, companyId);
    expect(after.wallet?.available).toBe(before.wallet?.available);
  });

  it('refuses a reference the API already booked for this source', async () => {
    const { companyId, sourceId } = await pricedPair();
    await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100.00', { externalTransactionId: 'api-first' }),
    );

    await expect(manual(sourceId, companyId, 'api-first')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a double click books one deposit', async () => {
    const { companyId, sourceId } = await pricedPair();

    const results = await Promise.allSettled([
      manual(sourceId, companyId, 'double'),
      manual(sourceId, companyId, 'double'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(98);
    expect(h.crm.names()).toEqual(['transaction.completed']);
  });

  it('is priced STRICTLY: with no commission rule it is refused — never booked at net 0', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId); // no fee rule at all

    await expect(
      h.transactions.previewManualDeposit({ sourceId, companyId, amount: '10.00', currency: USD }),
    ).rejects.toMatchObject({ code: 'NO_COMMISSION_RULE' });
    await expect(manual(sourceId, companyId, 'unpriced', '10.00')).rejects.toMatchObject({
      code: 'NO_COMMISSION_RULE',
    });

    const rows = await h.prisma.runAsAdmin((tx) => tx.transaction.count({ where: { companyId } }));
    expect(rows).toBe(0);
    expect(h.crm.names()).toEqual([]);
  });

  it('keeps the descriptive fields a source would send', async () => {
    const { companyId, sourceId } = await pricedPair();

    const booked = await manual(sourceId, companyId, 'with-details', '20.00', {
      customer: 'Jane Payer',
      target: 'ACC-778',
      phone: '+96170000000',
      note: 'Entered by hand until the source API is live',
    });

    expect(booked).toMatchObject({
      customer: 'Jane Payer',
      target: 'ACC-778',
      phone: '+96170000000',
      note: 'Entered by hand until the source API is live',
    });
  });

  it('refuses an inactive company or source', async () => {
    const { companyId, sourceId } = await pricedPair();
    await h.prisma.runAsAdmin((tx) =>
      tx.source.update({ where: { id: sourceId }, data: { status: 'INACTIVE' } }),
    );
    await expect(manual(sourceId, companyId, 'inactive-src')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const other = await pricedPair();
    await h.prisma.runAsAdmin((tx) =>
      tx.company.update({ where: { id: other.companyId }, data: { status: 'SUSPENDED' } }),
    );
    await expect(manual(other.sourceId, other.companyId, 'inactive-co')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
