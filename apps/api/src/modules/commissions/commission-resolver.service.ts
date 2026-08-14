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
 *   4. id ASC (final tie-break so selection is FULLY deterministic even when
 *      specificity, priority and createdAt all tie)
 */
export interface ResolvableRule {
  id: string;
  companyId: string | null;
  sourceId: string | null;
  operationType: FeeOperationType;
  feeApplication: FeeApplication;
  minAmount: string;
  // null = open-ended top tier ("and above"); treated as +infinity in matching.
  maxAmount: string | null;
  commissionType: CommissionType;
  commissionValue: string;
  priority: number;
  active: boolean;
  // Optional: caller can pass this for stable tie-break. Older first.
  /**
   * `Date | string`, deliberately: these rules cross a Redis/JSON cache
   * boundary, and a cache HIT hands back the serialized string. The resolver
   * must never assume the hydrated shape — `a.createdAt.getTime()` inside the
   * sort comparator threw on cached rules and turned every payment create
   * into a 500 for the cache's TTL whenever two rules tied on priority.
   */
  createdAt?: Date | string;
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

/**
 * A DEDUCTED fee computed larger than the amount it is deducted from would make
 * net negative and the resulting ledger set unbalanced (the AVAILABLE credit
 * line is skipped, leaving debits != credits). We fail loudly here at resolve
 * time with a clear 422 instead of letting it surface as an opaque "unbalanced
 * ledger entries" 500 that blocks every ingest in the affected bracket.
 */
export class CommissionExceedsAmountError extends DomainError {
  constructor(ruleId: string, amount: string, commission: string) {
    super(
      'COMMISSION_EXCEEDS_AMOUNT',
      `Resolved commission (${commission}) exceeds the amount (${amount}) for a DEDUCTED fee (rule=${ruleId}). Fix the commission rule.`,
      422,
      { ruleId, amount, commission },
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
      if (!amount.gte(min)) return false;
      // maxAmount === null is an open-ended top tier ("and above"): no upper
      // bound, so any amount >= min is in range.
      if (r.maxAmount === null) return true;
      return amount.lte(Money.of(r.maxAmount));
    });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const sa = specificity(a);
      const sb = specificity(b);
      if (sa !== sb) return sb - sa;
      if (a.priority !== b.priority) return b.priority - a.priority;
      const ta = epochOf(a.createdAt);
      const tb = epochOf(b.createdAt);
      if (ta !== tb) return ta - tb;
      // Final deterministic tie-break: equal specificity, priority AND createdAt
      // (e.g. two rules created in the same tick, or createdAt unset) must still
      // resolve to ONE rule, never an unspecified DB/array order. Lowest id wins.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const rule = candidates[0]!;
    const commission = computeCommission(amount, rule);

    // Defense-in-depth: a DEDUCTED fee can never exceed the amount it is taken
    // from. Reject here so a misconfigured rule fails with a clear 422 rather
    // than as an opaque unbalanced-ledger 500 downstream. (ON_TOP fees are
    // added on top, so a fee > amount is legitimate there.)
    if (rule.feeApplication === 'DEDUCTED' && commission.gt(amount)) {
      throw new CommissionExceedsAmountError(rule.id, amount.toString(), commission.toString());
    }

    // ON_TOP: recipient gets the full amount (fee is added on top); DEDUCTED:
    // recipient gets amount − fee. Mirror netOfFee() so this field can't drift.
    const net = rule.feeApplication === 'ON_TOP' ? amount : amount.sub(commission);

    return {
      rule,
      feeApplication: rule.feeApplication,
      commissionAmount: commission,
      netAmount: net,
    };
  }
}

/** Epoch millis from whatever shape the cache handed us; 0 when absent/invalid. */
function epochOf(value: Date | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
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
