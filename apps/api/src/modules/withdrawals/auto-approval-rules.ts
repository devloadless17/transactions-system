import { Money } from '@app/shared';

/**
 * Single source of truth for "will this withdrawal be auto-approved?".
 *
 * The auto-approval decision used to live in two places — the SQL `where` of
 * `WithdrawalsService.findAutoApprovalCandidates()` and the gate checks at the
 * top of `WithdrawalAutoApprovalService.tick()`. Anything that needs to PREDICT
 * the outcome (e.g. deciding whether to alert a human on Telegram) had to
 * re-implement it, which would let the two drift apart. Drift in a money
 * predicate means either a withdrawal nobody is told about, or a spurious page.
 *
 * So: the scoping constants live here and are consumed by the candidate query,
 * and `autoApprovalSkipReason()` mirrors the gate order exactly.
 */

/** Auto-approval only ever covers Whish transfers. */
export const AUTO_APPROVE_METHOD = 'WISH';
/** ...in USD. */
export const AUTO_APPROVE_CURRENCY = 'USD';
/**
 * Minimum net. The transfer floors to whole dollars, so a sub-$1 net would send
 * $0 — those stay manual.
 */
export const AUTO_APPROVE_MIN_NET = '1';

/** Why a withdrawal will NOT be auto-approved (i.e. a human must action it). */
export type AutoApprovalSkipReason =
  | 'CIRCUIT_BREAKER'
  | 'DISABLED'
  | 'W2W_DISABLED'
  | 'SESSION_UNAVAILABLE'
  | 'METHOD_NOT_SUPPORTED'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'BELOW_MIN_NET'
  | 'ABOVE_CAP';

/** The withdrawal fields the decision depends on. `netAmount` — never the gross. */
export interface AutoApprovalSubject {
  payoutMethod: string;
  currency: string;
  /** Decimal string. The cap is compared against the NET, after any deducted fee. */
  netAmount: string;
}

/** Live platform state the poller would see. Mirrors `tick()`'s preconditions. */
export interface AutoApprovalGates {
  enabled: boolean;
  enabledAt: Date | null;
  circuitBreakerTrippedAt: Date | null;
  /** Decimal string, from `AutoApprovalConfigStore.getState()`. */
  maxAutoApproveAmount: string;
  w2wEnabled: boolean;
  sessionConfigured: boolean;
}

/**
 * `null` ⇒ this withdrawal WILL be auto-approved (no human needed).
 * Otherwise the first reason it won't be.
 *
 * Order deliberately mirrors `WithdrawalAutoApprovalService.tick()`: the
 * platform-wide gates short-circuit before the per-withdrawal ones, so the
 * reported reason is the same one the poller would act on.
 *
 * Amounts compare via `Money` (Decimal-exact). Never use JS floats here — a
 * float `>` on 8-dp money silently misclassifies boundary values.
 */
export function autoApprovalSkipReason(
  subject: AutoApprovalSubject,
  gates: AutoApprovalGates,
): AutoApprovalSkipReason | null {
  // Platform-wide gates (tick() returns early on each of these).
  if (gates.circuitBreakerTrippedAt) return 'CIRCUIT_BREAKER';
  if (!gates.enabled || !gates.enabledAt) return 'DISABLED';
  if (!gates.w2wEnabled) return 'W2W_DISABLED';
  if (!gates.sessionConfigured) return 'SESSION_UNAVAILABLE';

  // Per-withdrawal scoping (the candidate query's `where`).
  if (subject.payoutMethod !== AUTO_APPROVE_METHOD) return 'METHOD_NOT_SUPPORTED';
  if (subject.currency !== AUTO_APPROVE_CURRENCY) return 'CURRENCY_NOT_SUPPORTED';

  const net = Money.of(subject.netAmount);
  if (net.lt(Money.of(AUTO_APPROVE_MIN_NET))) return 'BELOW_MIN_NET';
  if (net.gt(Money.of(gates.maxAutoApproveAmount))) return 'ABOVE_CAP';

  return null;
}

/**
 * A short, human-facing explanation for the alert. Kept terse on purpose — this
 * is read on a phone at a glance, so it names the cause and nothing else.
 */
export function describeSkipReason(
  reason: AutoApprovalSkipReason,
  ctx: { payoutMethod: string; currency: string; netAmount: string; maxAutoApproveAmount: string },
): string {
  switch (reason) {
    case 'CIRCUIT_BREAKER':
      return 'auto-approval paused (circuit breaker)';
    case 'DISABLED':
      return 'auto-approval off';
    case 'W2W_DISABLED':
      return 'Whish transfers disabled';
    case 'SESSION_UNAVAILABLE':
      return 'no Whish session';
    case 'METHOD_NOT_SUPPORTED':
      return `${ctx.payoutMethod} withdrawal`;
    case 'CURRENCY_NOT_SUPPORTED':
      return `non-${AUTO_APPROVE_CURRENCY} (${ctx.currency})`;
    case 'BELOW_MIN_NET':
      return `net under ${AUTO_APPROVE_MIN_NET} ${AUTO_APPROVE_CURRENCY}`;
    case 'ABOVE_CAP':
      return `above cap (${ctx.netAmount} > ${ctx.maxAutoApproveAmount} ${ctx.currency})`;
  }
}
