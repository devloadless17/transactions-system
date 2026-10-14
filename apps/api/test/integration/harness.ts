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
  SetNetworkFeeConfigInput,
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
import { CompaniesService } from '../../src/modules/companies/companies.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import type { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import type { RealtimeService } from '../../src/modules/realtime/realtime.service';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { CrmDispatchService } from '../../src/modules/crm/crm-dispatch.service';
import type { AutoApprovalConfigStore } from '../../src/modules/withdrawals/auto-approval-config.store';
import type { WhishTransfersService } from '../../src/modules/whish/whish-transfers.service';
import type {
  PostPaymentInput,
  WhishClient,
  WhishCollectStatus,
} from '../../src/modules/whish/whish.client';
import type { WhishWebhookService } from '../../src/modules/whish/whish-webhook.service';
import type {
  TransactionLogEntry,
  TransactionLogsService,
} from '../../src/modules/transaction-logs/transaction-logs.service';
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
  /** Records every CRM dispatch, so tests can assert WHICH event fired. */
  crm: FakeCrmDispatch;
  /** Every super-admin transaction-log entry written, in order. */
  txLogs: TransactionLogEntry[];
  /** Every admin "deposit refused — amount differs" alert raised, in order. */
  depositAlerts: Array<Record<string, unknown>>;
  /** The real company admin service — e.g. the network-fee config write path. */
  companies: CompaniesService;
}

/**
 * Controllable fake of the external Whish HTTP client. Tests drive settlement by
 * setting `.status` (any WhishCollectStatus — so `refunded`/`unknown` are covered
 * automatically) before invoking the service, and can force either upstream call
 * to throw via `failPostPaymentWith` / `failGetStatusWith` — no real network, no
 * Whish account.
 */
export class FakeWhishClient {
  configured = true;
  status: WhishCollectStatus = 'success';
  payerPhoneNumber: string | null = '+96170000000';
  /** Every postPayment call, so a test can assert the on-the-wire shape. */
  postPaymentCalls: PostPaymentInput[] = [];
  /** When set, the next postPayment/getStatus rejects with it. */
  failPostPaymentWith: Error | null = null;
  failGetStatusWith: Error | null = null;

  isConfigured(): boolean {
    return this.configured;
  }

  postPayment(input: PostPaymentInput): Promise<{ collectUrl: string }> {
    this.postPaymentCalls.push(input);
    if (this.failPostPaymentWith) return Promise.reject(this.failPostPaymentWith);
    return Promise.resolve({ collectUrl: `https://whish.example/collect/${input.externalId}` });
  }

  /** The externalId of every getStatus call, in order. */
  getStatusCalls: string[] = [];
  /** Per-externalId status overrides (falls back to `status`). */
  statusFor = new Map<string, WhishCollectStatus>();

  getStatus(input?: {
    currency: string;
    externalId: string;
  }): Promise<{ collectStatus: WhishCollectStatus; payerPhoneNumber: string | null }> {
    if (input) this.getStatusCalls.push(input.externalId);
    if (this.failGetStatusWith) return Promise.reject(this.failGetStatusWith);
    const override = input ? this.statusFor.get(input.externalId) : undefined;
    if (override) {
      return Promise.resolve({ collectStatus: override, payerPhoneNumber: this.payerPhoneNumber });
    }
    return Promise.resolve({ collectStatus: this.status, payerPhoneNumber: this.payerPhoneNumber });
  }

  /** Every refund call, so a test can assert Whish was asked exactly once. */
  refundCalls: Array<{ currency: string; externalId: string; refundReason: string }> = [];
  /** When set, refund rejects with it. */
  failRefundWith: Error | null = null;
  /** With failRefundWith: the refund still went through at Whish (its reply was lost). */
  refundTookEffect = false;

  /** The platform account balance getBalance reports. */
  balance = 1000;
  /**
   * What a refund takes out of the balance, given the payment amount. Defaults
   * to the full amount; a test can model Whish returning its collection fee.
   */
  refundDebit: (amount: number) => number = (amount) => amount;
  /** The amount behind each externalId, for refundDebit (set by the test). */
  amountFor = new Map<string, number>();

  getBalance(): Promise<{ balance: number }> {
    return Promise.resolve({ balance: this.balance });
  }

