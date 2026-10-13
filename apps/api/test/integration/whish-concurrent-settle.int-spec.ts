import { beforeAll, describe, expect, it } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
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
 * Exactly-once cover for the concurrent Whish settle path
 * (whish-payments.service.ts ~556-618): TWO settlers racing the SAME payment must
 * converge to ONE booked transaction, ONE wallet credit, and balanced books —
 * never a double credit and never a rejection.
 *
 * The race runs across the two real entry points that funnel into `reconcile`: the
 * Whish success callback (`handleCallback(externalId, token)`) and the admin manual
 * refresh (`adminRefreshStatus(id, actor)`). Both see Whish `success`, so each tries to
 * ingest + settle the same link.
 *
 * What enforces exactly-once here (empirically verified): the loser's `ingest` runs
 * in the per-tenant SERIALIZABLE money tx and short-circuits on ingest's NATURAL
 * (sourceId, externalTransactionId) idempotency — replaying the winner's transaction
 * instead of inserting a second one. NOTE: in this single-connection harness the
 * loser takes that natural-idempotency path, NOT the reconcile P2002 catch
 * (565-576); that catch is defense-in-depth for a TRUE concurrent-connection DB race
 * (two pooled connections inserting before either commits), which a single
 * PrismaService can't reproduce. So this pins the exactly-once GUARANTEE, not the
 * P2002 branch specifically.
 */

let tok = 0;
const callbackToken = () => `it-tok-${Date.now().toString(36)}-${tok++}`;

async function provisionWhishSource(h: Harness): Promise<void> {
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
}

/**
 * Insert a PENDING whish_payment and return the identifiers the two settlers
 * need: the row `id` (admin/company refresh) and its auto-assigned numeric
 * `externalId` + `callbackToken` (success callback).
 */
async function insertPayment(
  h: Harness,
  companyId: string,
  status: WhishPaymentStatus,
): Promise<{ id: string; externalId: number; callbackToken: string }> {
  const token = callbackToken();
  const row = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: token,
        amount: '50.00',
        currency: USD,
        invoice: 'inv-concurrent',
        status,
      },
      select: { id: true, externalId: true },
    }),
  );
  return { id: row.id, externalId: Number(row.externalId), callbackToken: token };
}

describe('concurrent Whish settle race (exactly-once)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });

  it('two settlers racing the same link settle EXACTLY ONCE (loser replays via natural idempotency)', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0'); // 0% fee → full 50 credit, deterministic
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success'; // Whish reports success to BOTH racers

    // Fire both authoritative entry points at the exact same time on the SAME
    // payment. handleCallback resolves whether the callback was authentic (it swallows + logs
    // settlement errors); adminRefreshStatus
    // returns the mapped row. NEITHER may reject — the loser must replay the winner's
    // transaction (natural idempotency), not blow up.
    const results = await Promise.allSettled([
      h.whish.handleCallback(p.externalId, p.callbackToken),
      h.whish.adminRefreshStatus(p.id, ADMIN_ACTOR),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

    // Exactly ONE transaction row exists for this (source, externalId) — ingest's
    // natural idempotency (+ the unique constraint as backstop) guarantees no second
    // booking slipped through.
    const source = await h.prisma.runAsAdmin((tx) =>
      tx.source.findUniqueOrThrow({ where: { code: 'whish' } }),
    );
    const txns = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findMany({
        where: { sourceId: source.id, externalTransactionId: String(p.externalId) },
        select: { id: true },
      }),
    );
    expect(txns).toHaveLength(1);

    // The link is PAID and linked to that single transaction.
    const settled = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findUniqueOrThrow({ where: { id: p.id } }),
    );
    expect(settled.status).toBe(WhishPaymentStatus.PAID);
    expect(settled.transactionId).toBe(txns[0].id);

    // The money was credited ONCE: wallet available is 50, NOT 100, and the
    // ledger still balances after the concurrent settle.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('two admin refreshes racing the same link also settle EXACTLY ONCE', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';

    // Same race via two identical entry points — both return the mapped row, and
    // both must resolve (the loser replays the winner's booking, no double credit).
    const results = await Promise.allSettled([
      h.whish.adminRefreshStatus(p.id, ADMIN_ACTOR),
      h.whish.adminRefreshStatus(p.id, ADMIN_ACTOR),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    for (const r of results) {
      if (r.status === 'fulfilled') expect(r.value.status).toBe('PAID');
    }

    const source = await h.prisma.runAsAdmin((tx) =>
      tx.source.findUniqueOrThrow({ where: { code: 'whish' } }),
    );
    const txns = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findMany({
        where: { sourceId: source.id, externalTransactionId: String(p.externalId) },
        select: { id: true },
      }),
    );
    expect(txns).toHaveLength(1); // exactly one booking, no double credit

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50); // credited once (50, not 100)
  });
});
