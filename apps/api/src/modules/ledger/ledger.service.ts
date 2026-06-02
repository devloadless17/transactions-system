import { Injectable } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write a balanced set of entries inside the given Prisma transaction.
   * The caller is responsible for opening the transaction with the right
   * RLS GUC via PrismaService.runAsTenant / runAsAdmin.
   */
  async writeEntries(tx: PrismaClient, entries: LedgerEntryInput[]): Promise<void> {
    if (entries.length === 0) return;

    // Validate amounts.
    for (const e of entries) {
      if (!e.amount.isPositive()) {
        throw new Error(`ledger amount must be positive: got ${e.amount.toString()}`);
      }
    }

    // Balance check per currency.
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
  async listByCompany(
    companyId: string,
    query: ListLedgerEntriesQuery,
  ): Promise<PaginatedResponse<LedgerEntryResponse>> {
    return this.prisma.runAsScoped(companyId, async (tx) => {
      const where: Prisma.LedgerEntryWhereInput = { companyId };
      if (query.currency) where.currency = query.currency;
      if (query.accountType) where.accountType = query.accountType;
      if (query.transactionId) where.transactionId = query.transactionId;
      if (query.withdrawalId) where.withdrawalId = query.withdrawalId;
      if (query.payoutId) where.payoutId = query.payoutId;
      if (query.loadId) where.loadId = query.loadId;

      const skip = (query.page - 1) * query.pageSize;
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
        tx.ledgerEntry.count({ where }),
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
}
