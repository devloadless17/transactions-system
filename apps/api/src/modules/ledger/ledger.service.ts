import { Injectable, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import {
  Money,
  type LedgerAccountType,
  type LedgerDirection,
  type LedgerEntryResponse,
  type ListLedgerEntriesQuery,
  type PaginatedResponse,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { ValidationError } from '../../common/errors/domain.error';

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

    // Round every amount to the 8dp money scale up front, so the balance check
    // and the value actually persisted are the exact same number. Otherwise a
    // caller that hands us an unrounded Money (e.g. from a multiply/divide) could
    // pass the in-memory balance check while Postgres rounds the Decimal(20,8)
    // column differently on insert — silently booking an off-by-1e-8 imbalance —
    // or persist a line that rounds to 0 and trips the amount>0 CHECK as a 500.
    // All current callers already pass <=8dp amounts, so this is a no-op for
    // them and pure defense-in-depth for any future flow.
    const rounded = entries.map((e) => ({ ...e, amount: e.amount.round() }));

    // Validate amounts (on the rounded value that will be stored).
    for (const e of rounded) {
      if (!e.amount.isPositive()) {
        throw new Error(`ledger amount must be positive at 8dp: got ${e.amount.toString()}`);
      }
    }

    // Balance check per currency (on the rounded amounts that will be persisted).
    const byCurrency = new Map<string, { dr: Money; cr: Money }>();
    for (const e of rounded) {
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
      data: rounded.map((e) => ({
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
