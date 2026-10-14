import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * Whish Pay v1.4.4 lifecycle, end-to-end against the real DB + ledger.
 *
 * Two upstream changes drive everything here, and both are money-safe
 * distinctions the old code could not express:
 *
 *  - `collectStatus` gained `refunded` (a SETTLED non-collection) and `unknown`
 *    (NOT settled — Whish could not determine the outcome). Treating `unknown`
 *    as terminal would close a link the customer can still pay; flagging it
 *    needsAttention would be worse, because the poller SKIPS flagged rows and
 *    the payment would never resolve at all.
 *
 *  - `status:false` + `code:"500"` on link creation means "pending, outcome
 *    unknown — do not mark it failed". The link may exist upstream, so the row
 *    must stay PENDING (the only status the reconciler polls) and the CRM must
 *    NOT be told the payment failed.
 */

let tok = 0;
const callbackToken = () => `it-v144-${Date.now().toString(36)}-${tok++}`;

async function provisionWhishSource(h: Harness): Promise<void> {
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
}

async function insertPayment(
  h: Harness,
  companyId: string,
  status: WhishPaymentStatus = WhishPaymentStatus.PENDING,
  createdAt?: Date,
): Promise<{ id: string }> {
  return h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: callbackToken(),
        amount: '50.00',
        currency: USD,
        invoice: 'inv-v144',
        status,
        ...(createdAt ? { createdAt } : {}),
      },
      select: { id: true },
    }),
  );
}

const readRow = (h: Harness, id: string) =>
  h.prisma.runAsAdmin((tx) => tx.whishPayment.findUniqueOrThrow({ where: { id } }));

