/**
 * Integration-test harness: wires the REAL money-flow services against the
 * REAL test database, with no-op fakes only for the side-effect dependencies
 * (analytics cache, realtime socket, metrics, the commission-rule cache). No
 * Redis/Socket/BullMQ/Nest bootstrap required.
 *
 * The point of these tests is the cross-cutting invariants that unit tests
 * (which mock Prisma) cannot reach: double-entry ledger balance, the wallet
 * being a faithful projection of the ledger, and RLS tenant isolation. Those
 * are exactly the things a future refactor could silently break.
 */
import type { Counter } from 'prom-client';
import { Money, UserRole } from '@app/shared';
import type {
  CashPayoutDetails,
  CreateLoadInput,
  CreatePayoutInput,
  CreateWithdrawalInput,
  IngestTransactionInput,
} from '@app/shared';
import { PrismaService } from '../../src/database/prisma.service';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { CommissionResolverService } from '../../src/modules/commissions/commission-resolver.service';
import { CommissionsRepository } from '../../src/modules/commissions/commissions.repository';
import { FeesService } from '../../src/modules/commissions/fees.service';
import { TransactionsService } from '../../src/modules/transactions/transactions.service';
import { WithdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';
import { PayoutsService } from '../../src/modules/payouts/payouts.service';
import { LoadsService } from '../../src/modules/loads/loads.service';
import { WhishPaymentsService } from '../../src/modules/whish/whish-payments.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import type { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { CrmDispatchService } from '../../src/modules/crm/crm-dispatch.service';
import type { AutoApprovalConfigStore } from '../../src/modules/withdrawals/auto-approval-config.store';
import type { WhishTransfersService } from '../../src/modules/whish/whish-transfers.service';
import type { WhishClient, WhishCollectStatus } from '../../src/modules/whish/whish.client';
import type { WhishWebhookService } from '../../src/modules/whish/whish-webhook.service';
import type { TransactionLogsService } from '../../src/modules/transaction-logs/transaction-logs.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/config/env.schema';

export interface Harness {
  prisma: PrismaService;
  transactions: TransactionsService;
  withdrawals: WithdrawalsService;
  payouts: PayoutsService;
  loads: LoadsService;
  ledger: LedgerService;
  wallets: WalletsService;
  whish: WhishPaymentsService;
  /** Controllable stand-in for the external Whish API — set `.status` per test. */
  whishClient: FakeWhishClient;
}

/**
 * Controllable fake of the external Whish HTTP client. The reconcile path only
 * calls `isConfigured()` + `getStatus()`, so tests drive settlement by setting
 * `.status` ('success' | 'failed' | 'pending') before invoking the service —
 * no real network, no Whish account.
 */
export class FakeWhishClient {
  configured = true;
  status: WhishCollectStatus = 'success';
  payerPhoneNumber: string | null = '+96170000000';
  isConfigured(): boolean {
    return this.configured;
  }
  getStatus(): Promise<{ collectStatus: WhishCollectStatus; payerPhoneNumber: string | null }> {
    return Promise.resolve({ collectStatus: this.status, payerPhoneNumber: this.payerPhoneNumber });
  }
}

// Pass-through cache: always recompute (no Redis). Keeps fee resolution real.
const fakeCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

const fakeAnalytics = {
  invalidateAll: async () => undefined,
  invalidateCompany: async () => undefined,
} as unknown as AnalyticsService;

const fakeRealtime = {
  company: () => undefined,
} as unknown as RealtimeService;

const fakeNotifications = {
  requestSubmitted: async () => undefined,
  requestResolved: async () => undefined,
  // Called by the payout/withdrawal cancel paths (release()). The real service
  // implements it; the stub must mirror every method the code-under-test calls,
  // else the `as unknown as` cast hides a "not a function" at runtime.
  clearAdminRequest: async () => undefined,
} as unknown as NotificationsService;

const fakeCounter = { inc: () => undefined } as unknown as Counter<string>;

// CRM dispatch is a fire-and-forget side effect; no-op it in the harness.
const fakeCrm = {
  emitFromTransaction: () => undefined,
  emitWhish: () => undefined,
  emitWithdrawal: () => undefined,
} as unknown as CrmDispatchService;

// Withdrawal auto-approval ships OFF, so mirror that here: every withdrawal is
// treated as needing a human. Read post-commit by `resolveManualReason()`.
const fakeAutoApprovalConfig = {
  getState: async () => ({
    enabled: false,
    enabledAt: null,
    holdSeconds: 30,
    maxAutoApproveAmount: '500',
    circuitBreakerTrippedAt: null,
    consecutiveFailures: 0,
    failureThreshold: 3,
    updatedAt: null,
  }),
} as unknown as AutoApprovalConfigStore;

const fakeTransfers = {
  isW2WEnabled: () => false,
  sessionStatus: async () => ({ configured: false }),
} as unknown as WhishTransfersService;

// Whish settlement side-effects not under test here (webhook delivery, tx logs),
// plus a minimal config the service reads. The reconcile path never touches
// these on the asserted branches; they exist only to satisfy construction.
const fakeWhishWebhooks = { deliverPaid: async () => undefined } as unknown as WhishWebhookService;
const fakeTxLogs = { record: () => undefined } as unknown as TransactionLogsService;
const fakeWhishConfig = {
  get: (key: string) => (key === 'WHISH_ENABLED_CURRENCIES' ? ['USD'] : undefined),
} as unknown as ConfigService<Env, true>;

export function buildHarness(): Harness {
  // Guardrail: never let the integration suite touch a non-test database.
  if (!process.env.DATABASE_URL?.includes('_test')) {
    throw new Error(
      `refusing to run integration tests against non-test DATABASE_URL=${process.env.DATABASE_URL}`,
    );
  }

  const prisma = new PrismaService();
  const ledger = new LedgerService(prisma, fakeCache);
  const wallets = new WalletsService(prisma);
  const resolver = new CommissionResolverService();
  const repo = new CommissionsRepository(fakeCache);
  const fees = new FeesService(resolver, repo);

  const transactions = new TransactionsService(
    prisma,
    resolver,
    repo,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeCounter, // txn_ingest_total
    fakeCounter, // txn_ingest_no_rule_total
    fakeCache,
    fakeCrm,
  );
  const withdrawals = new WithdrawalsService(
    prisma,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeNotifications,
    fakeCache,
    fees,
    fakeCrm,
    fakeAutoApprovalConfig,
    fakeTransfers,
  );
  const payouts = new PayoutsService(
    prisma,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeNotifications,
    fakeCache,
    fees,
  );
  const loads = new LoadsService(
    prisma,
    ledger,
    wallets,
    fakeAnalytics,
    fakeRealtime,
    fakeNotifications,
    fakeCache,
    fees,
  );

  const whishClient = new FakeWhishClient();
  const whish = new WhishPaymentsService(
    prisma,
    whishClient as unknown as WhishClient,
    fakeWhishConfig,
    transactions,
    fakeWhishWebhooks,
    resolver,
    repo,
    fakeRealtime,
    fakeCrm,
    fakeTxLogs,
  );

  return { prisma, transactions, withdrawals, payouts, loads, ledger, wallets, whish, whishClient };
}

// ---- unique-id helpers (tests isolate by company, so ids must not collide) ----
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const USD = 'USD';

export interface CompanyFixture {
  companyId: string;
  userId: string;
}

/** Create an ACTIVE company plus a COMPANY_OWNER user (for requestedById FKs). */
export async function createCompany(h: Harness): Promise<CompanyFixture> {
  const slug = `it-co-${uniq()}`;
  return h.prisma.runAsAdmin(async (tx) => {
    const company = await tx.company.create({
      data: { name: slug, slug, defaultCurrency: USD },
    });
    const user = await tx.user.create({
      data: {
        email: `${slug}@example.test`,
        passwordHash: 'x', // never authenticated in these tests
        role: UserRole.COMPANY_OWNER,
        companyId: company.id,
      },
    });
    return { companyId: company.id, userId: user.id };
  });
}

/** Create an ACTIVE source and opt the company into it (the ingest gate). */
export async function createEnabledSource(h: Harness, companyId: string): Promise<string> {
  const code = `it-src-${uniq()}`;
  return h.prisma.runAsAdmin(async (tx) => {
    const source = await tx.source.create({ data: { name: code, code } });
    await tx.companySource.create({
      data: { companyId, sourceId: source.id, enabled: true },
    });
    return source.id;
  });
}

export type FlowOp = 'TRANSACTION' | 'WITHDRAWAL' | 'PAYOUT' | 'LOAD';

/** Add a company-scoped percentage fee rule (DEDUCTED) for an operation type. */
export async function addFlowFee(
  h: Harness,
  companyId: string,
  operationType: FlowOp,
  percent: string,
): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.commissionRule.create({
      data: {
        companyId,
        sourceId: null,
        operationType,
        feeApplication: 'DEDUCTED',
        minAmount: '0.00000001',
        maxAmount: '100000000',
        commissionType: 'PERCENTAGE',
        commissionValue: percent,
        priority: 100,
        active: true,
      },
    }),
  );
}

