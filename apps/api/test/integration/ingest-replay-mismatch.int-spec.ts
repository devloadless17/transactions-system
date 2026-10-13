import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  snapshot,
  USD,
  type Harness,
} from './harness';

/**
 * A repeat is only a replay when it is the SAME transaction.
 *
 * Ingest dedupes on (source, externalTransactionId) and on idempotencyKey. It
 * used to answer every match "replayed" without comparing what was sent — so a
 * deposit recorded by hand as 100.00 that the source then sent as 1000.00 came
 * back replayed:true, the books stayed balanced, and the real 900 was never
 * credited with nothing anywhere to notice. A repeat whose amount or currency
 * differs (or whose idempotencyKey belongs to another reference) is now refused
 * with 409 TRANSACTION_MISMATCH, books nothing, and alerts the admins.
 */
describe('Ingest — a repeat with different money is refused, never silently replayed', () => {
  let h: Harness;
  beforeAll(() => {
    h = buildHarness();
  });
  beforeEach(() => {
    h.crm.reset();
    h.depositAlerts.length = 0;
  });

  async function pricedPair() {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '2');
    return { companyId, sourceId };
  }

  const viaApi = (
    sourceId: string,
    companyId: string,
    ref: string,
    amount: string,
    extra: { idempotencyKey?: string } = {},
  ) =>
    h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, amount, { externalTransactionId: ref, ...extra }),
    );

  it('a hand-recorded 100 that the source sends as 1000 is refused — the 900 is not silently lost', async () => {
    const { companyId, sourceId } = await pricedPair();
    const recorded = await h.transactions.createManualDeposit({
      sourceId,
      companyId,
      externalTransactionId: 'ref-typo',
      amount: '100.00',
      currency: USD,
      payload: {},
    });
    h.crm.reset();
    const before = await snapshot(h, companyId);

    await expect(viaApi(sourceId, companyId, 'ref-typo', '1000.00')).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
      httpStatus: 409,
      details: {
        externalTransactionId: 'ref-typo',
        recorded: { amount: '100.00', currency: USD },
        sent: { amount: '1000.00', currency: USD },
      },
    });

    // Nothing booked, nothing announced to the company…
    const after = await snapshot(h, companyId);
    expect(after.wallet?.available).toBe(before.wallet?.available);
    expect(after.totalCredit).toBe(before.totalCredit);
    expect(h.crm.names()).toEqual([]);
    // …and the admins are told, so someone reconciles it.
    expect(h.depositAlerts).toEqual([
      expect.objectContaining({
        companyId,
        reference: 'ref-typo',
        recorded: '100.00 USD',
        sent: '1000.00 USD',
        transactionId: recorded.id,
      }),
    ]);
  });

  it('closes the same gap for API-only traffic', async () => {
    const { companyId, sourceId } = await pricedPair();
    await viaApi(sourceId, companyId, 'api-ref', '50.00');

    await expect(viaApi(sourceId, companyId, 'api-ref', '60.00')).rejects.toMatchObject({
      code: 'TRANSACTION_MISMATCH',
    });
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(49);
  });

  it('a source retrying the refused request alerts once, but is refused every time', async () => {
    const { companyId, sourceId } = await pricedPair();
    await viaApi(sourceId, companyId, 'storm', '10.00');

    for (let i = 0; i < 3; i++) {
      await expect(viaApi(sourceId, companyId, 'storm', '11.00')).rejects.toMatchObject({
        code: 'TRANSACTION_MISMATCH',
      });
    }
    expect(h.depositAlerts).toHaveLength(1);
  });

  it('the same money written differently is still a true replay ("100" == "100.00")', async () => {
    const { companyId, sourceId } = await pricedPair();
    const first = await viaApi(sourceId, companyId, 'fmt', '100');

    const again = await viaApi(sourceId, companyId, 'fmt', '100.00');

    expect(again.replayed).toBe(true);
    expect(again.id).toBe(first.id);
    expect(h.depositAlerts).toEqual([]);
  });

  it('an idempotencyKey reused with different money is refused, books nothing, and does not page', async () => {
    const { companyId, sourceId } = await pricedPair();
    await viaApi(sourceId, companyId, 'key-ref-1', '20.00', { idempotencyKey: 'shared-key-1' });

    const err = await viaApi(sourceId, companyId, 'key-ref-2', '25.00', {
      idempotencyKey: 'shared-key-1',
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'TRANSACTION_MISMATCH' });
    // Never "send a new key": a source that regenerates its reference per retry
    // would follow that into booking the same deposit twice.
    expect((err as Error).message).toMatch(/do not retry/i);
    expect((err as Error).message).not.toMatch(/new idempotencyKey/i);
    // Not a same-reference money discrepancy → no admin page, and the other
    // transaction's figures are not shown.
    expect((err as { details: Record<string, unknown> }).details.recorded).toBeUndefined();
    expect(h.depositAlerts).toEqual([]);
    expect(Number((await snapshot(h, companyId)).wallet?.available)).toBe(19.6);
  });

  it('an idempotencyKey retry with a fresh reference but the SAME money still replays (unchanged)', async () => {
    const { companyId, sourceId } = await pricedPair();
    const first = await viaApi(sourceId, companyId, 'retry-ref-1', '30.00', {
      idempotencyKey: 'retry-key-1',
    });

    const again = await viaApi(sourceId, companyId, 'retry-ref-2', '30.00', {
      idempotencyKey: 'retry-key-1',
    });

    expect(again.replayed).toBe(true);
    expect(again.id).toBe(first.id);
  });

  it('an idempotencyKey replay of the same transaction still replays', async () => {
    const { companyId, sourceId } = await pricedPair();
    const first = await viaApi(sourceId, companyId, 'key-same', '20.00', {
      idempotencyKey: 'same-key-1',
    });

    const again = await viaApi(sourceId, companyId, 'key-same', '20.00', {
      idempotencyKey: 'same-key-1',
    });

    expect(again.replayed).toBe(true);
    expect(again.id).toBe(first.id);
  });

  it("an idempotencyKey colliding with ANOTHER source's transaction never shows that source's figures", async () => {
    const { companyId, sourceId } = await pricedPair();
    const otherSource = await createEnabledSource(h, companyId);
    await viaApi(otherSource, companyId, 'theirs', '777.00', { idempotencyKey: 'collide-key' });

    const err = await viaApi(sourceId, companyId, 'mine', '20.00', {
      idempotencyKey: 'collide-key',
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'TRANSACTION_MISMATCH' });
    expect(JSON.stringify((err as { details: unknown }).details)).not.toContain('777');
    expect((err as Error).message).not.toContain('777');
  });
});
