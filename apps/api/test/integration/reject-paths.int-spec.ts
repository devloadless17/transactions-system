/**
 * Integration tests for the admin REJECT branches of payouts + loads and the
 * cross-tenant cancel guard — the paths the happy-path money-flow specs don't
 * reach.
 *
 * - Payout reject: shares the reserved-release path with company cancel, so the
 *   reserved funds must return to available and the books must stay balanced.
 * - Load reject: a load reserves nothing at request time, so reject is a pure
 *   status change — no ledger/wallet movement.
 * - Both flows record the admin's reason in `adminNotes` WITHOUT clobbering the
 *   company's own request `notes`.
 * - Cancel is company-scoped: passing a different tenant's companyId must trip
 *   the `opts.companyId && row.companyId !== opts.companyId` guard with a
 *   NotFoundError and leave the row untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  addFlowFee,
  addTransactionFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  payoutInput,
  snapshot,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

// Fund a fresh company's available balance via a zero-fee ingest so it can
// reserve funds for a payout.
async function fundedCompany(available: string) {
  const c = await createCompany(h);
  const sourceId = await createEnabledSource(h, c.companyId);
  await addTransactionFee(h, c.companyId, '0'); // no fee → available == amount
  await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(c.companyId, available));
  return c;
}

describe('payout admin reject', () => {
  it('releases the reserved funds back to available and stays balanced', async () => {
    const { companyId, userId } = await fundedCompany('100');

    // Company files the payout with its own request note.
    const p = await h.payouts.request(companyId, userId, {
      ...payoutInput('40'),
      notes: 'please pay me',
    });
    const afterRequest = await snapshot(h, companyId);
    expect(eq(afterRequest.wallet!.available, '60')).toBe(true);
    expect(eq(afterRequest.wallet!.reserved, '40')).toBe(true);

    // Admin rejects: reject(id, approvedById, { notes }).
    const rejected = await h.payouts.reject(p.id, userId, { notes: 'wrong recipient' });
    expect(rejected.status).toBe('REJECTED');
    // Admin reason → adminNotes; the company's request note is preserved.
    expect(rejected.adminNotes).toBe('wrong recipient');
    expect(rejected.notes).toBe('please pay me');

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.available, '100')).toBe(true); // fully restored
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
    expect(eq(snap.wallet!.available, snap.availableLedger)).toBe(true);
  });
});

describe('load admin reject', () => {
  it('marks REJECTED without moving any money and preserves the company note', async () => {
    const { companyId, userId } = await createCompany(h);
    await addFlowFee(h, companyId, 'LOAD', '10'); // 10% — proves no fee is booked on reject

    const load = await h.loads.request(companyId, userId, {
      ...loadInput('100'),
      notes: 'topping up',
    });
    expect(load.status).toBe('PENDING');

    const rejected = await h.loads.reject(load.id, userId, { notes: 'no funds received' });
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.adminNotes).toBe('no funds received');
    expect(rejected.notes).toBe('topping up');

    // Nothing was moved at request time, so reject books nothing: no ledger
    // entries, no wallet.
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.totalDebit, '0')).toBe(true);
    expect(eq(snap.totalCredit, '0')).toBe(true);
    expect(snap.wallet).toBeNull();
  });
});

describe('cross-tenant cancel guard', () => {
  it('payout cancel with another tenant companyId throws NotFound and leaves the row PENDING', async () => {
    const a = await fundedCompany('100');
    const b = await createCompany(h);

    const p = await h.payouts.request(a.companyId, a.userId, payoutInput('40'));
    expect(eq((await snapshot(h, a.companyId)).wallet!.reserved, '40')).toBe(true);

    // B tries to cancel A's payout: the companyId guard must reject it.
    await expect(h.payouts.cancel(p.id, b.companyId, b.userId, {})).rejects.toThrow(/not found/i);

    // The payout is untouched: still PENDING, funds still reserved, balanced.
    const still = await h.payouts.getById(p.id, a.companyId);
    expect(still.status).toBe('PENDING');
    const snap = await snapshot(h, a.companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.available, '60')).toBe(true);
    expect(eq(snap.wallet!.reserved, '40')).toBe(true);
  });

  it('load cancel with another tenant companyId throws NotFound and leaves the row PENDING', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);

    const load = await h.loads.request(a.companyId, a.userId, loadInput('50'));

    await expect(h.loads.cancel(load.id, b.companyId, b.userId, {})).rejects.toThrow(/not found/i);

    const still = await h.loads.getById(load.id, a.companyId);
    expect(still.status).toBe('PENDING');
    // A load reserves nothing; just confirm the books are still trivially balanced.
    const snap = await snapshot(h, a.companyId);
    expect(snap.balanced).toBe(true);
  });
});

// Zero-net money-out guard (2026-07-03 audit): a DEDUCTED fee that consumes the
// entire amount would send the recipient 0 while the full amount leaves the
// wallet to the platform FEE account — a balanced but surely-misconfigured
// state. Request must be rejected up front with nothing reserved; deposits are
// deliberately NOT guarded (a deposit must never be blocked by pricing shape).
describe('zero-net DEDUCTED money-out is rejected at request time', () => {
  it('withdrawal with a 100% DEDUCTED fee → ValidationError, nothing reserved', async () => {
    const { companyId, userId } = await fundedCompany('100');
    await addFlowFee(h, companyId, 'WITHDRAWAL', '100'); // fee == amount → net 0

    await expect(
      h.withdrawals.request(companyId, userId, cashWithdrawalInput('50')),
    ).rejects.toThrow(/recipient would receive 0/i);

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
    expect(eq(snap.wallet!.available, '100')).toBe(true);
  });

  it('payout with a 100% DEDUCTED fee → ValidationError, nothing reserved', async () => {
    const { companyId, userId } = await fundedCompany('100');
    await addFlowFee(h, companyId, 'PAYOUT', '100');

    await expect(h.payouts.request(companyId, userId, payoutInput('25'))).rejects.toThrow(
      /recipient would receive 0/i,
    );

    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(eq(snap.wallet!.reserved, '0')).toBe(true);
  });
});
