import { Injectable, Logger } from '@nestjs/common';
import { Money, type WalletResponse } from '@app/shared';
import type { PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain.error';

export interface WalletDelta {
  available?: Money;
  pending?: Money;
  reserved?: Money;
}

const MAX_RETRY = 5;

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply a balance delta atomically, using the `version` column for
   * optimistic concurrency control. If a concurrent writer increments
   * the version first, we retry up to MAX_RETRY times.
   *
   * Use this INSIDE an already-open Prisma transaction (it doesn't open
   * one itself, because callers usually also write ledger entries in the
   * same atomic step).
   */
  async applyDelta(
    tx: PrismaClient,
    args: { companyId: string; currency: string; delta: WalletDelta },
  ): Promise<void> {
    let attempt = 0;
    while (attempt < MAX_RETRY) {
      attempt++;
      const wallet = await tx.wallet.findUnique({
        where: {
          companyId_currency: { companyId: args.companyId, currency: args.currency },
        },
      });
      if (!wallet) {
        // Auto-provision a wallet on first delta. Companies can ingest in
        // any supported currency; we create rows lazily.
        await tx.wallet.create({
          data: { companyId: args.companyId, currency: args.currency },
        });
        // Loop continues to read+update the new row.
        continue;
      }

      const newAvailable = Money.of(wallet.availableBalance.toString()).add(
        args.delta.available ?? Money.zero(),
      );
      const newPending = Money.of(wallet.pendingBalance.toString()).add(
        args.delta.pending ?? Money.zero(),
      );
      const newReserved = Money.of(wallet.reservedBalance.toString()).add(
        args.delta.reserved ?? Money.zero(),
      );

      // Reject if any balance would go negative — keeps DB CHECKs from raising.
      // Compare with Money/Decimal (never JS float) so a 20,8-digit balance can't
      // slip past the guard through float-precision loss.
      if (newAvailable.isNegative() || newPending.isNegative() || newReserved.isNegative()) {
        throw new ConflictError('Wallet balance would become negative', {
          companyId: args.companyId,
          currency: args.currency,
          attempted: {
            // Exact: quantizing the evidence would render a sub-cent overdraft
            // as "0" and make the rejection look self-contradictory.
            newAvailable: newAvailable.toExactString(),
            newPending: newPending.toExactString(),
            newReserved: newReserved.toExactString(),
          },
        });
      }

      // updateMany with version filter — returns count = 0 if a concurrent writer beat us.
      const res = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          // toExactString(), NOT toString(): toString() quantizes to MONEY_SCALE,
          // which on the FIRST write after the scale change would silently truncate
          // a legacy balance's sub-cent tail while ledger_entries keeps its full
          // history — diverging the wallet from the ledger it is a projection of,
          // and turning reconciliation red for every affected company.
          //
          // The base is carried exactly and every DELTA is already at scale, so
          // wallet == ledger continues to hold. Revert to toString() only if and
          // when ledger_entries.amount and wallets.* both move to numeric(20,2).
          availableBalance: newAvailable.toExactString(),
          pendingBalance: newPending.toExactString(),
          reservedBalance: newReserved.toExactString(),
          version: { increment: 1 },
        },
      });

      if (res.count === 1) return;
      this.logger.warn(`wallet ${wallet.id} concurrent update; retry ${attempt}`);
    }
    throw new ConflictError(`Wallet update failed after ${MAX_RETRY} retries`, {
      companyId: args.companyId,
      currency: args.currency,
    });
  }

  async listByCompany(companyId: string): Promise<WalletResponse[]> {
    const rows = await this.prisma.runAsScoped(companyId, (tx) =>
      tx.wallet.findMany({ where: { companyId }, orderBy: { currency: 'asc' } }),
    );
    return rows.map(mapWallet);
  }

  async getOne(companyId: string, currency: string): Promise<WalletResponse> {
    const row = await this.prisma.runAsScoped(companyId, (tx) =>
      tx.wallet.findUnique({
        where: { companyId_currency: { companyId, currency } },
      }),
    );
    if (!row) throw new NotFoundError('Wallet', `${companyId}/${currency}`);
    return mapWallet(row);
  }
}

function mapWallet(row: {
  id: string;
  companyId: string;
  currency: string;
  availableBalance: { toString(): string };
  pendingBalance: { toString(): string };
  reservedBalance: { toString(): string };
  updatedAt: Date;
}): WalletResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    currency: row.currency.trim(),
    availableBalance: row.availableBalance.toString(),
    pendingBalance: row.pendingBalance.toString(),
    reservedBalance: row.reservedBalance.toString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
