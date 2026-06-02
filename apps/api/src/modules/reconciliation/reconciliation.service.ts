import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import { Money } from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

// How often the detective control runs. The ledger is the source of truth; the
// wallet is a derived projection, so this job proves they still agree.
const RECONCILE_INTERVAL_MS = 15 * 60_000; // 15 minutes
// Cap how many discrepancies we persist into a single audit row.
const MAX_AUDITED_DISCREPANCIES = 50;

// Only these ledger accounts have a wallet projection. FEE and EXTERNAL are
// platform/counterparty accounts with no corresponding wallet column.
const WALLET_ACCOUNTS = new Set(['AVAILABLE', 'PENDING', 'RESERVED']);

interface BalanceTriple {
  wallet: string;
  ledger: string;
  delta: string;
}

export interface WalletDiscrepancy {
  companyId: string;
  currency: string;
  /** false when the ledger has entries for a (company,currency) but no wallet row exists. */
  walletExists: boolean;
  available: BalanceTriple;
  pending: BalanceTriple;
  reserved: BalanceTriple;
}

/** Outstanding debt a company owes the platform (debit-normal RECEIVABLE balance). */
export interface ReceivableBalance {
  companyId: string;
  currency: string;
  /** Σ(DEBIT) − Σ(CREDIT) over RECEIVABLE; > 0 means the company owes the platform. */
  outstanding: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  walletsChecked: number;
  divergentCount: number;
  discrepancies: WalletDiscrepancy[];
  /** Non-zero outstanding receivables (debts created by under-funded reversals). */
  receivables: ReceivableBalance[];
}

/** Raw shape of a `ledger_entries` group-sum row, decoupled from Prisma types. */
export interface LedgerSumRow {
  companyId: string;
  currency: string;
  accountType: string;
  direction: string; // 'DEBIT' | 'CREDIT'
  sum: string; // signed-magnitude (always positive); direction carries the sign
}

/** Raw shape of a `wallets` row, decoupled from Prisma types. */
export interface WalletRow {
  companyId: string;
  currency: string;
  availableBalance: string;
  pendingBalance: string;
  reservedBalance: string;
}

type LedgerSums = { available: Money; pending: Money; reserved: Money };

const zeroSums = (): LedgerSums => ({
  available: Money.zero(),
  pending: Money.zero(),
  reserved: Money.zero(),
});

// Currency is CHAR(3) (blank-padded) on both tables; trim so the keys match.
const keyOf = (companyId: string, currency: string): string => `${companyId}::${currency.trim()}`;

/**
 * Pure comparison: fold the ledger sums per (company, currency) and compare to
 * the wallet projection. For each wallet account the invariant is
 *   wallet.<balance> === Σ(CREDIT) − Σ(DEBIT)  over that account's ledger lines.
 * Exported so it can be unit-tested without a database.
 */
export function buildReconciliationReport(
  ledgerRows: LedgerSumRow[],
  wallets: WalletRow[],
  checkedAt: string,
): ReconciliationReport {
  const ledgerByKey = new Map<string, LedgerSums>();
  for (const row of ledgerRows) {
    if (!WALLET_ACCOUNTS.has(row.accountType)) continue;
    const key = keyOf(row.companyId, row.currency);
    const slot = ledgerByKey.get(key) ?? zeroSums();
    const magnitude = Money.of(row.sum || '0');
    const signed = row.direction === 'CREDIT' ? magnitude : magnitude.mul(-1);
    if (row.accountType === 'AVAILABLE') slot.available = slot.available.add(signed);
    else if (row.accountType === 'PENDING') slot.pending = slot.pending.add(signed);
    else slot.reserved = slot.reserved.add(signed);
    ledgerByKey.set(key, slot);
  }

  const walletByKey = new Map<string, WalletRow>();
  for (const w of wallets) walletByKey.set(keyOf(w.companyId, w.currency), w);

  const keys = new Set<string>([...ledgerByKey.keys(), ...walletByKey.keys()]);
  const discrepancies: WalletDiscrepancy[] = [];

  for (const key of keys) {
    const led = ledgerByKey.get(key) ?? zeroSums();
    const w = walletByKey.get(key);
    const sep = key.indexOf('::');
    const companyId = key.slice(0, sep);
    const currency = key.slice(sep + 2);

    const wa = Money.of(w?.availableBalance ?? '0');
    const wp = Money.of(w?.pendingBalance ?? '0');
    const wr = Money.of(w?.reservedBalance ?? '0');

    const ok = !!w && wa.eq(led.available) && wp.eq(led.pending) && wr.eq(led.reserved);
    if (ok) continue;

    discrepancies.push({
      companyId,
      currency,
      walletExists: !!w,
      available: {
        wallet: wa.toString(),
        ledger: led.available.toString(),
        delta: wa.sub(led.available).toString(),
      },
      pending: {
        wallet: wp.toString(),
        ledger: led.pending.toString(),
        delta: wp.sub(led.pending).toString(),
      },
      reserved: {
        wallet: wr.toString(),
        ledger: led.reserved.toString(),
        delta: wr.sub(led.reserved).toString(),
      },
    });
  }

  return {
    checkedAt,
    walletsChecked: keys.size,
    divergentCount: discrepancies.length,
    discrepancies,
    receivables: foldReceivables(ledgerRows),
  };
}

/**
 * Fold RECEIVABLE ledger lines into outstanding debt per (company, currency).
 * RECEIVABLE is debit-normal (a reversal DEBITs it; a future repayment CREDITs
 * it), so outstanding = Σ(DEBIT) − Σ(CREDIT). Only non-zero balances returned.
 * Pure and exported for unit testing.
 */