describe('Whish v1.4.4 — collectStatus refunded / unknown', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });
  beforeEach(() => {
    h.crm.reset();
    h.whishClient.failGetStatusWith = null;
    h.whishClient.failPostPaymentWith = null;
  });

  it('closes a PENDING link as FAILED when Whish reports refunded, and tells the CRM once', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(h, companyId);
    h.whishClient.status = 'refunded';

    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('FAILED');
    // A refund is a settled NON-collection, not an operator problem.
    expect(res.needsAttention).toBe(false);
    expect(h.crm.names()).toEqual(['transaction.failed']);
    // The exact upstream status is kept so ops can tell a refund from a decline.
    expect((await readRow(h, p.id)).metadata).toMatchObject({ collectStatus: 'refunded' });
    // Nothing was ever booked.
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0);
  });

  it('is idempotent on a repeated refunded — one status change, one CRM event', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(h, companyId);
    h.whishClient.status = 'refunded';

    await h.whish.refreshStatus(companyId, p.id);
    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('FAILED');
    // The updateMany is guarded on status=PENDING, so the second pass matches 0
    // rows and must not re-emit.
    expect(h.crm.names()).toEqual(['transaction.failed']);
  });

  it('leaves a PENDING link untouched and un-flagged on unknown — it must stay pollable', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(h, companyId);
    h.whishClient.status = 'unknown';

    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('PENDING');
    // CRITICAL: needsAttention would make the 60s poller SKIP this row forever.
    expect(res.needsAttention).toBe(false);
    expect(h.crm.names()).toEqual([]);
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0);
  });

  it('settles normally when an earlier unknown is later resolved to success', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId);

    h.whishClient.status = 'unknown';
    expect((await h.whish.refreshStatus(companyId, p.id)).status).toBe('PENDING');

    h.whishClient.status = 'success';
    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('PAID');
    expect(res.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('the 24h timeout closes a link stuck on unknown, but FLAGS it for an operator', async () => {
    const { companyId } = await createCompany(h);
    // Older than UNKNOWN_EXPIRE_AGE_MS (24h): an 'unknown' link is asked about
    // for that long (see whish-poll-schedule), far past the unpaid-link cutoff.
    const p = await insertPayment(
      h,
      companyId,
      WhishPaymentStatus.PENDING,
      new Date(Date.now() - 25 * 3600_000),
    );
    h.whishClient.status = 'unknown';

    await h.whish.reconcileStalePayments();

    const row = await readRow(h, p.id);
    expect(row.status).toBe('FAILED');
    expect(h.crm.names()).toContain('transaction.failed');
    // Whish said it could not tell whether it collected — that is an operator
    // case, not an ordinary lapse, so it must not close silently.
    expect(row.metadata).toMatchObject({ needsAttention: true, closedFromUnknown: true });
  });

  it('the 10-minute cutoff closes an ordinary un-paid link quietly (no operator flag)', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(
      h,
      companyId,
      WhishPaymentStatus.PENDING,
      new Date(Date.now() - 11 * 60_000),
    );
    h.whishClient.status = 'pending'; // the customer simply never paid

    await h.whish.reconcileStalePayments();

    const row = await readRow(h, p.id);
    expect(row.status).toBe('FAILED');
    expect((row.metadata as { needsAttention?: boolean } | null)?.needsAttention).toBeUndefined();
  });

  it('keeps earlier metadata when closing a link (breadcrumbs are not overwritten)', async () => {
    const { companyId } = await createCompany(h);
    const p = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.create({
        data: {
          companyId,
          callbackToken: callbackToken(),
          amount: '50.00',
          currency: USD,
          invoice: 'inv-meta',
          status: WhishPaymentStatus.PENDING,
          metadata: { linkCreateIndeterminate: true, error: 'earlier blip' },
        },
        select: { id: true },
      }),
    );
    h.whishClient.status = 'failed';

    await h.whish.refreshStatus(companyId, p.id);

    expect((await readRow(h, p.id)).metadata).toMatchObject({
      linkCreateIndeterminate: true, // preserved
      error: 'earlier blip', // preserved
      collectStatus: 'failed', // added
    });
  });

  it('an admin refresh of a settled payment survives a Whish outage', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId);
    h.whishClient.status = 'success';
    await h.whish.refreshStatus(companyId, p.id);

    // Refreshing a PAID row used to be a guaranteed no-op; an upstream outage
    // must not turn it into a 502 for the operator.
    h.whishClient.failGetStatusWith = new WhishError('Could not reach Whish');
    const res = await h.whish.adminRefreshStatus(p.id, ADMIN_ACTOR);

    expect(res.status).toBe('PAID');
    expect(res.needsAttention).toBe(false);
  });

  it('does NOT expire a link when the upstream status is indeterminate', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(
      h,
      companyId,
      WhishPaymentStatus.PENDING,
      new Date(Date.now() - 25 * 3600_000),
    );
    // reconcile() throws before the timeout branch is reached — the invariant is
    // that the timeout lives INSIDE the try, after reconcile.
    h.whishClient.failGetStatusWith = new WhishIndeterminateError('upstream unknown');

    await h.whish.reconcileStalePayments();

    const row = await readRow(h, p.id);
    expect(row.status).toBe('PENDING'); // never failed on an upstream blip
    expect(h.crm.names()).toEqual([]);
  });

  it('flags an UNRECOGNIZED status for an operator instead of crediting', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(h, companyId);
    // A sixth, undocumented value. In production the client rejects it before
    // this point; this pins the service-level backstop.
    h.whishClient.status = 'partially_refunded' as never;

    const res = await h.whish.refreshStatus(companyId, p.id);

    expect(res.status).toBe('PENDING');
    expect(res.needsAttention).toBe(true);
    expect((await readRow(h, p.id)).metadata).toMatchObject({
      // Distinct from the recognised 'unknown' handled above.
      unrecognizedCollectStatus: 'partially_refunded',
    });
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0);
  });

  it('flags a refund that lands AFTER settlement, without touching the ledger', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId);
    h.whishClient.status = 'success';
    await h.whish.refreshStatus(companyId, p.id); // settles, credits 50

    h.whishClient.status = 'refunded';
    const res = await h.whish.adminRefreshStatus(p.id, ADMIN_ACTOR);

    // The row stays PAID and keeps its transaction — reversing the ledger is a
    // deliberate operator action, never an automatic side effect of a refresh.
    expect(res.status).toBe('PAID');
    expect(res.transactionId).toBeTruthy();
    expect(res.needsAttention).toBe(true);
    // needsAttention is shown to the company as "read settlementError" — it must
    // never be raised with a null reason.
    expect(res.settlementError).toBeTruthy();
    expect((await readRow(h, p.id)).metadata).toMatchObject({ refundedAfterSettlement: true });
    const snap = await snapshot(h, companyId);
    expect(Number(snap.wallet?.available)).toBe(50); // untouched
    expect(snap.balanced).toBe(true);
  });
});

