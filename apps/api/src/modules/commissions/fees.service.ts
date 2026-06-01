import { Injectable } from '@nestjs/common';
import { Money, type FeeApplication, type FeeOperationType } from '@app/shared';
import type { PrismaClient } from '@app/db';
import { CommissionResolverService } from './commission-resolver.service';
import { CommissionsRepository } from './commissions.repository';

export interface ResolvedFlowFee {
  fee: Money;
  feeApplication: FeeApplication;
}

/**
 * Fee resolution for the money-movement flows (withdrawal / payout / load).
 * These have no source, and a MISSING fee rule means "free" (fee = 0), not
 * "blocked" — unlike transaction ingestion which must price every transaction.
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
    if (!res) return { fee: Money.of('0'), feeApplication: 'DEDUCTED' };
    return { fee: res.commissionAmount, feeApplication: res.feeApplication };
  }
}