export function foldReceivables(ledgerRows: LedgerSumRow[]): ReceivableBalance[] {
  const byKey = new Map<string, Money>();
  for (const row of ledgerRows) {
    if (row.accountType !== 'RECEIVABLE') continue;
    const key = keyOf(row.companyId, row.currency);
    const magnitude = Money.of(row.sum || '0');
    const signed = row.direction === 'DEBIT' ? magnitude : magnitude.mul(-1);
    byKey.set(key, (byKey.get(key) ?? Money.zero()).add(signed));
  }
  const out: ReceivableBalance[] = [];
  for (const [key, amt] of byKey) {
    if (amt.isZero()) continue;
    const sep = key.indexOf('::');
    out.push({
      companyId: key.slice(0, sep),
      currency: key.slice(sep + 2),
      outstanding: amt.toString(),
    });
  }
  return out;
}

/**
 * Detective control for the ledger↔wallet invariant (the spendable wallet
 * balance is a parallel projection of the append-only ledger). Runs on an
 * interval and on demand, exposes the divergent-wallet count as a Prometheus
 * gauge, and writes an audit row when a divergence is detected so it cannot go
 * unnoticed. It does NOT auto-freeze wallets — freezing is an explicit policy
 * decision and would require a schema + cross-flow enforcement change.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastReport?: ReconciliationReport;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectMetric('ledger_wallet_divergent') private readonly divergentGauge: Gauge<string>,
    @InjectMetric('ledger_receivable_outstanding')
    private readonly receivableGauge: Gauge<string>,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), RECONCILE_INTERVAL_MS);
    // Don't keep the event loop alive just for this ticker.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getLastReport(): ReconciliationReport | undefined {
    return this.lastReport;
  }

  /**
   * Outstanding receivables (company debts), computed on demand with a focused
   * query — cheaper than a full reconciliation scan, suitable for an operator
   * "who owes us" view.
   */
  async listReceivables(): Promise<ReceivableBalance[]> {
    return this.prisma.runAsAdmin(async (tx) => {
      const grouped = await tx.ledgerEntry.groupBy({
        by: ['companyId', 'currency', 'direction'],
        where: { accountType: 'RECEIVABLE' },
        _sum: { amount: true },
      });
      const rows: LedgerSumRow[] = grouped.map((g) => ({
        companyId: g.companyId,
        currency: g.currency,
        accountType: 'RECEIVABLE',
        direction: g.direction,
        sum: (g._sum.amount ?? 0).toString(),
      }));
      return foldReceivables(rows);
    });
  }

  /** Run a full reconciliation: compute, publish the gauge, alert + audit on divergence. */
  async reconcileAll(opts: { actorId?: string | null } = {}): Promise<ReconciliationReport> {
    const report = await this.computeReport();
    this.lastReport = report;
    this.divergentGauge.set(report.divergentCount);

    // Publish outstanding receivables per currency (reset first so a currency
    // that drops to zero doesn't leave a stale label). Gauge value is float —
    // fine for observability; the authoritative figures live in the ledger.
    const byCurrency = new Map<string, Money>();
    for (const r of report.receivables) {
      byCurrency.set(
        r.currency,
        (byCurrency.get(r.currency) ?? Money.zero()).add(Money.of(r.outstanding)),
      );
    }
    this.receivableGauge.reset();
    for (const [currency, total] of byCurrency) {
      this.receivableGauge.set({ currency }, Number(total.toString()));
    }

    if (report.divergentCount > 0) {
      this.logger.error(
        `LEDGER↔WALLET DIVERGENCE: ${report.divergentCount}/${report.walletsChecked} wallet(s) do not match the ledger`,
      );
      await this.audit
        .record({
          actorId: opts.actorId ?? null,
          action: 'reconciliation.divergence_detected',
          entityType: 'wallet',
          metadata: {
            divergentCount: report.divergentCount,
            walletsChecked: report.walletsChecked,
            discrepancies: report.discrepancies.slice(0, MAX_AUDITED_DISCREPANCIES),
          },
        })
        .catch((e) =>
          this.logger.warn(`failed to record reconciliation audit: ${(e as Error).message}`),
        );
    } else {
      this.logger.log(`Reconciliation OK: ${report.walletsChecked} wallet(s) match the ledger`);
    }

    return report;
  }

  private async computeReport(): Promise<ReconciliationReport> {
    return this.prisma.runAsAdmin(async (tx) => {
      const grouped = await tx.ledgerEntry.groupBy({
        by: ['companyId', 'currency', 'accountType', 'direction'],
        _sum: { amount: true },
      });
      const wallets = await tx.wallet.findMany();

      const ledgerRows: LedgerSumRow[] = grouped.map((g) => ({
        companyId: g.companyId,
        currency: g.currency,
        accountType: g.accountType,
        direction: g.direction,
        sum: (g._sum.amount ?? 0).toString(),
      }));
      const walletRows: WalletRow[] = wallets.map((w) => ({
        companyId: w.companyId,
        currency: w.currency,
        availableBalance: w.availableBalance.toString(),
        pendingBalance: w.pendingBalance.toString(),
        reservedBalance: w.reservedBalance.toString(),
      }));

      return buildReconciliationReport(ledgerRows, walletRows, new Date().toISOString());
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileAll();
    } catch (err) {
      this.logger.warn(`Reconciliation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