/**
 * TRANSACTION fee. Ingest must price every transaction, so an ingest test
 * needs a matching rule (unlike the money-out/in flows, where a missing rule
 * just means "free").
 */
export async function addTransactionFee(
  h: Harness,
  companyId: string,
  percent: string,
): Promise<void> {
  await addFlowFee(h, companyId, 'TRANSACTION', percent);
}

export function ingestInput(
  companyId: string,
  amount: string,
  extra?: Partial<IngestTransactionInput>,
): IngestTransactionInput {
  return {
    companyId,
    externalTransactionId: `ext-${uniq()}`,
    amount,
    currency: USD,
    payload: {},
    ...extra,
  };
}

/** A valid CASH payout (the simplest member of the create-payout union). */
function cashPayout(): CashPayoutDetails {
  return {
    method: 'CASH',
    recipientName: 'Test Payee',
    recipientPhone: '+9610000000',
    pickupLocation: 'Test Branch',
  };
}

export function cashWithdrawalInput(amount: string): CreateWithdrawalInput {
  return { amount, currency: USD, payout: cashPayout() };
}

export function payoutInput(amount: string): CreatePayoutInput {
  return { amount, currency: USD, payout: cashPayout() };
}

export function loadInput(amount: string): CreateLoadInput {
  return { amount, currency: USD, payout: cashPayout() };
}

