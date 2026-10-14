import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
import { WhishError, WhishIndeterminateError } from '../../src/modules/whish/whish.client';
import {
  ADMIN_ACTOR,
  addTransactionFee,
  buildHarness,
  createCompany,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * Refunding a PAID Whish payment to its payer, end-to-end against the real DB +
 * ledger (Whish itself is the controllable fake).
 *
 * A refund moves REAL money out of the platform's Whish account, so the two
 * failure modes that matter are opposite and both expensive:
 *   - booking a refund Whish never made claws money from a company for nothing;
 *   - NOT booking one Whish did make leaves the company holding a credit for
 *     money the payer already got back — and a "retry" would pay them twice.
 * So Whish is asked at most once per request, and the ledger moves only once
 * Whish confirms (its `status:true`, or a status check reading `refunded`).
 */

let tok = 0;
const callbackToken = () => `it-refund-${Date.now().toString(36)}-${tok++}`;

async function provisionWhishSource(h: Harness): Promise<void> {
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
}

const readRow = (h: Harness, id: string) =>
  h.prisma.runAsAdmin((tx) => tx.whishPayment.findUniqueOrThrow({ where: { id } }));

const readTx = (h: Harness, transactionId: string) =>
  h.prisma.runAsAdmin((tx) =>
    tx.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      select: { status: true, refundedAt: true },
    }),
  );

const readTxStatus = async (h: Harness, transactionId: string) =>
  (
    await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: transactionId }, select: { status: true } }),
    )
  ).status;

/**
 * A company with a 2% deposit fee and one settled 50.00 Whish payment: the
 * wallet holds 49.00 and the platform 1.00 of fee.
 */
async function paidPayment(h: Harness): Promise<{ companyId: string; id: string; txId: string }> {
  const { companyId } = await createCompany(h);
  await addTransactionFee(h, companyId, '2');
  const { id } = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: callbackToken(),
        amount: '50.00',
        currency: USD,
        invoice: 'inv-refund',
        status: WhishPaymentStatus.PENDING,
      },
      select: { id: true },
    }),
  );
  h.whishClient.status = 'success';
  const settled = await h.whish.refreshStatus(companyId, id);
  expect(settled.status).toBe('PAID');
  const snap = await snapshot(h, companyId);
  expect(Number(snap.wallet?.available)).toBe(49);
  expect(Number(snap.feeLedger)).toBe(1);
  h.crm.reset();
  return { companyId, id, txId: settled.transactionId! };
}

const refund = (h: Harness, id: string, reason = 'Customer cancelled the order') =>
  h.whish.refundPayment(id, { actorId: ADMIN_ACTOR, reason });