describe('Whish v1.4.4 — indeterminate link creation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });
  beforeEach(() => {
    h.crm.reset();
    h.whishClient.postPaymentCalls = [];
    h.whishClient.failGetStatusWith = null;
    h.whishClient.failPostPaymentWith = null;
  });

  const create = (companyId: string, over: Record<string, unknown> = {}) =>
    h.whish.createPayment(companyId, {
      amount: '50.00',
      currency: USD,
      invoice: 'inv-create',
      ...over,
    } as never);

  it('leaves the row PENDING and tells the CRM "pending", not "failed"', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');

    await expect(create(companyId)).rejects.toMatchObject({ code: 'WHISH_PENDING' });

    const row = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findFirstOrThrow({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    );
    // PENDING is the ONLY status the reconciler polls — marking it FAILED here
    // would strand a link the customer may well be able to pay.
    expect(row.status).toBe('PENDING');
    expect(row.collectUrl).toBeNull();
    expect(row.metadata).toMatchObject({ linkCreateIndeterminate: true });
    expect(h.crm.names()).toEqual(['transaction.pending']);
  });

  it('still marks a DEFINITE upstream failure as FAILED (unchanged behaviour)', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.failPostPaymentWith = new WhishError('currency not supported');

    await expect(create(companyId)).rejects.toThrow(/currency not supported/);

    const row = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findFirstOrThrow({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    );
    expect(row.status).toBe('FAILED');
    expect(h.crm.names()).toEqual(['transaction.failed']);
  });

  it('the reconciler later settles a link orphaned by an indeterminate create', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');
    await expect(create(companyId)).rejects.toThrow();

    const row = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findFirstOrThrow({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    );
    // Age it past its first check; Whish did in fact mint the link.
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: row.id },
        data: {
          createdAt: new Date(Date.now() - 7 * 60_000),
          nextPollAt: new Date(Date.now() - 1),
        },
      }),
    );
    h.whishClient.failPostPaymentWith = null;
    h.whishClient.status = 'success';

    await h.whish.reconcileStalePayments();

    const settled = await readRow(h, row.id);
    expect(settled.status).toBe('PAID');
    expect(settled.transactionId).toBeTruthy();
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('closes an orphan Whish says it never minted, instead of polling it forever', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');
    await expect(create(companyId)).rejects.toThrow();
    h.whishClient.failPostPaymentWith = null;

    const row = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findFirstOrThrow({ where: { companyId }, orderBy: { createdAt: 'desc' } }),
    );
    await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.update({
        where: { id: row.id },
        data: {
          createdAt: new Date(Date.now() - 7 * 60_000),
          nextPollAt: new Date(Date.now() - 1),
        },
      }),
    );
    // Whish's definitive answer for an id it never created. Without special
    // handling this throws on every check, and because the cutoff sits
    // AFTER reconcile() the row would never expire either.
    h.whishClient.failGetStatusWith = new WhishError('unknown externalId', {
      code: 'external_id.not_exists',
    });

    await h.whish.reconcileStalePayments();

    const closed = await readRow(h, row.id);
    expect(closed.status).toBe('FAILED');
    expect(h.crm.names()).toContain('transaction.failed');
  });

  it('closes a link-less row our own failure left behind (no flag), instead of polling it forever', async () => {
    // The create failed on OUR side after the row was saved and before Whish was
    // called (the database was too busy): no indeterminate flag could be written.
    const { companyId } = await createCompany(h);
    // No collectUrl, no metadata — and due for its check.
    const p = await insertPayment(
      h,
      companyId,
      WhishPaymentStatus.PENDING,
      new Date(Date.now() - 6 * 60_000),
    );
    h.whishClient.failGetStatusWith = new WhishError('unknown externalId', {
      code: 'external_id.not_exists',
    });

    await h.whish.reconcileStalePayments();

    expect((await readRow(h, p.id)).status).toBe('FAILED');
    // The company was answered with an error and never given this reference:
    // its CRM is not sent an event about it.
    expect(h.crm.names()).toEqual([]);
  });

  it('a link-less row younger than a minute is not treated as an orphan (its create may be in flight)', async () => {
    const { companyId } = await createCompany(h);
    const p = await insertPayment(
      h,
      companyId,
      WhishPaymentStatus.PENDING,
      new Date(Date.now() - 5_000),
    );
    h.whishClient.failGetStatusWith = new WhishError('unknown externalId', {
      code: 'external_id.not_exists',
    });

    await expect(h.whish.refreshStatus(companyId, p.id)).rejects.toThrow();
    expect((await readRow(h, p.id)).status).toBe('PENDING');
  });

  it('does NOT close a row that HAS a link on the same error — that is an operator case', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const created = await create(companyId); // real link minted
    h.whishClient.failGetStatusWith = new WhishError('unknown externalId', {
      code: 'external_id.not_exists',
    });

    // Whish losing a link we know exists must surface, never silently close.
    await expect(h.whish.refreshStatus(companyId, created.id)).rejects.toThrow();
    expect((await readRow(h, created.id)).status).toBe('PENDING');
  });

  it('sends externalId to Whish as a digit STRING matching the row', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');

    const res = await create(companyId);

    const sent = h.whishClient.postPaymentCalls.at(-1)!;
    expect(typeof sent.externalId).toBe('string');
    expect(sent.externalId).toBe(res.externalId);
    // The callback/redirect URLs carry the same value.
    expect(sent.successCallbackUrl).toContain(`externalId=${res.externalId}`);
    expect(sent.successRedirectUrl).toContain(`ref=${res.externalId}`);
  });

  it('settles with a ledger reference equal to the row externalId', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const created = await create(companyId);
    h.whishClient.status = 'success';

    const res = await h.whish.refreshStatus(companyId, created.id);

    const txn = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: res.transactionId! } }),
    );
    // This is the settlement idempotency key — it must not drift when the wire
    // type changed from number to string.
    expect(txn.externalTransactionId).toBe(created.externalId);
  });

  it('carries the externalId on the error, so the payment can actually be looked up', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');

    const err = (await create(companyId).catch((e: unknown) => e)) as WhishIndeterminateError;

    // The create returns no body, so without these the integrator has no handle
    // on the payment and the documented recovery would dead-end.
    expect(err.details?.externalId).toBeTruthy();
    const row = await readRow(h, err.details!.paymentId as string);
    expect(row.externalId.toString()).toBe(err.details!.externalId);
  });

  it('re-attempts the mint when the same idempotencyKey retries a linkless orphan', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const key = `idem-${Date.now()}`;
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');
    await expect(create(companyId, { idempotencyKey: key })).rejects.toThrow();

    // Whish recovers; the integrator retries with the same key.
    h.whishClient.failPostPaymentWith = null;
    const res = await create(companyId, { idempotencyKey: key });

    // Same payment (same externalId), now WITH a payable link — not the dead row.
    expect(res.collectUrl).toBeTruthy();
    expect(res.status).toBe('PENDING');
    const sent = h.whishClient.postPaymentCalls;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.externalId).toBe(sent[1]!.externalId); // reused, not re-minted
  });

  it('mints the ROW amount, not a mismatched retry body', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const key = `idem-mismatch-${Date.now()}`;
    h.whishClient.failPostPaymentWith = new WhishIndeterminateError('service unavailable');
    await expect(create(companyId, { idempotencyKey: key, amount: '25.00' })).rejects.toThrow();
    h.whishClient.failPostPaymentWith = null;

    // Reusing the key with a DIFFERENT amount must not mint a 99.00 link against
    // a row that would settle at 25.00.
    await expect(create(companyId, { idempotencyKey: key, amount: '99.00' })).rejects.toThrow(
      /already used for a different payment/i,
    );
    expect(h.whishClient.postPaymentCalls).toHaveLength(1); // the bad retry never reached Whish

    // The original body still recovers it, at the original amount.
    const ok = await create(companyId, { idempotencyKey: key, amount: '25.00' });
    expect(ok.collectUrl).toBeTruthy();
    expect(Number(h.whishClient.postPaymentCalls.at(-1)!.amount)).toBe(25);
  });

  it('returns the original untouched when a healthy payment is retried with the same key', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const key = `idem-ok-${Date.now()}`;
    const first = await create(companyId, { idempotencyKey: key });
    const second = await create(companyId, { idempotencyKey: key });

    expect(second.id).toBe(first.id);
    expect(h.whishClient.postPaymentCalls).toHaveLength(1); // no second upstream call
  });

  // Whish DOCUMENTS a 1.00 minimum and a 2-decimal cap but enforces neither:
  // verified against the live v1.4.4 sandbox, which mints a real link for both
  // and carries a 0.50 link to the payer's OTP step. Being stricter than the
  // payment provider would refuse money it is willing to collect — so a
  // sub-cent amount is QUANTIZED, never rejected.
  it.each([
    ['0.50', 0.5], // under the documented minimum — still created
    ['10.005', 10], // sub-cent precision — half-even to the cent (0 is even)
  ])('accepts %o and asks Whish for exactly what it will book', async (amount, expected) => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');

    const res = await create(companyId, { amount });

    expect(res.collectUrl).toBeTruthy();
    const sent = Number(h.whishClient.postPaymentCalls.at(-1)!.amount);
    expect(sent).toBe(expected);
    // The three must agree: what the payer is charged, what we stored, and what
    // settlement will book. A divergence here would charge a customer one amount
    // and credit the company from another.
    expect(sent).toBe(Number(res.amount));
  });
});
