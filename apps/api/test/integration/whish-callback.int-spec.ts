import { beforeAll, describe, expect, it } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * Cover for the PUBLIC, UNAUTHENTICATED Whish callback handler
 * (`WhishPaymentsService.handleCallback`). Whish performs a GET to our
 * success/failure callback URLs carrying `externalId` + an unguessable
 * per-payment `token`; the handler never trusts the callback — it looks the
 * payment up by externalId, gates on a constant-time token compare, then
 * re-verifies the real status with Whish before settling. These tests pin the
 * two guards the money-in path depends on:
 *   - unknown externalId          → silent no-op (never throws, books nothing)
 *   - wrong/short token           → silent no-op (never settles)
 *   - correct token on PENDING    → settles exactly once (wallet credited)
 *   - replay of a correct callback → idempotent (no double credit)
 * They FAIL if the unknown-id guard or the length/timing-safe token gate is
 * removed: a wrong-token or unknown-id callback would then settle/throw.
 */

let tok = 0;
const callbackToken = () => `it-cb-${Date.now().toString(36)}-${tok++}`;

async function provisionWhishSource(h: Harness): Promise<void> {
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
}

/** Mint a whish_payments row directly; returns the bits the callback needs. */
async function insertPayment(
  h: Harness,
  companyId: string,
  status: WhishPaymentStatus,
): Promise<{ id: string; externalId: number; token: string }> {
  const token = callbackToken();
  const row = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.create({
      data: {
        companyId,
        callbackToken: token,
        amount: '50.00',
        currency: USD,
        invoice: 'inv-cb-test',
        status,
      },
      select: { id: true, externalId: true },
    }),
  );
  return { id: row.id, externalId: Number(row.externalId), token };
}

/** Read a payment's current status straight from the DB (admin scope). */
async function statusOf(h: Harness, id: string): Promise<WhishPaymentStatus> {
  const row = await h.prisma.runAsAdmin((tx) =>
    tx.whishPayment.findUniqueOrThrow({ where: { id }, select: { status: true } }),
  );
  return row.status;
}

describe('Whish callback handler (public, unauthenticated)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = buildHarness();
    await provisionWhishSource(h);
  });

  it('ignores a callback for an unknown externalId — no-op, never throws', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.status = 'success'; // even if it tried to settle, there is nothing to find

    // A wildly-high externalId that no row owns. Must resolve cleanly (the
    // endpoint always replies 200) and book nothing.
    await expect(h.whish.handleCallback(2_000_000_000, 'any-token')).resolves.toBeUndefined();

    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0); // no ledger entries booked
    expect(Number(snap.wallet?.available ?? '0')).toBe(0);
  });

  it('ignores a callback with the WRONG token — payment stays PENDING, no credit', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success'; // Whish would report success — but the token must gate it out

    // A token of a DIFFERENT length than the real one exercises the length
    // pre-check; a same-length wrong token would exercise timingSafeEqual.
    await expect(h.whish.handleCallback(p.externalId, `${p.token}-wrong`)).resolves.toBeUndefined();

    expect(await statusOf(h, p.id)).toBe(WhishPaymentStatus.PENDING); // never settled
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0); // no ledger entries booked
    expect(Number(snap.wallet?.available ?? '0')).toBe(0); // wallet never credited
  });

  it('ignores a same-length wrong token — timing-safe compare must reject it', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';

    // Same length as the real token, differing only in content → passes the
    // length pre-check, must be rejected by crypto.timingSafeEqual.
    const sameLenWrong = `X${p.token.slice(1)}`;
    expect(sameLenWrong.length).toBe(p.token.length);
    expect(sameLenWrong).not.toBe(p.token);

    await expect(h.whish.handleCallback(p.externalId, sameLenWrong)).resolves.toBeUndefined();

    expect(await statusOf(h, p.id)).toBe(WhishPaymentStatus.PENDING);
    const snap = await snapshot(h, companyId);
    expect(Number(snap.totalCredit)).toBe(0);
    expect(Number(snap.wallet?.available ?? '0')).toBe(0);
  });

  it('settles a PENDING payment when the correct token + Whish success arrive', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0'); // 0% fee → full credit
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';

    await expect(h.whish.handleCallback(p.externalId, p.token)).resolves.toBeUndefined();

    expect(await statusOf(h, p.id)).toBe(WhishPaymentStatus.PAID);
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(50);
  });

  it('is idempotent on a replayed callback — no double credit', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    const p = await insertPayment(h, companyId, WhishPaymentStatus.PENDING);
    h.whishClient.status = 'success';

    await h.whish.handleCallback(p.externalId, p.token); // first → settles, credits 50
    await h.whish.handleCallback(p.externalId, p.token); // replay → must be a no-op

    expect(await statusOf(h, p.id)).toBe(WhishPaymentStatus.PAID);
    const snap = await snapshot(h, companyId);
    expect(Number(snap.wallet?.available)).toBe(50); // still 50, not 100
    expect(snap.balanced).toBe(true);
  });
});
