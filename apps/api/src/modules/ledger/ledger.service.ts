import { Injectable, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import {
  Money,
  MONEY_SCALE,
  type LedgerAccountType,
  type LedgerDirection,
  type LedgerEntryResponse,
  type ListLedgerEntriesQuery,
  type PaginatedResponse,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { LedgerScaleError, ValidationError } from '../../common/errors/domain.error';

// The per-(company,filter) ledger COUNT is cached briefly so paging reuses it and
// a high-volume tenant's COUNT(*) over the (largest) ledger table doesn't re-run
// on every page load. The total can lag by up to this window; the rows are always
// live. Mirrors the transactions list — deliberately NOT invalidated on write.
const LIST_COUNT_CACHE_TTL_SEC = 30;
// Reject offsets beyond this — deep paging should narrow with filters instead of
// scanning, mirroring the transactions/activity lists.
const MAX_LIST_OFFSET = 50_000;

// CSV export streams rows in keyset chunks — each chunk a short, RLS-scoped query
// written straight to the response — so memory is bounded to one chunk and there
// is no row cap. Mirrors the transactions export.
const CSV_EXPORT_CHUNK = 1000;

/**
 * One side of a ledger transaction. We always write entries in
 * balanced pairs (or larger sets) where total DEBITs == total CREDITs
 * within the same call.
 */
export interface LedgerEntryInput {
  companyId: string;
  transactionId?: string;
  // At most one of these three is set. The originating process (the
  // withdrawal, payout, or load) ties the ledger entry back to a user-
  // facing row in its own table.
  withdrawalId?: string;
  payoutId?: string;
  loadId?: string;
  accountType: LedgerAccountType;
  direction: LedgerDirection;
  amount: Money;
  currency: string;
  metadata?: Record<string, unknown>;
}

/**
 * LedgerService is a thin helper that enforces:
 *   - amounts > 0
 *   - entries are written in a balanced set (sum debits == sum credits per currency)
 *
 * Append-only enforcement happens at the DB layer (triggers from
 * migration 0002).
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Write a balanced set of entries inside the given Prisma transaction.
   * The caller is responsible for opening the transaction with the right
   * RLS GUC via PrismaService.runAsTenant / runAsAdmin.
   */
  async writeEntries(tx: PrismaClient, entries: LedgerEntryInput[]): Promise<void> {
    if (entries.length === 0) return;

    // ASSERT the scale; never silently round it.
    //
    // This used to round each leg here, which reads like defence but is the exact
    // mechanism that books an unbalanced set: if legs partition a total, then
    // `Σ round(legᵢ)` can differ from `round(Σ legᵢ)` (take 0.005 + 0.005 at 2dp —
    // both legs round to 0.00 while the total rounds to 0.01). Rounding also can't
    // fix an over-scale amount safely, because the "fix" changes the money.
    //
    // The contract for every caller is therefore: quantize your INPUTS once
    // (the gross amount and the fee), then derive every remaining leg by exact
    // subtraction, so the set balances by construction. Reaching this throw is a
    // programming error in a builder, not bad user input — it should be
    // unreachable, and it must page rather than be silently absorbed.
    for (const e of entries) {
      if (!e.amount.isAtScale()) {
        throw new LedgerScaleError(
          `ledger leg for ${e.accountType}/${e.direction} carries more than ${MONEY_SCALE} decimal places: ` +
            `${e.amount.toExactString()} — the caller must quantize its inputs (Money.fromDb) and derive ` +
            `the remaining legs by subtraction.`,
        );
      }
      if (!e.amount.isPositive()) {
        throw new Error(
          `ledger amount must be positive at ${MONEY_SCALE}dp: got ${e.amount.toString()}`,
        );
      }
    }

    // Balance check on the amounts AS GIVEN — now identical to what is persisted,
    // because nothing rounds between here and createMany.
    const byCurrency = new Map<string, { dr: Money; cr: Money }>();
    for (const e of entries) {
      const slot = byCurrency.get(e.currency) ?? { dr: Money.zero(), cr: Money.zero() };
      if (e.direction === 'DEBIT') slot.dr = slot.dr.add(e.amount);
      else slot.cr = slot.cr.add(e.amount);
      byCurrency.set(e.currency, slot);
    }
    for (const [currency, { dr, cr }] of byCurrency.entries()) {
      if (!dr.eq(cr)) {
        throw new Error(
          `unbalanced ledger entries for ${currency}: debits=${dr.toString()} credits=${cr.toString()}`,
        );
      }
    }

    // Insert as a single createMany call for atomicity.
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        companyId: e.companyId,
        transactionId: e.transactionId ?? null,
        withdrawalId: e.withdrawalId ?? null,
        payoutId: e.payoutId ?? null,
        loadId: e.loadId ?? null,
        accountType: e.accountType,
        direction: e.direction,
        amount: e.amount.toString(),
        currency: e.currency,
        metadata: (e.metadata ?? null) as Prisma.InputJsonValue,
      })),
    });
  }

  /**
   * Outstanding RECEIVABLE (debt owed by the company to the platform) for a
   * (company, currency), computed from the ledger: Σ(DEBIT) − Σ(CREDIT). A
   * positive result means the company owes the platform. Call inside an open
   * transaction (RLS context already set by the caller).
   */
  async outstandingReceivable(
    tx: PrismaClient,
    companyId: string,
    currency: string,
  ): Promise<Money> {
    const rows = await tx.ledgerEntry.groupBy({
      by: ['direction'],
      where: { companyId, currency, accountType: 'RECEIVABLE' },
      _sum: { amount: true },
    });
    let debit = Money.zero();
    let credit = Money.zero();
    for (const r of rows) {
      const amt = Money.of((r._sum.amount ?? 0).toString());
      if (r.direction === 'DEBIT') debit = debit.add(amt);
      else credit = credit.add(amt);
    }
    return debit.sub(credit);
  }

  /**
   * Read ledger entries for a company. Append-only model means this is a
   * pure read; suitable for reconciliation, audits, and the wallet detail
   * page on the company dashboard.
   */
  /** Translate a ledger list query into a Prisma where-clause (shared by list + export). */
  private buildWhere(
    companyId: string,
    query: ListLedgerEntriesQuery,
  ): Prisma.LedgerEntryWhereInput {
    const where: Prisma.LedgerEntryWhereInput = { companyId };
    if (query.currency) where.currency = query.currency;
    if (query.accountType) where.accountType = query.accountType;
    if (query.transactionId) where.transactionId = query.transactionId;
    if (query.withdrawalId) where.withdrawalId = query.withdrawalId;
    if (query.payoutId) where.payoutId = query.payoutId;
    if (query.loadId) where.loadId = query.loadId;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }
    return where;
  }

  async listByCompany(
    companyId: string,
    query: ListLedgerEntriesQuery,
  ): Promise<PaginatedResponse<LedgerEntryResponse>> {
    return this.prisma.runAsScoped(companyId, async (tx) => {
      const where = this.buildWhere(companyId, query);

      const skip = (query.page - 1) * query.pageSize;
      if (skip > MAX_LIST_OFFSET) {
        throw new ValidationError(
          'Page too deep to scan efficiently. Narrow the results with filters (currency, account type, date range).',
        );
      }
      const countKey =
        `list-count:ledger:${companyId}:${query.currency ?? ''}:${query.accountType ?? ''}` +
        `:${query.transactionId ?? ''}:${query.withdrawalId ?? ''}:${query.payoutId ?? ''}` +
        `:${query.loadId ?? ''}:${query.from ?? ''}:${query.to ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.ledgerEntry.findMany({
          where,
          // All lines of one transaction share the same createdAt (written in a
          // single createMany), so ordering by createdAt alone leaves their
          // relative order to the DB heap — which is why the same transaction's
          // lines render in a different order each time. Add a stable, meaningful
          // tiebreak so every transaction's lines always read the same way:
          // newest first, then DEBIT before CREDIT, then by account type (enum
          // order: AVAILABLE, PENDING, RESERVED, FEE, EXTERNAL), then id as a
          // final total-order guarantee. For a standard ingest this yields
          // EXTERNAL(DEBIT) → AVAILABLE(CREDIT) → FEE(CREDIT) every time.
          orderBy: [
            { createdAt: 'desc' },
            { direction: 'asc' },
            { accountType: 'asc' },
            { id: 'asc' },
          ],
          skip,
          take: query.pageSize,
        }),
        // singleFlight:false — this runs inside the caller's tx; never block on the
        // cross-request poll (which would pin this pooled connection). Compute on miss.
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.ledgerEntry.count({ where }), {
          singleFlight: false,
        }),
      ]);

      return {
        data: rows.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          transactionId: r.transactionId,
          withdrawalId: r.withdrawalId,
          payoutId: r.payoutId,
          loadId: r.loadId,
          accountType: r.accountType,
          direction: r.direction,
          amount: r.amount.toString(),
          currency: r.currency.trim(),
          metadata: (r.metadata as Record<string, unknown> | null) ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        meta: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      };
    });
  }

  /**
   * Stream ALL ledger entries matching the filters as CSV (no row cap), walked in
   * keyset chunks over (createdAt desc, id desc). Each chunk is its own short
   * RLS-scoped query, emitted as produced — memory bounded to one chunk, no long
   * transaction held open. Companies use this to reconcile a period offline.
   */
  streamCsv(companyId: string, query: ListLedgerEntriesQuery): StreamableFile {
    const header = [
      'id',
      'created_at',
      'account_type',
      'direction',
      'amount',
      'currency',
      'transaction_id',
      'withdrawal_id',
      'payout_id',
      'load_id',
    ];

    const where = this.buildWhere(companyId, query);
    const prisma = this.prisma;

    async function* generate(): AsyncGenerator<string> {
      // Lead with a UTF-8 BOM so Excel reads the file as UTF-8 (else “•” etc. shows as mojibake). Matches the shared CSV exporter.
      yield '\uFEFF' + header.join(',') + '\n';
      let cursor: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const pageWhere: Prisma.LedgerEntryWhereInput = cursor
          ? {
              ...where,
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : where;
        const page = await prisma.runAsScoped(companyId, (tx) =>
          tx.ledgerEntry.findMany({
            where: pageWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: CSV_EXPORT_CHUNK,
          }),
        );
        if (page.length === 0) break;
        let buf = '';
        for (const r of page) {
          buf +=
            [
              r.id,
              r.createdAt.toISOString(),
              r.accountType,
              r.direction,
              // EXACT, deliberately NOT quantized — unlike every other export.
              // ledger_entries keeps its historical scale forever (the ledger is
              // append-only), and rounding each leg independently would make an
              // exported set's debit and credit columns stop tying out: the audit
              // artifact would contradict the record it exists to prove. New rows
              // are all at scale, so this prints identically for them.
              r.amount.toString(),
              r.currency.trim(),
              r.transactionId ?? '',
              r.withdrawalId ?? '',
              r.payoutId ?? '',
              r.loadId ?? '',
            ].join(',') + '\n';
        }
        yield buf;
        if (page.length < CSV_EXPORT_CHUNK) break;
        const last = page[page.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
    }

    return new StreamableFile(Readable.from(generate()), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="ledger-${Date.now()}.csv"`,
    });
  }
}
