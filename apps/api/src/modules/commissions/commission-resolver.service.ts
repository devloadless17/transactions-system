import { Injectable } from '@nestjs/common';
import { Money, type CommissionType } from '@app/shared';
import { DomainError } from '../../common/errors/domain.error';

/**
 * A single commission rule, projected for the resolver. Match logic:
 *   - companyId/null match by exact-or-global
 *   - sourceId/null match by exact-or-global
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
  commissionAmount: Money;
  netAmount: Money;
}

export class NoMatchingCommissionRuleError extends DomainError {
  constructor(companyId: string, sourceId: string, amount: string) {
    super(
      'NO_COMMISSION_RULE',
      `No active commission rule matches amount=${amount} for company=${companyId} source=${sourceId}`,
      422,
      { companyId, sourceId, amount },
    );
  }
}

@Injectable()
export class CommissionResolverService {
  /**
   * Resolve the applicable commission rule for an amount.
   * Returns the matched rule plus the computed commission and net.
   *
   * Pure function: callers fetch the candidate rules from the DB and hand
   * them in. This makes unit testing trivial and avoids N+1 DB hits when
   * resolving a batch.
   */
  resolve(args: {
    companyId: string;
    sourceId: string;
    amount: Money;
    rules: ResolvableRule[];
  }): CommissionResolution {
    const { companyId, sourceId, amount, rules } = args;

    const candidates = rules.filter((r) => {
      if (!r.active) return false;
      if (r.companyId !== null && r.companyId !== companyId) return false;
      if (r.sourceId !== null && r.sourceId !== sourceId) return false;
      const min = Money.of(r.minAmount);
      const max = Money.of(r.maxAmount);
      return amount.gte(min) && amount.lte(max);
    });

    if (candidates.length === 0) {
      throw new NoMatchingCommissionRuleError(companyId, sourceId, amount.toString());
    }

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

    return { rule, commissionAmount: commission, netAmount: net };
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