  /** Like Whish: a refund that goes through makes getStatus report `refunded`. */
  refund(input: {
    currency: string;
    externalId: string;
    refundReason: string;
  }): Promise<{ alreadyProcessed: boolean }> {
    this.refundCalls.push(input);
    if (!this.failRefundWith || this.refundTookEffect) {
      this.statusFor.set(input.externalId, 'refunded');
      this.balance -= this.refundDebit(this.amountFor.get(input.externalId) ?? 0);
    }
    if (this.failRefundWith) return Promise.reject(this.failRefundWith);
    return Promise.resolve({ alreadyProcessed: false });
  }
}

/** One CRM dispatch observed during a test. */
export interface RecordedCrmEvent {
  kind: 'whish' | 'transaction' | 'withdrawal';
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Recording CRM dispatcher. The real one is fire-and-forget over HTTP, but WHICH
 * event fires is load-bearing behaviour (a `transaction.failed` on a link that
 * may still be payable is a wrong signal to the company), so tests need to see
 * them rather than have them swallowed.
 */
export class FakeCrmDispatch {
  events: RecordedCrmEvent[] = [];
  emitWhish(payload: Record<string, unknown>): void {
    this.events.push({ kind: 'whish', event: String(payload.event), payload });
  }
  emitFromTransaction(txn: unknown, event: string): void {
    // The mapped transaction the real dispatcher builds its CRM body from.
    this.events.push({ kind: 'transaction', event, payload: txn as Record<string, unknown> });
  }
  emitWithdrawal(payload: Record<string, unknown>): void {
    this.events.push({ kind: 'withdrawal', event: String(payload.event), payload });
  }
  /** Every event name seen so far, in order. */
  names(): string[] {
    return this.events.map((e) => e.event);
  }
  reset(): void {
    this.events = [];
  }
}

// Pass-through cache: always recompute (no Redis). Keeps fee resolution real.
// tryLock dedupes like the real one (a held key returns null), so alert
// throttling is exercised; keys never expire within a test run.
const heldLocks = new Set<string>();
const fakeCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async tryLock(key: string): Promise<string | null> {
    if (heldLocks.has(key)) return null;
    heldLocks.add(key);
    return `lock:${key}`;
  },
} as unknown as CacheService;

const fakeAnalytics = {
  invalidateAll: async () => undefined,
  invalidateCompany: async () => undefined,
} as unknown as AnalyticsService;

const fakeRealtime = {
  company: () => undefined,
  admin: () => undefined,
} as unknown as RealtimeService;

/** Every withdrawalNeedsDecision call the services made (admin-attention.int-spec reads it). */
export const notifiedNeedsDecision: Array<{
  companyId: string;
  entityId: string;
  amount: string;
  currency: string;
}> = [];

const fakeNotifications = {
  requestSubmitted: async () => undefined,
  requestResolved: async () => undefined,
  // Called by the payout/withdrawal cancel paths (release()). The real service
  // implements it; the stub must mirror every method the code-under-test calls,
  // else the `as unknown as` cast hides a "not a function" at runtime.
  clearAdminRequest: async () => undefined,
  // Called by setAutoMeta when a withdrawal is first flagged needsReconcile.
  withdrawalNeedsDecision: async (p: (typeof notifiedNeedsDecision)[number]) => {
    notifiedNeedsDecision.push(p);
  },
} as unknown as NotificationsService;

const fakeCounter = { inc: () => undefined } as unknown as Counter<string>;

