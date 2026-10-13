/**
 * The ledger-vs-wallet reconciliation must never report a divergence that does
 * not exist. It reads the ledger sums and the wallets in two statements; under
 * READ COMMITTED a deposit committing between them looked like a mismatch —
 * seen in a blue/green rehearsal under load (wallet ahead of the ledger by
 * exactly two deposits). It now reads both from one snapshot (REPEATABLE READ).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Gauge } from 'prom-client';
import { ReconciliationService } from '../../src/modules/reconciliation/reconciliation.service';
import type { AuditService } from '../../src/modules/audit/audit.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  type Harness,
} from './harness';

let h: Harness;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('reconciliation reads one moment', () => {
  it('reports no divergence while deposits are being booked into the same wallet', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '1');
    const gauge = { set: () => undefined, reset: () => undefined } as unknown as Gauge<string>;
    const audit = { record: async () => undefined } as unknown as AuditService;
    const reconciliation = new ReconciliationService(h.prisma, audit, gauge, gauge);

    // Four writers booking deposits into one wallet, nonstop, while the
    // reconciliation runs again and again.
    let booking = true;
    let booked = 0;
    const writer = async () => {
      while (booking) {
        await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '10'));
        booked++;
      }
    };
    const writers = Promise.all([writer(), writer(), writer(), writer()]);
    await new Promise((r) => setTimeout(r, 100)); // bookings flowing

    const divergent: string[] = [];
    let runs = 0;
    const until = performance.now() + 4_000;
    while (performance.now() < until) {
      const report = await reconciliation.reconcileAll();
      runs++;
      for (const d of report.discrepancies.filter((x) => x.companyId === companyId)) {
        divergent.push(`available wallet ${d.available.wallet} vs ledger ${d.available.ledger}`);
      }
    }
    booking = false;
    await writers;

    expect(divergent).toEqual([]);
    // It was a real race: many reconciliations while the wallet kept moving.
    expect(runs).toBeGreaterThan(10);
    expect(booked).toBeGreaterThan(20);
    // And at rest it agrees too.
    const atRest = await reconciliation.reconcileAll();
    expect(atRest.discrepancies.filter((x) => x.companyId === companyId)).toEqual([]);
  }, 60_000);
});
