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
// Safety net for the windowed tick: every Nth tick runs a FULL reconcile, so a
// divergence the window could miss (a tx whose created_at predates the
// watermark but commits after the tick's read) is caught within at most N
// intervals. At the 15-min cadence, N=4 => a full sweep hourly.
const FULL_RECONCILE_EVERY_N_TICKS = 4;
// The reconciliation sweeps fold the whole ledger (full) or every active company's
// full history (windowed); at multi-million-row scale they exceed Prisma's 5s
// interactive-tx default and would abort — silently killing the only detective
// control. Give them a generous read timeout instead.
const RECONCILE_TX_TIMEOUT_MS = 120_000;

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
  // Cumulative known divergences keyed by `companyId::currency`, so the gauge
  // stays accurate between full runs even when a windowed tick only re-checks a
  // subset of companies. Seeded by each full `reconcileAll`.
  private readonly knownDivergent = new Map<string, WalletDiscrepancy>();
  // Start time of the last reconcile; the next windowed tick checks companies
  // with ledger activity after this. Null until the first (full) run.
  private lastTickAt: Date | null = null;
  private tickCount = 0;

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
    // Establish a baseline + gauge immediately rather than 15 minutes later, so a
    // post-deploy Prometheus scrape can't read a default-0 (falsely healthy)
    // divergence gauge during the startup window. tick() self-guards against overlap.
    void this.tick();
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

  /** Publish outstanding receivables per currency (reset first so a currency that
   * drops to zero doesn't leave a stale label). Gauge is float — fine for
   * observability; the authoritative figures live in the ledger. */
  private setReceivableGauge(receivables: ReceivableBalance[]): void {
    const byCurrency = new Map<string, Money>();
    for (const r of receivables) {
      byCurrency.set(
        r.currency,
        (byCurrency.get(r.currency) ?? Money.zero()).add(Money.of(r.outstanding)),
      );
    }
    this.receivableGauge.reset();
    for (const [currency, total] of byCurrency) {
      this.receivableGauge.set({ currency }, Number(total.toString()));
    }
  }

  /**
   * Re-check ONLY companies with ledger activity since `since` (the windowed
   * tick). A wallet can only drift alongside a ledger write, so the created_at
   * window catches divergences from committed writes; the rare case of a row
   * stamped before the watermark but committed after this tick's read is
   * backstopped by the periodic full reconcile (FULL_RECONCILE_EVERY_N_TICKS).
   * Updates the cumulative gauge + audits newly-divergent companies; the full
   * detailed report is refreshed on demand.
   */
  private async reconcileChanged(since: Date): Promise<void> {
    const result = await this.prisma.runAsAdmin(
      async (tx) => {
        const changed = await tx.ledgerEntry.groupBy({
          by: ['companyId'],
          where: { createdAt: { gt: since } },
        });
        const companyIds = changed.map((c) => c.companyId);
        if (companyIds.length === 0) return null;

        const grouped = await tx.ledgerEntry.groupBy({
          by: ['companyId', 'currency', 'accountType', 'direction'],
          where: { companyId: { in: companyIds } },
          _sum: { amount: true },
        });
        const wallets = await tx.wallet.findMany({ where: { companyId: { in: companyIds } } });
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
        const report = buildReconciliationReport(ledgerRows, walletRows, new Date().toISOString());
        return { report, companyIds };
      },
      { timeout: RECONCILE_TX_TIMEOUT_MS },
    );

    if (!result) {
      // No ledger activity this window — nothing can have drifted.
      this.divergentGauge.set(this.knownDivergent.size);
      return;
    }

    const { report, companyIds } = result;
    // Each changed company was re-checked in full: clear its prior known state,
    // then re-add whatever is currently divergent.
    const checked = new Set(companyIds);
    for (const key of [...this.knownDivergent.keys()]) {
      if (checked.has(key.slice(0, key.indexOf('::')))) this.knownDivergent.delete(key);
    }
    const newly: WalletDiscrepancy[] = [];
    for (const d of report.discrepancies) {
      const key = `${d.companyId}::${d.currency}`;
      if (!this.knownDivergent.has(key)) newly.push(d);
      this.knownDivergent.set(key, d);
    }
    this.divergentGauge.set(this.knownDivergent.size);
    // Receivables are platform-wide; refresh from the focused (indexed) query.
    const receivables = await this.listReceivables();
    this.setReceivableGauge(receivables);
    // Refresh the on-demand detail report from the cumulative known-divergent set
    // so GET /admin/reconciliation reflects a windowed-detected divergence right
    // away, instead of lagging until the next full reconcile (up to ~1h later).
    // (The first tick after boot is always a FULL reconcile, so lastReport is
    // already populated before any windowed tick runs.)
    this.lastReport = {
      checkedAt: report.checkedAt,
      walletsChecked: this.lastReport?.walletsChecked ?? this.knownDivergent.size,
      divergentCount: this.knownDivergent.size,
      discrepancies: [...this.knownDivergent.values()],
      receivables,
    };

    if (newly.length > 0) {
      this.logger.error(
        `LEDGER↔WALLET DIVERGENCE (windowed): ${newly.length} new among ${companyIds.length} changed company(ies)`,
      );
      await this.audit
        .record({
          actorId: null,
          action: 'reconciliation.divergence_detected',
          entityType: 'wallet',
          metadata: { newlyDivergent: newly.slice(0, MAX_AUDITED_DISCREPANCIES), windowed: true },
        })
        .catch((e) =>
          this.logger.warn(`failed to record reconciliation audit: ${(e as Error).message}`),
        );
    }
  }

  /** Run a full reconciliation: compute, publish gauges, alert + audit on divergence. */
  async reconcileAll(opts: { actorId?: string | null } = {}): Promise<ReconciliationReport> {
    const startedAt = new Date();
    const report = await this.computeReport();
    this.lastReport = report;
    this.lastTickAt = startedAt;

    // A full run is the authoritative snapshot — reset the cumulative map.
    this.knownDivergent.clear();
    for (const d of report.discrepancies) {
      this.knownDivergent.set(`${d.companyId}::${d.currency}`, d);
    }
    this.divergentGauge.set(report.divergentCount);
    this.setReceivableGauge(report.receivables);

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
    return this.prisma.runAsAdmin(
      async (tx) => {
        // The heavy table (ledger_entries — potentially millions of rows) is
        // reduced to bounded per-(company,currency,account,direction) sums by the
        // DB, never streamed into memory. Wallets are already one row per
        // (company,currency) — that IS the grain we reconcile at, so there's no
        // sum to push down; we just project the columns we compare (skip
        // id/timestamps) to keep the payload minimal.
        const grouped = await tx.ledgerEntry.groupBy({
          by: ['companyId', 'currency', 'accountType', 'direction'],
          _sum: { amount: true },
        });
        const wallets = await tx.wallet.findMany({
          select: {
            companyId: true,
            currency: true,
            availableBalance: true,
            pendingBalance: true,
            reservedBalance: true,
          },
        });

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
      },
      { timeout: RECONCILE_TX_TIMEOUT_MS },
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.tickCount += 1;
    const since = this.lastTickAt;
    const startedAt = new Date();
    try {
      if (!since || this.tickCount % FULL_RECONCILE_EVERY_N_TICKS === 0) {
        // First run after boot, then every Nth tick: a FULL reconcile that
        // re-establishes the baseline + cumulative map and backstops any
        // divergence the windowed path could have missed.
        await this.reconcileAll();
      } else {
        await this.reconcileChanged(since);
        // Advance the window to this tick's start; rows written during the run
        // overlap into the next window (safe) rather than being skipped.
        this.lastTickAt = startedAt;
      }
    } catch (err) {
      // Error, not warn: a failing reconcile means the ledger<->wallet detective
      // control isn't running, so balance divergence could go undetected. This
      // must be alertable, not buried.
      this.logger.error(`Reconciliation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