describe('Whish refund — admin refunds a paid payment to the payer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });
  beforeEach(() => {
    h.crm.reset();
    h.whishClient.status = 'success';
    h.whishClient.statusFor.clear();
    h.whishClient.refundCalls = [];
    h.whishClient.failRefundWith = null;
    h.whishClient.refundTookEffect = false;
    h.whishClient.failGetStatusWith = null;
    h.whishClient.balance = 1000;
    h.whishClient.amountFor.clear();
    h.txLogs.length = 0;
    vi.restoreAllMocks();
  });

  // Whish charges the platform a collection fee on every Whish Pay deposit. The
  // log records what each refund actually took out of the platform's Whish
  // account, so the first real refund shows whether Whish gives that fee back.
  it('logs what the refund took out of the platform Whish account', async () => {
    const { id } = await paidPayment(h);
    h.whishClient.amountFor.set((await readRow(h, id)).externalId.toString(), 50);

    await refund(h, id);

    const log = h.txLogs.find((l) => l.kind === 'WHISH_REFUND');
    expect(log?.success).toBe(true);
    expect(log?.response).toMatchObject({
      status: true,
      platformBalance: { before: '1000.00', after: '950.00', change: '-50.00' },
    });
  });

  it('shows a refund where Whish returns its fee — less than the amount leaves the account', async () => {
    const { id } = await paidPayment(h);
    h.whishClient.amountFor.set((await readRow(h, id)).externalId.toString(), 50);
    h.whishClient.refundDebit = (amount) => amount * 0.99; // Whish gives its 1% back

    await refund(h, id);

    expect(h.txLogs.find((l) => l.kind === 'WHISH_REFUND')?.response).toMatchObject({
      platformBalance: { change: '-49.50' },
    });
    h.whishClient.refundDebit = (amount) => amount;
  });

  it('a balance that cannot be read never blocks the refund', async () => {
    const { id } = await paidPayment(h);
    vi.spyOn(h.whishClient, 'getBalance').mockRejectedValue(new Error('balance unavailable'));

    expect((await refund(h, id)).status).toBe('REFUNDED');
    expect(h.txLogs.find((l) => l.kind === 'WHISH_REFUND')?.response).toMatchObject({
      status: true,
      platformBalance: { before: null, after: null, change: null },
    });
  });

  it('refunds through Whish, reverses the deposit and tells the CRM once', async () => {
    const { companyId, id, txId } = await paidPayment(h);

    const res = await refund(h, id);

    expect(res.status).toBe('REFUNDED');
    expect(res.refundedAt).toBeTruthy();
    expect(res.needsAttention).toBe(false);
    // Whish was asked exactly once, with the documented body.
    expect(h.whishClient.refundCalls).toEqual([
      {
        currency: 'USD',
        externalId: res.externalId,
        refundReason: 'Customer cancelled the order',
      },
    ]);
    // The deposit is reversed: net back out of the wallet, the fee returned.
    expect(await readTxStatus(h, txId)).toBe('REVERSED');
    const snap = await snapshot(h, companyId);
    expect(Number(snap.wallet?.available)).toBe(0);
    expect(Number(snap.feeLedger)).toBe(0);
    expect(snap.balanced).toBe(true);
    // The CRM already handles transaction.reversed — no new event type — and
    // the event itself says the customer was refunded, and when: the deposit
    // records it in the same database transaction as the reversal.
    expect(h.crm.names()).toEqual(['transaction.reversed']);
    expect(h.crm.events[0]!.payload).toMatchObject({
      status: 'REVERSED',
      refunded: true,
      refundedAt: res.refundedAt,
    });
    expect((await readTx(h, txId)).refundedAt?.toISOString()).toBe(res.refundedAt);
    // …and so does the deposit read through the API.
    const viaApi = await h.transactions.getById(txId, companyId);
    expect(viaApi).toMatchObject({
      status: 'REVERSED',
      refunded: true,
      refundedAt: res.refundedAt,
    });
    // The reason is kept on the payment for the operator trail.
    expect((await readRow(h, id)).metadata).toMatchObject({
      refundReason: 'Customer cancelled the order',
      refundRequestedBy: ADMIN_ACTOR,
    });
  });

  it('is idempotent: refunding a REFUNDED payment sends nothing and books nothing', async () => {
    const { companyId, id } = await paidPayment(h);
    await refund(h, id);
    h.crm.reset();

    const again = await refund(h, id);

    expect(again.status).toBe('REFUNDED');
    expect(h.whishClient.refundCalls).toHaveLength(1);
    expect(h.crm.names()).toEqual([]);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
  });

  it('a double click sends ONE refund to Whish and claws back once', async () => {
    const { companyId, id } = await paidPayment(h);

    const results = await Promise.allSettled([refund(h, id), refund(h, id)]);

    expect(h.whishClient.refundCalls).toHaveLength(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'CONFLICT' });
    }
    expect((await readRow(h, id)).status).toBe('REFUNDED');
    expect(h.crm.names()).toEqual(['transaction.reversed']);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
  });

  it('a refusal Whish confirms releases the request, books nothing, and can be retried', async () => {
    const { companyId, id } = await paidPayment(h);
    h.whishClient.failRefundWith = new WhishError('This payment cannot be refunded');

    await expect(refund(h, id)).rejects.toThrow('This payment cannot be refunded');

    const row = await readRow(h, id);
    expect(row.status).toBe('PAID');
    expect(row.refundRequestedAt).toBeNull();
    expect((row.metadata as Record<string, unknown> | null)?.needsAttention).toBeUndefined();
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(49);
    expect(h.crm.names()).toEqual([]);

    // Fixed upstream → the operator simply presses Refund again.
    h.whishClient.failRefundWith = null;
    expect((await refund(h, id)).status).toBe('REFUNDED');
    expect(h.whishClient.refundCalls).toHaveLength(2);
  });

  it('an unknown outcome keeps the request, flags it, books nothing — and refuses a second refund', async () => {
    const { companyId, id } = await paidPayment(h);
    h.whishClient.failRefundWith = new WhishIndeterminateError('service unavailable');

    await expect(refund(h, id)).rejects.toMatchObject({ code: 'WHISH_PENDING' });

    const row = await readRow(h, id);
    expect(row.status).toBe('PAID');
    expect(row.refundRequestedAt).not.toBeNull();
    const flagged = await h.whish.adminGetById(id);
    expect(flagged.needsAttention).toBe(true);
    expect(flagged.settlementError).toMatch(/not confirmed/i);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(49);

    // The refund may still go through at Whish — sending another on a guess
    // could pay the customer twice.
    h.whishClient.failRefundWith = null;
    await expect(refund(h, id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.whishClient.refundCalls).toHaveLength(1);
  });

  it('Refresh books an unconfirmed refund once Whish reports it refunded', async () => {
    const { companyId, id, txId } = await paidPayment(h);
    h.whishClient.failRefundWith = new WhishIndeterminateError('timeout');
    await expect(refund(h, id)).rejects.toMatchObject({ code: 'WHISH_PENDING' });

    // Whish processed it after all.
    const row = await readRow(h, id);
    h.whishClient.statusFor.set(row.externalId.toString(), 'refunded');
    const res = await h.whish.adminRefreshStatus(id, ADMIN_ACTOR);

    expect(res.status).toBe('REFUNDED');
    expect(res.needsAttention).toBe(false);
    expect(res.settlementError).toBeNull();
    expect(await readTxStatus(h, txId)).toBe('REVERSED');
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
    expect(h.whishClient.refundCalls).toHaveLength(1);
  });

  it('Refresh releases an unconfirmed refund Whish never made, once it is no longer in flight', async () => {
    const { companyId, id } = await paidPayment(h);
    h.whishClient.failRefundWith = new WhishIndeterminateError('timeout');
    await expect(refund(h, id)).rejects.toMatchObject({ code: 'WHISH_PENDING' });

    // Straight away: it could still be in flight, so nothing is released.
    let res = await h.whish.adminRefreshStatus(id, ADMIN_ACTOR);
    expect(res.status).toBe('PAID');
    expect((await readRow(h, id)).refundRequestedAt).not.toBeNull();

    // Minutes later Whish still reports it paid → it did not refund.
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id },
        data: { refundRequestedAt: new Date(Date.now() - 10 * 60_000) },
      }),
    );
    res = await h.whish.adminRefreshStatus(id, ADMIN_ACTOR);

    expect(res.status).toBe('PAID');
    expect(res.needsAttention).toBe(false);
    expect(res.settlementError).toBeNull();
    expect((await readRow(h, id)).refundRequestedAt).toBeNull();
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(49);

    // …and the operator can refund it again.
    h.whishClient.failRefundWith = null;
    expect((await refund(h, id)).status).toBe('REFUNDED');
  });

  it('books straight away when Whish lost its reply but did refund', async () => {
    const { companyId, id } = await paidPayment(h);
    h.whishClient.failRefundWith = new WhishIndeterminateError('timeout');
    h.whishClient.refundTookEffect = true;

    const res = await refund(h, id);

    expect(res.status).toBe('REFUNDED');
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
    expect(h.crm.names()).toEqual(['transaction.reversed']);
  });

  it("records a refund made in Whish's portal without asking Whish to pay again", async () => {
    const { companyId, id } = await paidPayment(h);
    const row = await readRow(h, id);
    h.whishClient.statusFor.set(row.externalId.toString(), 'refunded');

    // Refresh only flags it — booking is the operator's decision…
    const flagged = await h.whish.adminRefreshStatus(id, ADMIN_ACTOR);
    expect(flagged.status).toBe('PAID');
    expect(flagged.needsAttention).toBe(true);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(49);

    // …which Refund records, with NO second refund sent.
    const res = await refund(h, id);

    expect(res.status).toBe('REFUNDED');
    expect(res.needsAttention).toBe(false);
    expect(h.whishClient.refundCalls).toHaveLength(0);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
    // The breadcrumb survives so the history still says where it came from.
    expect((await readRow(h, id)).metadata).toMatchObject({ refundedAfterSettlement: true });
  });

  it('never claws back twice when the deposit was already reversed', async () => {
    const { companyId, id, txId } = await paidPayment(h);
    await h.transactions.reverse(txId, { actorId: ADMIN_ACTOR, reason: 'operator reversal' });
    h.crm.reset();
    const before = await snapshot(h, companyId);

    const res = await refund(h, id);

    expect(res.status).toBe('REFUNDED');
    expect(h.whishClient.refundCalls).toHaveLength(1);
    const after = await snapshot(h, companyId);
    expect(Number(after.wallet?.available)).toBe(Number(before.wallet?.available));
    expect(after.totalDebit).toBe(before.totalDebit);
    // No money moves again — but the refund is new: the deposit records it, and
    // the CRM, which only heard "reversed", is told once that the customer was
    // refunded (same event and reference, a later sentAt).
    expect((await readTx(h, txId)).refundedAt?.toISOString()).toBe(res.refundedAt);
    expect(h.crm.names()).toEqual(['transaction.reversed']);
    expect(h.crm.events[0]!.payload).toMatchObject({ refunded: true, refundedAt: res.refundedAt });
  });

  it('a refund Whish made but we failed to book keeps the request and is booked by Refresh', async () => {
    const { companyId, id } = await paidPayment(h);
    vi.spyOn(h.transactions, 'reverse').mockRejectedValueOnce(new Error('connection reset'));

    await expect(refund(h, id)).rejects.toThrow('connection reset');

    const stuck = await h.whish.adminGetById(id);
    expect(stuck.status).toBe('PAID');
    expect(stuck.needsAttention).toBe(true);
    expect(stuck.settlementError).toMatch(/booking the refund failed/i);
    // The request is kept, so nothing can send Whish a second refund.
    await expect(refund(h, id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.whishClient.refundCalls).toHaveLength(1);

    const res = await h.whish.adminRefreshStatus(id, ADMIN_ACTOR);

    expect(res.status).toBe('REFUNDED');
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(0);
  });

  it('refuses a payment that is not paid, without calling Whish', async () => {
    const { companyId } = await createCompany(h);
    const { id } = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.create({
        data: {
          companyId,
          callbackToken: callbackToken(),
          amount: '50.00',
          currency: USD,
          invoice: 'inv-unpaid',
          status: WhishPaymentStatus.PENDING,
        },
        select: { id: true },
      }),
    );

    await expect(refund(h, id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.whishClient.refundCalls).toHaveLength(0);
    expect(h.whishClient.getStatusCalls).not.toContain(
      (await readRow(h, id)).externalId.toString(),
    );
  });

  it('releases the request when Whish cannot be asked first — nothing was sent', async () => {
    const { id } = await paidPayment(h);
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');

    await expect(refund(h, id)).rejects.toThrow('Could not reach Whish');

    expect(h.whishClient.refundCalls).toHaveLength(0);
    expect((await readRow(h, id)).refundRequestedAt).toBeNull();
  });

  it('the admin deposit list says which Whish payment a deposit settled — the company list never does', async () => {
    const { companyId, id, txId } = await paidPayment(h);
    const query = { page: 1, pageSize: 20, companyId };

    const admin = await h.transactions.listForAdmin(query);
    expect(admin.data.find((t) => t.id === txId)?.whishPayment).toEqual({ id, status: 'PAID' });

    const company = await h.transactions.list({ companyId, query });
    expect(company.data.find((t) => t.id === txId)).not.toHaveProperty('whishPayment');

    // After a refund the row says so (the Deposits page shows REFUNDED, not just REVERSED).
    await refund(h, id);
    const after = await h.transactions.listForAdmin(query);
    const row = after.data.find((t) => t.id === txId);
    expect(row?.status).toBe('REVERSED');
    expect(row?.whishPayment).toEqual({ id, status: 'REFUNDED' });
  });

  it('a deposit that did not come from a Whish Pay payment carries no link (nothing to refund)', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const source = await h.prisma.runAsAdmin((tx) =>
      tx.source.findUniqueOrThrow({ where: { code: 'whish' } }),
    );
    const direct = await h.transactions.ingest(
      { kind: 'source', sourceId: source.id },
      {
        companyId,
        externalTransactionId: `direct-${Date.now()}`,
        amount: '10.00',
        currency: USD,
        payload: {},
      },
    );

    const admin = await h.transactions.listForAdmin({ page: 1, pageSize: 20, companyId });
    expect(admin.data.find((t) => t.id === direct.id)?.whishPayment).toBeNull();
  });

  it('the database refuses to move a REFUNDED payment to any other status', async () => {
    const { id } = await paidPayment(h);
    await refund(h, id);

    await expect(
      h.prisma.runAsAdmin((tx) =>
        tx.whishPayment.update({ where: { id }, data: { status: WhishPaymentStatus.PAID } }),
      ),
    ).rejects.toThrow(/terminal/i);
  });
});
