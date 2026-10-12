/**
 * The optional per-company NETWORK FEE, end to end against the real database
 * (RLS enforced, real ledger, real wallets). Every flow is exercised with the
 * switch ON — deposits (both channels, both fee applications, the bounded and
 * unpriced edges), reversal, withdrawals (incl. whole-dollar auto settlement,
 * PROCESSING completion, reject/cancel), payouts, loads (incl. receivable
 * settlement and the admin direct load) — and each one asserts the exact legs
 * it booked plus the wallet == ledger projection.
 *
 * The switch-OFF guarantee (byte-identical to the single-fee system) is pinned
 * separately in network-fee-off-parity.int-spec.ts and by every pre-existing
 * integration spec, all of which run with the switch off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, WhishPaymentStatus, type CreateWithdrawalInput } from '@app/shared';
import {
  addFixedFlowFee,
  addFlowFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  legsFor,
  loadInput,
  payoutInput,
  setNetworkFee,
  snapshot,
  USD,
  type Harness,
} from './harness';

/** Money-aware equality so 97 and 97.00000000 compare equal. */
const eq = (a: string | undefined, b: string) => a !== undefined && Money.of(a).eq(Money.of(b));

/** Assert a row's legs exactly: every expected leg present with that amount, nothing else. */
function expectLegs(actual: Record<string, string>, expected: Record<string, string>): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [k, v] of Object.entries(expected)) {
    expect(eq(actual[k], v), `${k}: ${actual[k]} != ${v}`).toBe(true);
  }
}

/**
 * The books balance and the wallet is a faithful projection of the ledger. A
 * company that was never credited has no wallet row yet — that reads as 0.
 */
async function expectConsistent(h: Harness, companyId: string) {
  const s = await snapshot(h, companyId);
  const wallet = s.wallet ?? { available: '0', reserved: '0', pending: '0' };
  expect(s.balanced).toBe(true);
  expect(eq(wallet.available, s.availableLedger)).toBe(true);
  expect(eq(wallet.reserved, s.reservedLedger)).toBe(true);
  return { ...s, wallet };
}

function wishWithdrawalInput(amount: string): CreateWithdrawalInput {
  return {
    amount,
    currency: USD,
    payout: { method: 'WISH', recipientName: 'Whish Payee', recipientPhone: '+96170000000' },
  };
}

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

/** A company with an enabled source and the network fee ON for deposits. */
async function depositCompany(opts: {
  network: { feeType: 'FIXED' | 'PERCENTAGE'; feeValue: string };
}) {
  const co = await createCompany(h);
  const sourceId = await createEnabledSource(h, co.companyId);
  await setNetworkFee(h, co.companyId, {
    enabled: true,
    rates: [{ operationType: 'TRANSACTION', ...opts.network }],
  });
  return { ...co, sourceId };
}

/** Fund a company's wallet with a fee-free deposit (no TRANSACTION network rate). */
async function fund(companyId: string, amount: string): Promise<void> {
  const sourceId = await createEnabledSource(h, companyId);
  await addFlowFee(h, companyId, 'TRANSACTION', '0');
  await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, amount));
}