// Withdrawal auto-approval ships OFF, so mirror that here: every withdrawal is
// treated as needing a human. Read post-commit by `resolveManualReason()`.
const fakeAutoApprovalConfig = {
  simulationMode: false,
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

// Whish settlement side-effects not under test here (webhook delivery), plus a
// minimal config the service reads. The reconcile path never touches these on
// the asserted branches; they exist only to satisfy construction.
const fakeWhishWebhooks = { deliverPaid: async () => undefined } as unknown as WhishWebhookService;
const fakeWhishConfig = {
  get: (key: string) =>
    key === 'WHISH_ENABLED_CURRENCIES'
      ? ['USD']
      : key === 'WHISH_CALLBACK_BASE'
        ? 'https://api.example.test/v1'
        : key === 'WEB_ORIGIN'
          ? 'https://portal.example.test'
          : undefined,
} as unknown as ConfigService<Env, true>;

export function buildHarness(): Harness {
  // Guardrail: never let the integration suite touch a non-test database.
  if (!process.env.DATABASE_URL?.includes('_test')) {
    throw new Error(
      `refusing to run integration tests against non-test DATABASE_URL=${process.env.DATABASE_URL}`,
    );
  }

  const prisma = new PrismaService();
  // Per-harness (not module-level) so each test sees only its own CRM events.
  const crmRecorder = new FakeCrmDispatch();
  const fakeCrm = crmRecorder as unknown as CrmDispatchService;
  const ledger = new LedgerService(prisma, fakeCache);
  const wallets = new WalletsService(prisma);
  const resolver = new CommissionResolverService();
  const repo = new CommissionsRepository(fakeCache);
  const fees = new FeesService(resolver, repo);

  // Per-harness, so a test sees only the alerts its own ingests raised.
  const depositAlerts: Array<Record<string, unknown>> = [];
  const transactionNotifications = {
    ...(fakeNotifications as unknown as Record<string, unknown>),
    depositMismatch: async (p: Record<string, unknown>) => void depositAlerts.push(p),
  } as unknown as NotificationsService;
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
    fakeCounter, // txn_ingest_pricing_issue_total
    fakeCache,
    fakeCrm,
    transactionNotifications,
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
  // Per-harness, like the CRM recorder, so a test sees only its own log rows.
  const txLogs: TransactionLogEntry[] = [];
  const fakeTxLogs = {
    record: (entry: TransactionLogEntry) => void txLogs.push(entry),
  } as unknown as TransactionLogsService;
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

  const companies = new CompaniesService(prisma, fakeRealtime);

  return {
    prisma,
    transactions,
    withdrawals,
    payouts,
    loads,
    ledger,
    wallets,
    whish,
    whishClient,
    crm: crmRecorder,
    txLogs,
    depositAlerts,
    companies,
  };
}

// ---- unique-id helpers (tests isolate by company, so ids must not collide) ----
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const USD = 'USD';

/** The operator behind an admin action in tests (recorded, never looked up). */
export const ADMIN_ACTOR = 'it-admin';

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

/** Add a company-scoped percentage fee rule for an operation type. */
export async function addFlowFee(
  h: Harness,
  companyId: string,
  operationType: FlowOp,
  percent: string,
  feeApplication: 'DEDUCTED' | 'ON_TOP' = 'DEDUCTED',
): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.commissionRule.create({
      data: {
        companyId,
        sourceId: null,
        operationType,
        feeApplication,
        minAmount: '0.01',
        maxAmount: '100000000',
        commissionType: 'PERCENTAGE',
        commissionValue: percent,
        priority: 100,
        active: true,
      },
    }),
  );
}

/** Add a company-scoped FIXED-dollar fee rule for an operation type. */
export async function addFixedFlowFee(
  h: Harness,
  companyId: string,
  operationType: FlowOp,
  dollars: string,
  feeApplication: 'DEDUCTED' | 'ON_TOP' = 'DEDUCTED',
): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.commissionRule.create({
      data: {
        companyId,
        sourceId: null,
        operationType,
        feeApplication,
        minAmount: '0.01',
        maxAmount: '100000000',
        commissionType: 'FIXED',
        commissionValue: dollars,
        priority: 100,
        active: true,
      },
    }),
  );
}

/**
 * Configure a company's network fee through the REAL admin write path
 * (CompaniesService.setNetworkFee), exactly as the SUPER_ADMIN endpoint does.
 */
export async function setNetworkFee(
  h: Harness,
  companyId: string,
  config: SetNetworkFeeConfigInput,
): Promise<void> {
  await h.companies.setNetworkFee(companyId, config);
}

/**
 * The ledger legs booked for one row, as `ACCOUNT:DIRECTION → amount` (a leg
 * that was not booked is simply absent). Read under the company's RLS scope.
 */
export async function legsFor(
  h: Harness,
  companyId: string,
  ref: { transactionId?: string; withdrawalId?: string; payoutId?: string; loadId?: string },
): Promise<Record<string, string>> {
  return h.prisma.runAsScoped(companyId, async (tx) => {
    const rows = await tx.ledgerEntry.findMany({ where: { companyId, ...ref } });
    const legs: Record<string, Money> = {};
    for (const r of rows) {
      const key = `${r.accountType}:${r.direction}`;
      legs[key] = (legs[key] ?? Money.zero()).add(Money.of(r.amount.toString()));
    }
    return Object.fromEntries(Object.entries(legs).map(([k, v]) => [k, v.toString()]));
  });
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
  /** Platform revenue accounts (credit-normal): the commission and the network fee. */
  feeLedger: string;
  networkFeeLedger: string;
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
      feeLedger: net('FEE').toString(),
      networkFeeLedger: net('NETWORK_FEE').toString(),
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
