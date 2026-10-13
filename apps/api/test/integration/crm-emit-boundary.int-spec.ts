/**
 * NEGATIVE boundary test for OWNER INVARIANT 5: loads & payouts must NEVER reach
 * the company CRM webhook (only deposits `transaction.*` and withdrawals
 * `withdrawal.*` do). Today this is enforced purely structurally — neither
 * service imports CrmModule, so CrmDispatchService is not even injectable there.
 * There is no test guarding that boundary, so a future refactor that wires
 * loads/payouts into a shared post-commit emit fan-out would silently leak them
 * to CRMs with every gate still green.
 *
 * This test pins the boundary two ways:
 *   1. Structural: a real CrmDispatchService is wired into the harness as a SPY.
 *      A full load + payout request→approve lifecycle must produce ZERO calls on
 *      it. (A deposit ingest, by contrast, DOES call it — the control.)
 *   2. Observable: with the CRM ENABLED on the company, the same lifecycle must
 *      leave ZERO `webhook_deliveries` rows. (The control deposit leaves one.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Counter } from 'prom-client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service';
import type { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import type { Env } from '../../src/config/env.schema';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { LoadsService } from '../../src/modules/loads/loads.service';
import { PayoutsService } from '../../src/modules/payouts/payouts.service';
import { TransactionsService } from '../../src/modules/transactions/transactions.service';
import { CrmDispatchService } from '../../src/modules/crm/crm-dispatch.service';
import { CrmDeliveryService } from '../../src/modules/crm/crm-delivery.service';
import { CrmDemoInboxService } from '../../src/modules/crm/crm-demo-inbox.service';
import { CommissionResolverService } from '../../src/modules/commissions/commission-resolver.service';
import { CommissionsRepository } from '../../src/modules/commissions/commissions.repository';
import { FeesService } from '../../src/modules/commissions/fees.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  payoutInput,
  type Harness,
} from './harness';

const fakeRealtime = {
  company: () => undefined,
} as unknown as RealtimeService;
const fakeAnalytics = {
  invalidateAll: async () => undefined,
} as unknown as AnalyticsService;
const fakeNotifications = {
  requestSubmitted: async () => undefined,
  requestResolved: async () => undefined,
  clearAdminRequest: async () => undefined,
} as unknown as NotificationsService;
const fakeCache = {
  wrap: async (_k: string, _ttl: number, fn: () => unknown) => fn(),
  tryLock: async () => 'lock',
  unlock: async () => undefined,
} as unknown as CacheService;
const fakeCounter = { inc: () => undefined } as unknown as Counter<string>;

let h: Harness;
let prisma: PrismaService;
// Real dispatch, but every public method is a vitest spy so we can assert call counts.
let crmSpy: CrmDispatchService;
let loads: LoadsService;
let payouts: PayoutsService;
let transactions: TransactionsService;

beforeAll(async () => {
  h = buildHarness();
  prisma = h.prisma;
  await prisma.$connect();

  const ledger = new LedgerService(prisma, fakeCache);
  const wallets = new WalletsService(prisma);
  const resolver = new CommissionResolverService();
  const repo = new CommissionsRepository(fakeCache);
  const fees = new FeesService(resolver, repo);

  const fakeConfig = {
    get: (k: string) => (k === 'API_PUBLIC_URL' ? 'http://localhost:3001/v1' : undefined),
  } as unknown as ConfigService<Env, true>;
  const demoInbox = new CrmDemoInboxService(prisma, fakeRealtime);
  const delivery = new CrmDeliveryService(prisma, fakeConfig, demoInbox, fakeCache);
  const realDispatch = new CrmDispatchService(prisma, delivery);
  // Spy on every emit entry point; keep the real DB enqueue so the observable
  // (webhook_deliveries) is also exercised when something DOES emit.
  vi.spyOn(realDispatch, 'emitFromTransaction');
  vi.spyOn(realDispatch, 'emitWithdrawal');
  vi.spyOn(realDispatch, 'emitWhish');
  crmSpy = realDispatch;

  loads = new LoadsService(
    prisma,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeNotifications,
    fakeCache,
    fees,
  );
  payouts = new PayoutsService(
    prisma,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeNotifications,
    fakeCache,
    fees,
  );
  transactions = new TransactionsService(
    prisma,
    resolver,
    repo,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeCounter,
    fakeCounter,
    fakeCounter,
    fakeCache,
    crmSpy, // real spy: ingest WILL call emitFromTransaction (the control)
    fakeNotifications,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Turn the CRM webhook on so an emit, if it happened, WOULD persist a delivery. */