/**
 * A consistency snapshot for one (company, currency), read under the company's
 * own RLS scope. All figures are derived from the ledger so a test can assert
 * the wallet matches its ledger projection.
 */
export interface Snapshot {
  /** Σ all DEBIT == Σ all CREDIT  ⇒ the books balance. */
  balanced: boolean;
  totalDebit: string;
  totalCredit: string;
  /** Credit-normal projections (Σcredit − Σdebit) per account. */
  availableLedger: string;
  reservedLedger: string;
  /** Debit-normal: positive ⇒ company owes the platform. */
  receivableLedger: string;
  wallet: { available: string; reserved: string; pending: string } | null;
}

export async function snapshot(
  h: Harness,
  companyId: string,
  currency: string = USD,
): Promise<Snapshot> {
  return h.prisma.runAsScoped(companyId, async (tx) => {
    const entries = await tx.ledgerEntry.findMany({ where: { companyId, currency } });
    const w = await tx.wallet.findUnique({
      where: { companyId_currency: { companyId, currency } },
    });

    let totalDebit = Money.zero();
    let totalCredit = Money.zero();
    const credit: Record<string, Money> = {};
    const debit: Record<string, Money> = {};
    for (const e of entries) {
      const amt = Money.of(e.amount.toString());
      if (e.direction === 'DEBIT') {
        totalDebit = totalDebit.add(amt);
        debit[e.accountType] = (debit[e.accountType] ?? Money.zero()).add(amt);
      } else {
        totalCredit = totalCredit.add(amt);
        credit[e.accountType] = (credit[e.accountType] ?? Money.zero()).add(amt);
      }
    }
    const net = (type: string) => (credit[type] ?? Money.zero()).sub(debit[type] ?? Money.zero());

    return {
      balanced: totalDebit.eq(totalCredit),
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
      availableLedger: net('AVAILABLE').toString(),
      reservedLedger: net('RESERVED').toString(),
      receivableLedger: net('RECEIVABLE').mul(-1).toString(),
      wallet: w
        ? {
            available: Money.of(w.availableBalance.toString()).toString(),
            reserved: Money.of(w.reservedBalance.toString()).toString(),
            pending: Money.of(w.pendingBalance.toString()).toString(),
          }
        : null,
    };
  });
}