describe('network fee — deposits', () => {
  it("books the tech lead's example: $100 with a $2 fee and a 1% network fee credits $97", async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.commissionAmount, '2')).toBe(true);
    expect(eq(txn.networkFeeAmount, '1')).toBe(true);
    expect(eq(txn.netAmount, '97')).toBe(true);

    expectLegs(await legsFor(h, companyId, { transactionId: txn.id }), {
      'EXTERNAL:DEBIT': '100',
      'AVAILABLE:CREDIT': '97',
      'FEE:CREDIT': '2',
      'NETWORK_FEE:CREDIT': '1',
    });
    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '97')).toBe(true);
    expect(eq(s.feeLedger, '2')).toBe(true);
    expect(eq(s.networkFeeLedger, '1')).toBe(true);

    // A completed event is pushed to the CRM dispatcher with the fee breakdown
    // (literal values: the fake records the very object ingest returns, so
    // comparing the two would compare a value with itself). The BODY the real
    // dispatcher builds from it is pinned by crm-dispatch.service.spec.ts.
    const crm = h.crm.events.filter((e) => e.kind === 'transaction').pop()!;
    expect(crm.event).toBe('transaction.completed');
    expect(eq(String(crm.payload.commissionAmount), '2')).toBe(true);
    expect(eq(String(crm.payload.networkFeeAmount), '1')).toBe(true);
    expect(eq(String(crm.payload.netAmount), '97')).toBe(true);
  });

  it('ON_TOP: both fees on top of the deposit, the company is credited the full amount', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2', 'ON_TOP');

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.netAmount, '100')).toBe(true);
    expectLegs(await legsFor(h, companyId, { transactionId: txn.id }), {
      'EXTERNAL:DEBIT': '103',
      'AVAILABLE:CREDIT': '100',
      'FEE:CREDIT': '2',
      'NETWORK_FEE:CREDIT': '1',
    });
    await expectConsistent(h, companyId);
  });

  it('a network fee larger than what the commission leaves is bounded — the deposit still books', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'FIXED', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '0.10');

    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '0.50'),
    );
    expect(txn.status).toBe('COMPLETED');
    expect(eq(txn.commissionAmount, '0.10')).toBe(true); // the commission is untouched
    expect(eq(txn.networkFeeAmount, '0.40')).toBe(true); // bounded to what was left
    expect(eq(txn.netAmount, '0')).toBe(true);
    expectLegs(await legsFor(h, companyId, { transactionId: txn.id }), {
      'EXTERNAL:DEBIT': '0.50',
      'FEE:CREDIT': '0.10',
      'NETWORK_FEE:CREDIT': '0.40',
    });
    // Configured pricing meeting a tiny deposit is NOT a pricing gap.
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: txn.id } }),
    );
    expect(row.pricingIssue).toBeNull();
    await expectConsistent(h, companyId);
  });

  it('an unpriced deposit keeps the existing behaviour: the whole amount withheld, no network fee', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    // No TRANSACTION commission rule at all.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '50'),
    );
    expect(eq(txn.commissionAmount, '50')).toBe(true);
    expect(eq(txn.networkFeeAmount, '0')).toBe(true);
    expectLegs(await legsFor(h, companyId, { transactionId: txn.id }), {
      'EXTERNAL:DEBIT': '50',
      'FEE:CREDIT': '50',
    });
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: txn.id } }),
    );
    expect(row.pricingIssue).toBe('unpriced');
  });

  it('a commission-capped deposit keeps the existing behaviour: no network fee', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '5'); // > the 3.00 deposit
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '3'),
    );
    expect(eq(txn.commissionAmount, '3')).toBe(true);
    expect(eq(txn.networkFeeAmount, '0')).toBe(true);
    const row = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: txn.id } }),
    );
    expect(row.pricingIssue).toBe('capped');
    await expectConsistent(h, companyId);
  });

  it('a Whish Pay settlement carries the network fee too (same ingest path)', async () => {
    await h.prisma.runAsAdmin(async (tx) => {
      if (!(await tx.source.findUnique({ where: { code: 'whish' } }))) {
        await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
      }
    });
    const { companyId } = await createCompany(h);
    await addFlowFee(h, companyId, 'TRANSACTION', '0');
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '2' }],
    });
    const p = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.create({
        data: {
          companyId,
          callbackToken: `it-nf-${Date.now().toString(36)}`,
          amount: '50.00',
          currency: USD,
          invoice: 'inv-network-fee',
          status: WhishPaymentStatus.PENDING,
        },
        select: { id: true },
      }),
    );
    h.whishClient.status = 'success';
    const res = await h.whish.refreshStatus(companyId, p.id);
    expect(res.status).toBe('PAID');

    const txn = await h.transactions.getById(res.transactionId!, companyId);
    expect(eq(txn.networkFeeAmount, '1')).toBe(true); // 2% of 50
    expect(eq(txn.netAmount, '49')).toBe(true);
    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '49')).toBe(true);
  });

  it('a replay returns the frozen row — a rate change in between reprices nothing', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFlowFee(h, companyId, 'TRANSACTION', '0');
    const input = ingestInput(companyId, '100');
    const first = await h.transactions.ingest({ kind: 'source', sourceId }, input);
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '5' }],
    });
    const replay = await h.transactions.ingest({ kind: 'source', sourceId }, input);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(eq(replay.networkFeeAmount, '1')).toBe(true);
    const s = await expectConsistent(h, companyId);
    expect(eq(s.networkFeeLedger, '1')).toBe(true); // booked once
  });
});

