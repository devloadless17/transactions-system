import { Injectable } from '@nestjs/common';
import {
  Money,
  defaultFeeApplicationFor,
  type FeeApplication,
  type FeeOperationType,
} from '@app/shared';
import type { PrismaClient } from '@app/db';
import type { FeeParts } from '../ledger/flow-ledger';
import { CommissionResolverService, type ResolvableRule } from './commission-resolver.service';
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
        // With no commission rule matching this amount, the application only
        // matters once there is a fee to apply. Without a network fee it stays
        // DEDUCTED exactly as before. With one it follows the flow's own
        // commission rules when they agree on an application — so an amount that
        // falls in a hole or off the edge of a ladder is charged the same way as
        // every other amount of that flow — and only a flow with no rule at all
        // uses its conventional application (a withdrawal stays ON_TOP, so its
        // recipient still gets the full amount).
        feeApplication: network.isPositive()
          ? (configuredFeeApplication(rules, args.companyId, args.operationType) ??
            defaultFeeApplicationFor(args.operationType))
          : 'DEDUCTED',
      };
    }
    return {
      fees: { commission: res.commissionAmount, network },
      feeApplication: res.feeApplication,
    };
  }
}

/**
 * The fee application a flow is CONFIGURED with, regardless of amount: the one
 * its active commission rules agree on, or null when it has no rule or its
 * rules disagree. Same precedence as the resolver — the company's own rules
 * outrank the global ones — and, like the flows, only source-less rules count.
 */
export function configuredFeeApplication(
  rules: ResolvableRule[],
  companyId: string,
  operationType: FeeOperationType,
): FeeApplication | null {
  const usable = rules.filter(
    (r) =>
      r.active &&
      r.operationType === operationType &&
      r.sourceId === null &&
      (r.companyId === null || r.companyId === companyId),
  );
  const own = usable.filter((r) => r.companyId === companyId);
  const applications = new Set((own.length > 0 ? own : usable).map((r) => r.feeApplication));
  if (applications.size !== 1) return null;
  const [only] = applications;
  return only ?? null;
}
