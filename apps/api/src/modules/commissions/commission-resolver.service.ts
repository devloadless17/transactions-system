import { Injectable } from '@nestjs/common';
import {
  Money,
  type CommissionType,
  type FeeApplication,
  type FeeOperationType,
} from '@app/shared';
import { DomainError } from '../../common/errors/domain.error';

/**
 * A single commission/fee rule, projected for the resolver. Match logic:
 *   - operationType must match exactly (TRANSACTION/WITHDRAWAL/PAYOUT/LOAD)
 *   - companyId/null match by exact-or-global
 *   - sourceId/null match by exact-or-global (flows pass sourceId=null, which
 *     only matches null-source rules)
 *   - amount must satisfy: minAmount <= amount <= maxAmount
 *   - only `active` rules are considered
 *
 * Ranking when multiple rules match:
 *   1. specificity score (3 = both set, 2 = company set, 1 = source set, 0 = global)
 *   2. priority DESC
 *   3. createdAt ASC (stable tie-break — set by caller if needed)
 */
export interface ResolvableRule {
  id: string;
  companyId: string | null;
  sourceId: string | null;
  operationType: FeeOperationType;
  feeApplication: FeeApplication;
  minAmount: string;
  maxAmount: string;
  commissionType: CommissionType;
  commissionValue: string;
  priority: number;
  active: boolean;
  // Optional: caller can pass this for stable tie-break. Older first.
  createdAt?: Date;
}

export interface CommissionResolution {
  rule: ResolvableRule;
  feeApplication: FeeApplication;
  commissionAmount: Money;
  netAmount: Money;
}

export class NoMatchingCommissionRuleError extends DomainError {
  constructor(companyId: string, sourceId: string | null, amount: string) {
    super(
      'NO_COMMISSION_RULE',
      `No active commission rule matches amount=${amount} for company=${companyId} source=${sourceId ?? 'null'}`,
      422,
      { companyId, sourceId, amount },
    );
  }
}

interface ResolveArgs {
  companyId: string;
  sourceId: string | null;
  operationType: FeeOperationType;
  amount: Money;
  rules: ResolvableRule[];
}

@Injectable()
export class CommissionResolverService {
  /**
   * Resolve the applicable commission/fee rule for an amount + operation.
   * Throws NoMatchingCommissionRuleError (422) when nothing matches — used by
   * transaction ingestion where a transaction MUST be priced.
   *
   * Pure function: callers fetch the candidate rules from the DB and hand
   * them in. This makes unit testing trivial and avoids N+1 DB hits.
   */
  resolve(args: ResolveArgs): CommissionResolution {
    const resolution = this.resolveOptional(args);
    if (!resolution) {
      throw new NoMatchingCommissionRuleError(
        args.companyId,
        args.sourceId,
        args.amount.toString(),
      );
    }
    return resolution;
  }

  /**
   * Like `resolve`, but returns null instead of throwing when no rule matches.
   * Used by the money-movement flows (withdrawal/payout/load) where a missing
   * fee rule means "free", not "blocked".
   */
  resolveOptional(args: ResolveArgs): CommissionResolution | null {
    const { companyId, sourceId, operationType, amount, rules } = args;

    const candidates = rules.filter((r) => {
      if (!r.active) return false;
      if (r.operationType !== operationType) return false;
      if (r.companyId !== null && r.companyId !== companyId) return false;
      if (r.sourceId !== null && r.sourceId !== sourceId) return false;
      const min = Money.of(r.minAmount);
      const max = Money.of(r.maxAmount);
      return amount.gte(min) && amount.lte(max);
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const sa = specificity(a);
      const sb = specificity(b);
      if (sa !== sb) return sb - sa;
      if (a.priority !== b.priority) return b.priority - a.priority;
      const ta = a.createdAt?.getTime() ?? 0;
      const tb = b.createdAt?.getTime() ?? 0;
      return ta - tb;
    });

    const rule = candidates[0]!;
    const commission = computeCommission(amount, rule);
    const net = amount.sub(commission);

    return {
      rule,
      feeApplication: rule.feeApplication,
      commissionAmount: commission,
      netAmount: net,
    };
  }
}

function specificity(rule: ResolvableRule): number {
  let s = 0;
  if (rule.companyId !== null) s += 2;
  if (rule.sourceId !== null) s += 1;
  return s;
}

function computeCommission(amount: Money, rule: ResolvableRule): Money {
  if (rule.commissionType === 'FIXED') {
    return Money.of(rule.commissionValue).round();
  }
  // PERCENTAGE
  return amount.percent(rule.commissionValue).round();
}
