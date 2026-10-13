/**
 * A burst of deposits for ONE company — its customers paying at the same
 * moment — is booked in full, immediately, with the books balanced.
 *
 * Every deposit updates the company's wallet row inside a SERIALIZABLE
 * transaction. Before the per-company queue (PrismaService →
 * CompanyQueue) they raced for that row: Postgres aborted all but one, and
 * after five quick retries the rest failed — measured live, a burst of 300
 * Whish payments booked 129 immediately and left the rest to the poller, and
 * a source pushing in parallel got WRITE_CONFLICT for the excess.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { WhishPaymentStatus } from '@app/shared';
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

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.runAsAdmin(async (tx) => {
    const existing = await tx.source.findUnique({ where: { code: 'whish' } });
    if (!existing) await tx.source.create({ data: { name: 'Whish', code: 'whish' } });
  });
});

describe('a burst of deposits for one company', () => {
  it('60 source deposits at the same moment: every one booked, none refused', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0');

    const results = await Promise.allSettled(
      Array.from({ length: 60 }, () =>
        h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '10')),
      ),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(600);
  });

  it('40 Whish payments confirmed at the same moment: every deposit booked at once', async () => {
    const { companyId } = await createCompany(h);
    await addTransactionFee(h, companyId, '0');
    h.whishClient.status = 'success';
    h.whishClient.failGetStatusWith = null;
    const links = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        h.prisma.runAsAdmin((tx) =>
          tx.whishPayment.create({
            data: {
              companyId,
              callbackToken: `it-burst-${Date.now().toString(36)}-${i}`,
              amount: '25.00',
              currency: USD,
              invoice: `burst-${i}`,
              status: WhishPaymentStatus.PENDING,
            },
            select: { id: true, externalId: true, callbackToken: true },
          }),
        ),
      ),
    );

    const authentic = await Promise.all(
      links.map((l) => h.whish.handleCallback(Number(l.externalId), l.callbackToken)),
    );
    expect(authentic.every(Boolean)).toBe(true);

    const statuses = await h.prisma.runAsAdmin((tx) =>
      tx.whishPayment.findMany({
        where: { id: { in: links.map((l) => l.id) } },
        select: { status: true },
      }),
    );
    // All PAID right away — none left for the poller to pick up later.
    expect(statuses.filter((s) => s.status === WhishPaymentStatus.PAID)).toHaveLength(40);
    const snap = await snapshot(h, companyId);
    expect(snap.balanced).toBe(true);
    expect(Number(snap.wallet?.available)).toBe(1000);
  });

  it('two companies’ bursts do not wait for each other', async () => {
    const a = await createCompany(h);
    const b = await createCompany(h);
    const sa = await createEnabledSource(h, a.companyId);
    const sb = await createEnabledSource(h, b.companyId);
    await addTransactionFee(h, a.companyId, '0');
    await addTransactionFee(h, b.companyId, '0');

    const results = await Promise.allSettled([
      ...Array.from({ length: 20 }, () =>
        h.transactions.ingest({ kind: 'source', sourceId: sa }, ingestInput(a.companyId, '5')),
      ),
      ...Array.from({ length: 20 }, () =>
        h.transactions.ingest({ kind: 'source', sourceId: sb }, ingestInput(b.companyId, '7')),
      ),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(Number((await snapshot(h, a.companyId)).wallet?.available)).toBe(100);
    expect(Number((await snapshot(h, b.companyId)).wallet?.available)).toBe(140);
  });
});