describe('network fee — reversal', () => {
  it('refunds both fees and claws back exactly the net', async () => {
    const { companyId, userId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );

    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    expectLegs(await legsFor(h, companyId, { transactionId: txn.id }), {
      'EXTERNAL:DEBIT': '100',
      'EXTERNAL:CREDIT': '100',
      'AVAILABLE:CREDIT': '97',
      'AVAILABLE:DEBIT': '97',
      'FEE:CREDIT': '2',
      'FEE:DEBIT': '2',
      'NETWORK_FEE:CREDIT': '1',
      'NETWORK_FEE:DEBIT': '1',
    });
    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '0')).toBe(true);
    expect(eq(s.networkFeeLedger, '0')).toBe(true);
    expect(eq(s.receivableLedger, '0')).toBe(true);
  });

  it('books the uncovered part of the net as a receivable when the money was already spent', async () => {
    const { companyId, userId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFixedFlowFee(h, companyId, 'TRANSACTION', '2');
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    // Spend 50 of the 97 (fee-free withdrawal), leaving 47.
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('50'));
    await h.withdrawals.approve(w.id, userId, { externalReference: 'paid-1' });

    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '0')).toBe(true);
    expect(eq(s.receivableLedger, '50')).toBe(true); // 97 net − 47 covered
    expect(eq(s.networkFeeLedger, '0')).toBe(true); // refunded
  });
});

