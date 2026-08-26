import { beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  addFlowFee,
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  USD,
  cashWithdrawalInput,
  type Harness,
} from './harness';

/**
 * LEGACY OVER-SCALE ROWS — the failure mode that makes the money-scale change
 * dangerous, and the reason quantization happens at the DB READ rather than only
 * where money is created.
 *
 * Rows written before the scale change can carry more decimals than the platform
 * now books (e.g. a fee of 0.105 from an old percentage rule). Those values are
 * read back on every settle / reject / reverse. If the ledger rounded each leg
 * independently at write time, such a row would produce
 *   DEBIT 10.03  vs  CREDIT 9.92 + 0.10
 * an unbalanced set — a hard 500 with the reserved funds wedged and no retry that
 * can ever succeed, because the stored values never change.
 *
 * These tests write over-scale rows through RAW SQL (bypassing validation, which
 * is exactly how history got there) and then drive the real money paths over them.
 */

async function forceOverScale(
  h: Harness,
  table: 'withdrawals' | 'payouts',
  id: string,
  cols: Record<string, string>,
): Promise<void> {
  const sets = Object.entries(cols)
    .map(([c, v]) => `"${c}" = ${v}`)
    .join(', ');
  await h.prisma.runAsAdmin((tx) =>
    tx.$executeRawUnsafe(`UPDATE "${table}" SET ${sets} WHERE id = '${id}'`),
  );
}

describe('legacy over-scale rows still settle cleanly', () => {
  let h: Harness;
  beforeAll(() => {
    h = buildHarness();
  });

  it('approves a PENDING withdrawal whose stored fee carries sub-cent precision', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));
    await addFlowFee(h, companyId, 'WITHDRAWAL', '0');

    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('10.03'));

    // Rewrite the row the way a pre-migration percentage rule would have: a fee of
    // 0.105 and a net of 9.925, neither of which is representable in cents.
    await forceOverScale(h, 'withdrawals', w.id, {
      fee_amount: '0.105',
      net_amount: '9.925',
    });

    // Before the DB-read quantization this threw "unbalanced ledger entries".
    const approved = await h.withdrawals.approve(w.id, userId, { externalReference: 'legacy-1' });

    expect(approved.status).toBe('COMPLETED');
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Money.of(snap.wallet!.reserved).isZero()).toBe(true);
    // The wallet remains a faithful projection of the ledger.
    expect(Money.of(snap.wallet!.available).eq(Money.of(snap.availableLedger))).toBe(true);
  });

  it('rejects (releases) a PENDING withdrawal with an over-scale stored fee', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));
    await addFlowFee(h, companyId, 'WITHDRAWAL', '0');

    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('10.03'));
    await forceOverScale(h, 'withdrawals', w.id, { fee_amount: '0.105', net_amount: '9.925' });

    const rejected = await h.withdrawals.reject(w.id, userId, { notes: 'legacy release' });

    expect(rejected.status).toBe('REJECTED');
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    // Everything reserved came back; the release must mirror the reserve exactly,
    // or the wallet drifts from the ledger by the sub-cent tail.
    expect(Money.of(snap.wallet!.reserved).isZero()).toBe(true);
    expect(Money.of(snap.wallet!.available).eq(Money.of(snap.availableLedger))).toBe(true);
  });

  // THE HARD PRECONDITION for the money-scale change, pinned as a test.
  //
  // With ON_TOP the reservation is amount + fee, so a legacy over-scale fee means
  // the wallet and ledger hold a reservation (100.015) that is not representable
  // at the platform scale. Such a row CANNOT be settled: draining it exactly needs
  // an over-scale ledger leg, which writeEntries refuses by design, and draining a
  // quantized amount instead takes more than was ever reserved.
  //
  // There is no code fix — the arithmetic does not allow one. Rows like this must
  // be settled or cancelled BEFORE the money scale is flipped; see the drain gate
  // in the (now-retired) money-scale migration runbook, which is why that gate ran before Stage A
  // and not before Stage B. This test exists so the constraint is discovered here
  // rather than in production.
  it('CANNOT settle an over-scale ON_TOP reservation — proves the drain gate is required', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '200'));
    await addFlowFee(h, companyId, 'WITHDRAWAL', '0', 'ON_TOP');

    const w = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('100'));
    // Rewrite the row and the wallet as a pre-migration state would look.
    await forceOverScale(h, 'withdrawals', w.id, { fee_amount: '0.015', net_amount: '100' });
    await h.prisma.runAsAdmin((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "wallets" SET "reserved_balance" = 100.015, "available_balance" = 99.985 WHERE company_id = '${companyId}'`,
      ),
    );

    // Fails LOUDLY rather than corrupting the books — the wallet guard refuses to
    // go negative, so nothing is written and the reservation stays intact.
    await expect(
      h.withdrawals.approve(w.id, userId, { externalReference: 'ontop-1' }),
    ).rejects.toThrow(/negative/i);

    // Critically: the refusal is safe. Nothing was drained, nothing unbalanced.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Money.of(snap.wallet!.reserved).isNegative()).toBe(false);
  });

  it('reverses a transaction against a wallet balance carrying a sub-cent tail', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');
    const txn = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );

    // A legacy wallet balance with an 8dp tail, as a pre-migration row would hold.
    await h.prisma.runAsAdmin((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "wallets" SET "available_balance" = 100.00000001 WHERE company_id = '${companyId}' AND currency = '${USD}'`,
      ),
    );

    const reversed = await h.transactions.reverse(txn.id, {
      actorId: userId,
      reason: 'chargeback',
    });

    expect(reversed.status).toBe('REVERSED');
    const snap = await snapshot(h, companyId);
    // The clawback caps against the balance with floorToScale — never rounding UP
    // past what is actually held, which would drive the wallet negative.
    expect(snap.balanced).toBe(true);
    expect(Money.of(snap.wallet!.available).isNegative()).toBe(false);
  });
});