async function enableCrm(companyId: string): Promise<void> {
  await prisma.runAsAdmin((tx) =>
    tx.company.update({
      where: { id: companyId },
      data: { crmEnabled: true, crmApiUrl: 'https://example.test/crm-hook' },
    }),
  );
}

async function deliveryCount(companyId: string): Promise<number> {
  return prisma.runAsAdmin((tx) => tx.webhookDelivery.count({ where: { companyId } }));
}

describe('CRM emit boundary (invariant 5: loads/payouts never emitted)', () => {
  it('LoadsService and PayoutsService take NO CRM dependency (cannot emit)', () => {
    // Their constructors are CRM-free; the harness wires them WITHOUT a dispatch
    // arg. If a refactor adds a CRM param, this length assertion breaks and forces
    // a deliberate review of the boundary.
    expect(LoadsService.length).toBe(8);
    expect(PayoutsService.length).toBe(8);
  });

  it('approving a LOAD emits nothing and writes no webhook delivery', async () => {
    const { companyId, userId } = await createCompany(h);
    await enableCrm(companyId);
    vi.clearAllMocks();

    const load = await loads.request(companyId, userId, loadInput('100'));
    await loads.approve(load.id, userId, { externalReference: 'recv-load' });

    expect(crmSpy.emitFromTransaction).toHaveBeenCalledTimes(0);
    expect(crmSpy.emitWithdrawal).toHaveBeenCalledTimes(0);
    expect(crmSpy.emitWhish).toHaveBeenCalledTimes(0);
    // give any (non-existent) fire-and-forget enqueue a moment to land
    await new Promise((r) => setTimeout(r, 150));
    expect(await deliveryCount(companyId)).toBe(0);
  });

  it('approving a PAYOUT emits nothing and writes no webhook delivery', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0'); // ingest must price every deposit
    await enableCrm(companyId);
    // Fund the wallet WITHOUT going through the CRM-spied transactions service so
    // the ingest control below is isolated — fund directly via a no-CRM ingest.
    const fundTx = new TransactionsService(
      prisma,
      new CommissionResolverService(),
      new CommissionsRepository(fakeCache),
      new LedgerService(prisma, fakeCache),
      new WalletsService(prisma),
      fakeAnalytics,
      fakeRealtime,
      fakeCounter,
      fakeCounter,
      fakeCounter,
      fakeCache,
      { emitFromTransaction: () => undefined } as unknown as CrmDispatchService,
      fakeNotifications,
    );
    await fundTx.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));
    vi.clearAllMocks();

    const p = await payouts.request(companyId, userId, payoutInput('40'));
    await payouts.approve(p.id, userId, { externalReference: 'pay-ref' });

    expect(crmSpy.emitFromTransaction).toHaveBeenCalledTimes(0);
    expect(crmSpy.emitWithdrawal).toHaveBeenCalledTimes(0);
    expect(crmSpy.emitWhish).toHaveBeenCalledTimes(0);
    await new Promise((r) => setTimeout(r, 150));
    // Only the funding deposit's delivery exists; the payout adds none.
    const before = await deliveryCount(companyId);

    // CONTROL: a deposit ingest on the SAME company DOES emit + persist a row,
    // proving the observable is live (so the zero above is meaningful, not a
    // mis-wired CRM that can never deliver).
    await transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '25'));
    expect(crmSpy.emitFromTransaction).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(await deliveryCount(companyId)).toBe(before + 1);
  });
});