describe('network fee — withdrawals', () => {
  async function withdrawalCompany(network: { feeType: 'FIXED' | 'PERCENTAGE'; feeValue: string }) {
    const co = await createCompany(h);
    await fund(co.companyId, '1000');
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', ...network }],
    });
    return co;
  }

  it('ON_TOP: wallet charged 103, recipient gets the full 100', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'PERCENTAGE', feeValue: '1' });
    await addFixedFlowFee(h, companyId, 'WITHDRAWAL', '2', 'ON_TOP');

    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
    expect(w.feeApplication).toBe('ON_TOP');
    expect(eq(w.feeAmount, '2')).toBe(true);
    expect(eq(w.networkFeeAmount, '1')).toBe(true);
    expect(eq(w.netAmount, '100')).toBe(true);
    expect(eq(w.totalAmount, '103')).toBe(true);
    let s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.reserved, '103')).toBe(true);

    const done = await h.withdrawals.approve(w.id, userId, { externalReference: 'paid-1' });
    expect(eq(done.networkFeeAmount, '1')).toBe(true);
    expectLegs(await legsFor(h, companyId, { withdrawalId: w.id }), {
      'AVAILABLE:DEBIT': '103',
      'RESERVED:CREDIT': '103',
      'RESERVED:DEBIT': '103',
      'EXTERNAL:CREDIT': '100',
      'FEE:CREDIT': '2',
      'NETWORK_FEE:CREDIT': '1',
    });
    s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '897')).toBe(true);
    expect(eq(s.wallet!.reserved, '0')).toBe(true);
  });

  it('whole-dollar auto settlement: the cents stay on FEE, the network fee on NETWORK_FEE', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'PERCENTAGE', feeValue: '1' });
    await addFlowFee(h, companyId, 'WITHDRAWAL', '6.65'); // DEDUCTED
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('20'));
    expect(eq(w.feeAmount, '1.33')).toBe(true);
    expect(eq(w.networkFeeAmount, '0.20')).toBe(true);
    expect(eq(w.netAmount, '18.47')).toBe(true);

    const done = await h.withdrawals.approve(
      w.id,
      userId,
      { externalReference: 'w2w-1' },
      { floorWhole: true },
    );
    expect(eq(done.roundingRemainder, '0.47')).toBe(true);
    expectLegs(await legsFor(h, companyId, { withdrawalId: w.id }), {
      'AVAILABLE:DEBIT': '20',
      'RESERVED:CREDIT': '20',
      'RESERVED:DEBIT': '20',
      'EXTERNAL:CREDIT': '18',
      'FEE:CREDIT': '1.80', // 1.33 commission + 0.47 remainder
      'NETWORK_FEE:CREDIT': '0.20',
    });
    await expectConsistent(h, companyId);
  });

  it('completing a stuck PROCESSING row books the frozen network fee', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'FIXED', feeValue: '0.50' });
    await addFlowFee(h, companyId, 'WITHDRAWAL', '1');
    const w = await h.withdrawals.request(companyId, userId, wishWithdrawalInput('50.40'));
    expect(await h.withdrawals.claimForProcessing(w.id, companyId)).toBe(true);
    const done = await h.withdrawals.resolveProcessing(w.id, userId, {
      action: 'complete',
      externalReference: 'ext-1',
    });
    expect(done.status).toBe('COMPLETED');
    // net = 50.40 − 0.50 − 0.50 = 49.40 → 49 sent, 0.40 remainder on FEE.
    expectLegs(await legsFor(h, companyId, { withdrawalId: w.id }), {
      'AVAILABLE:DEBIT': '50.40',
      'RESERVED:CREDIT': '50.40',
      'RESERVED:DEBIT': '50.40',
      'EXTERNAL:CREDIT': '49',
      'FEE:CREDIT': '0.90',
      'NETWORK_FEE:CREDIT': '0.50',
    });
    await expectConsistent(h, companyId);
  });

  it('reject and cancel return the full reserved total, network fee included', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'PERCENTAGE', feeValue: '1' });
    await addFixedFlowFee(h, companyId, 'WITHDRAWAL', '2', 'ON_TOP');

    const a = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
    await h.withdrawals.reject(a.id, userId, { notes: 'no' });
    const b = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
    await h.withdrawals.cancel(b.id, companyId, userId, {});

    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '1000')).toBe(true); // fully restored
    expect(eq(s.wallet!.reserved, '0')).toBe(true);
    expect(eq(s.networkFeeLedger, '0')).toBe(true); // nothing realized
  });

  it('no commission rule: a withdrawal network fee is charged ON_TOP (recipient still gets the amount)', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'FIXED', feeValue: '1' });
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('50'));
    expect(w.feeApplication).toBe('ON_TOP');
    expect(eq(w.feeAmount, '0')).toBe(true);
    expect(eq(w.netAmount, '50')).toBe(true);
    expect(eq(w.totalAmount, '51')).toBe(true);
  });

  it('DEDUCTED fees that consume the whole amount are refused before anything is reserved', async () => {
    const { companyId, userId } = await withdrawalCompany({ feeType: 'FIXED', feeValue: '5' });
    await addFixedFlowFee(h, companyId, 'WITHDRAWAL', '5');
    await expect(
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('10')),
    ).rejects.toThrow(/network fee consume the entire amount/);
    const s = await expectConsistent(h, companyId);
    expect(eq(s.wallet!.available, '1000')).toBe(true);
  });

  describe('a pending request keeps the fees frozen at request time', () => {
    it('switch turned OFF while pending: the frozen network fee is still realized', async () => {
      const { companyId, userId } = await withdrawalCompany({ feeType: 'FIXED', feeValue: '1' });
      await addFixedFlowFee(h, companyId, 'WITHDRAWAL', '2', 'ON_TOP');
      const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
      await setNetworkFee(h, companyId, { enabled: false, rates: [] });
      await h.withdrawals.approve(w.id, userId, { externalReference: 'paid' });
      const legs = await legsFor(h, companyId, { withdrawalId: w.id });
      expect(eq(legs['NETWORK_FEE:CREDIT'], '1')).toBe(true);
      expect(eq(legs['RESERVED:DEBIT'], '103')).toBe(true);
      await expectConsistent(h, companyId);
    });

    it('switch turned ON while pending: no network fee appears at approval', async () => {
      const co = await createCompany(h);
      await fund(co.companyId, '1000');
      const w = await h.withdrawals.request(co.companyId, co.userId, cashWithdrawalInput('100'));
      await setNetworkFee(h, co.companyId, {
        enabled: true,
        rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' }],
      });
      const done = await h.withdrawals.approve(w.id, co.userId, { externalReference: 'paid' });
      expect(eq(done.networkFeeAmount, '0')).toBe(true);
      const legs = await legsFor(h, co.companyId, { withdrawalId: w.id });
      expect(legs['NETWORK_FEE:CREDIT']).toBeUndefined();
      await expectConsistent(h, co.companyId);
    });

    it('rate changed while pending: approval uses the rate it was requested at', async () => {
      const { companyId, userId } = await withdrawalCompany({
        feeType: 'PERCENTAGE',
        feeValue: '1',
      });
      await addFixedFlowFee(h, companyId, 'WITHDRAWAL', '2', 'ON_TOP');
      const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
      await setNetworkFee(h, companyId, {
        enabled: true,
        rates: [{ operationType: 'WITHDRAWAL', feeType: 'PERCENTAGE', feeValue: '5' }],
      });
      await h.withdrawals.approve(w.id, userId, { externalReference: 'paid' });
      const legs = await legsFor(h, companyId, { withdrawalId: w.id });
      expect(eq(legs['NETWORK_FEE:CREDIT'], '1')).toBe(true);
      await expectConsistent(h, companyId);
    });
  });
});

