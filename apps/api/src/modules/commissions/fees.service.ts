import { Injectable } from '@nestjs/common';
import {
  Money,
  defaultFeeApplicationFor,
  type FeeApplication,
  type FeeOperationType,
} from '@app/shared';
import type { PrismaClient } from '@app/db';
import type { FeeParts } from '../ledger/flow-ledger';
import { CommissionResolverService } from './commission-resolver.service';
import { CommissionsRepository } from './commissions.repository';
import { computeNetworkFee, readNetworkFeeRate } from './network-fee';

export interface ResolvedFlowFee {
  // The commission-rule fee plus the optional network fee (0 when the company's
  // switch is off). Both are frozen onto the row at request time.
  fees: FeeParts;
  feeApplication: FeeApplication;
}

/**
 * Fee resolution for the money-movement flows (withdrawal / payout / load).
 * These have no source, and a MISSING fee rule means "free" (fee = 0), not
 * "blocked" — unlike transaction ingestion which must price every transaction.
 *
 * The commission is resolved exactly as before (including its
 * CommissionExceedsAmountError); the network fee is computed beside it, on the
 * same amount, and applied the same way as the commission.
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly resolver: CommissionResolverService,
    private readonly repo: CommissionsRepository,
  ) {}

  async resolveFlowFee(
    tx: PrismaClient,
    args: { companyId: string; amount: Money; operationType: FeeOperationType },
  ): Promise<ResolvedFlowFee> {
    const rules = await this.repo.loadCandidates(tx, {
      companyId: args.companyId,
      operationType: args.operationType,
    });
    const res = this.resolver.resolveOptional({
      companyId: args.companyId,
      sourceId: null,
      operationType: args.operationType,
      amount: args.amount,
      rules,
    });
    const network = computeNetworkFee(
      args.amount,
      await readNetworkFeeRate(tx, args.companyId, args.operationType),
    );
    if (!res) {
      return {
        fees: { commission: Money.of('0'), network },
        // With no commission rule the application only matters once there is a
        // fee to apply. Without a network fee it stays DEDUCTED exactly as
        // before; with one, the flow's conventional application is used, so a
        // withdrawal stays ON_TOP and its recipient still gets the full amount.
        feeApplication: network.isPositive()
          ? defaultFeeApplicationFor(args.operationType)
          : 'DEDUCTED',
      };
    }
    return {
      fees: { commission: res.commissionAmount, network },
      feeApplication: res.feeApplication,
    };
  }
}