describe('network fee — payouts', () => {
  it.each([
    ['DEDUCTED', '10', '8.50', '10'],
    ['ON_TOP', '11.50', '10', '11.50'],
  ] as const)('%s: reserves %s, pays %s, settles balanced', async (app, reserved, net, total) => {
    const co = await createCompany(h);
    await fund(co.companyId, '100');
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [{ operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '0.50' }],
    });
    await addFixedFlowFee(h, co.companyId, 'PAYOUT', '1', app);

    const p = await h.payouts.request(co.companyId, co.userId, payoutInput('10'));
    expect(eq(p.networkFeeAmount, '0.50')).toBe(true);
    expect(eq(p.netAmount, net)).toBe(true);
    expect(eq(p.totalAmount, total)).toBe(true);
    await h.payouts.approve(p.id, co.userId, { externalReference: 'paid' });
    expectLegs(await legsFor(h, co.companyId, { payoutId: p.id }), {
      'AVAILABLE:DEBIT': reserved,
      'RESERVED:CREDIT': reserved,
      'RESERVED:DEBIT': reserved,
      'EXTERNAL:CREDIT': net,
      'FEE:CREDIT': '1',
      'NETWORK_FEE:CREDIT': '0.50',
    });
    await expectConsistent(h, co.companyId);
  });

  it('reject returns the reserved total, network fee included', async () => {
    const co = await createCompany(h);
    await fund(co.companyId, '100');
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [{ operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '0.50' }],
    });
    await addFixedFlowFee(h, co.companyId, 'PAYOUT', '1', 'ON_TOP');
    const p = await h.payouts.request(co.companyId, co.userId, payoutInput('10'));
    await h.payouts.reject(p.id, co.userId, {});
    const s = await expectConsistent(h, co.companyId);
    expect(eq(s.wallet!.available, '100')).toBe(true);
    expect(eq(s.wallet!.reserved, '0')).toBe(true);
  });
});

describe('network fee — loads', () => {
  it('settles an outstanding receivable first, then credits the rest net of both fees', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addFlowFee(h, companyId, 'TRANSACTION', '10');
    // Deposit 100 → 90 available; spend it all; reverse the deposit → owes 90.
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('90'));
    await h.withdrawals.approve(w.id, userId, { externalReference: 'paid' });
    await h.transactions.reverse(txn.id, { actorId: userId, reason: 'chargeback' });
    expect(eq((await snapshot(h, companyId)).receivableLedger, '90')).toBe(true);

    // 1% LOAD network fee, no LOAD commission rule.
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [{ operationType: 'LOAD', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const l = await h.loads.request(companyId, userId, loadInput('100'));
    expect(l.feeApplication).toBe('DEDUCTED');
    expect(eq(l.networkFeeAmount, '1')).toBe(true);
    expect(eq(l.netAmount, '99')).toBe(true);
    await h.loads.approve(l.id, userId, { externalReference: 'cash-1' });

    expectLegs(await legsFor(h, companyId, { loadId: l.id }), {
      'EXTERNAL:DEBIT': '100',
      'RECEIVABLE:CREDIT': '90',
      'AVAILABLE:CREDIT': '9',
      'NETWORK_FEE:CREDIT': '1',
    });
    const s = await expectConsistent(h, companyId);
    expect(eq(s.receivableLedger, '0')).toBe(true);
    expect(eq(s.wallet!.available, '9')).toBe(true);
  });

  it('refuses a load whose fees consume the whole amount', async () => {
    const co = await createCompany(h);
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [{ operationType: 'LOAD', feeType: 'FIXED', feeValue: '5' }],
    });
    await addFixedFlowFee(h, co.companyId, 'LOAD', '5');
    await expect(h.loads.request(co.companyId, co.userId, loadInput('10'))).rejects.toThrow(
      /nothing would be credited/,
    );
  });

  it('the admin direct load charges the LOAD network fee, like the commission', async () => {
    const co = await createCompany(h);
    await setNetworkFee(h, co.companyId, {
      enabled: true,
      rates: [{ operationType: 'LOAD', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    const done = await h.loads.adminLoad(co.companyId, co.userId, {
      companyId: co.companyId,
      amount: '100',
      currency: USD,
      payout: {
        method: 'CASH',
        recipientName: 'Ops',
        recipientPhone: '+9610000000',
        pickupLocation: 'HQ',
      },
    });
    expect(done.status).toBe('COMPLETED');
    expect(eq(done.networkFeeAmount, '1')).toBe(true);
    const s = await expectConsistent(h, co.companyId);
    expect(eq(s.wallet!.available, '99')).toBe(true);
    expect(eq(s.networkFeeLedger, '1')).toBe(true);
  });
});

describe('network fee — configuration', () => {
  it('a tenant can read its own rates but never another company’s, and can never write them', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    await setNetworkFee(h, a.companyId, {
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });

    // Company A's own scope sees its row.
    const own = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.companyNetworkFee.findMany({ where: { companyId: a.companyId } }),
    );
    expect(own).toHaveLength(1);
    // Company B's scope cannot see A's.
    const leaked = await h.prisma.runAsTenant(b.companyId, (tx) =>
      tx.companyNetworkFee.findMany({ where: { companyId: a.companyId } }),
    );
    expect(leaked).toHaveLength(0);

    // A tenant-scoped connection cannot change its own pricing.
    await expect(
      h.prisma.runAsTenant(a.companyId, (tx) =>
        tx.companyNetworkFee.create({
          data: { companyId: a.companyId, operationType: 'LOAD', feeType: 'FIXED', feeValue: '1' },
        }),
      ),
    ).rejects.toThrow();
    const updated = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.companyNetworkFee.updateMany({
        where: { companyId: a.companyId },
        data: { feeValue: '9' },
      }),
    );
    expect(updated.count).toBe(0);
    const deleted = await h.prisma.runAsTenant(a.companyId, (tx) =>
      tx.companyNetworkFee.deleteMany({ where: { companyId: a.companyId } }),
    );
    expect(deleted.count).toBe(0);
    expect(await h.companies.getNetworkFee(a.companyId)).toEqual({
      enabled: true,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
  });

  it('switching OFF keeps the rates, and a disabled company pays no network fee', async () => {
    const { companyId, sourceId } = await depositCompany({
      network: { feeType: 'PERCENTAGE', feeValue: '1' },
    });
    await addFlowFee(h, companyId, 'TRANSACTION', '0');
    await setNetworkFee(h, companyId, {
      enabled: false,
      rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
    });
    expect((await h.companies.getNetworkFee(companyId)).rates).toHaveLength(1);
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    expect(eq(txn.networkFeeAmount, '0')).toBe(true);
    expect(eq(txn.netAmount, '100')).toBe(true);
  });

  it('the company detail resource carries the configuration', async () => {
    const { companyId } = await createCompany(h);
    expect((await h.companies.getById(companyId)).networkFee).toEqual({
      enabled: false,
      rates: [],
    });
    await setNetworkFee(h, companyId, {
      enabled: true,
      rates: [
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '2.00' },
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '0.125' },
      ],
    });
    expect((await h.companies.getById(companyId)).networkFee).toEqual({
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '0.125' },
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '2' },
      ],
    });
  });
});
