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
/** Minimum net auto-transferred; sub-$1 nets stay manual. */
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

/** The non-secret Whish session health the breaker + gates depend on. */
export interface SessionHealth {
  configured: boolean;
  lastRotatedAt: Date | string | null;
  lastAuthFailureAt: Date | string | null;
}

/** Live platform state the poller would see. Mirrors `tick()`'s preconditions. */
export interface AutoApprovalGates {
  enabled: boolean;
  enabledAt: Date | null;
  circuitBreakerTrippedAt: Date | null;
  /** Decimal string, from `AutoApprovalConfigStore.getState()`. */
  maxAutoApproveAmount: string;
  w2wEnabled: boolean;
  session: SessionHealth;
  /**
   * WITHDRAWAL_AUTO_APPROVAL_SIMULATE (staging): the poller settles without a
   * real transfer, so the breaker/W2W/session gates don't apply — only the
   * admin toggle and the per-withdrawal scoping do.
   */
  simulate: boolean;
}

/**
 * A tripped breaker does NOT permanently stop auto-approval: `tick()` calls
 * `AutoApprovalConfigStore.maybeAutoResume()`, which clears the breaker and
 * CONTINUES once the Whish session has been re-pasted since the trip. This is
 * the pure decision behind that, shared by the store and by
 * `autoApprovalSkipReason()` — otherwise the predicate would page a human for
 * every withdrawal in the window between a session refresh and the next tick,
 * each of which the poller then happily auto-settles.
 */
export function breakerWouldResume(trippedAt: Date, session: SessionHealth): boolean {
  const rotated = session.lastRotatedAt ? new Date(session.lastRotatedAt) : null;
  return (
    session.configured &&
    session.lastAuthFailureAt === null &&
    rotated !== null &&
    rotated > trippedAt
  );
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
  // Platform-wide gates (tick() returns early on each of these). The breaker only
  // blocks if it would NOT auto-resume — matching tick(), which resumes and
  // carries on when the session was refreshed after the trip. In simulate mode
  // tick() consults none of the Whish-side gates, so neither do we.
  if (
    !gates.simulate &&
    gates.circuitBreakerTrippedAt &&
    !breakerWouldResume(gates.circuitBreakerTrippedAt, gates.session)
  ) {
    return 'CIRCUIT_BREAKER';
  }
  if (!gates.enabled || !gates.enabledAt) return 'DISABLED';
  if (!gates.simulate) {
    if (!gates.w2wEnabled) return 'W2W_DISABLED';
    if (!gates.session.configured) return 'SESSION_UNAVAILABLE';
  }

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

/**
 * Category of a Whish W2W transfer FAILURE, derived from the upstream code/message.
 * Lets the queue tell the operator whether a failed auto-transfer is their problem
 * to chase (bad recipient number) or the receiver's / Whish's (limits, outage) —
 * instead of a bare "Auto: failed". `status:false` always means money did NOT move.
 *
 *   INVALID_RECIPIENT — the recipient msisdn is malformed/rejected (e.g.
 *                       `auth.wrong_phone_format`). Fix the number; retrying as-is
 *                       will fail identically.
 *   RECEIVER          — a receiver-side precondition failed (e.g.
 *                       `account.topup.check.condition.fail`, `transfer.failed.title`,
 *                       "reach out to the receiver"): usually a receiver wallet/receiving
 *                       limit. Not a platform fault.
 *   TEMPORARY         — Whish is momentarily unavailable (`off`, "try again later").
 *                       A later retry may succeed.
 *   GENERIC           — anything else.
 */
export type W2WFailureCategory = 'INVALID_RECIPIENT' | 'RECEIVER' | 'TEMPORARY' | 'GENERIC';

export function classifyW2WFailure(
  code: string | null | undefined,
  message: string | null | undefined,
): W2WFailureCategory {
  const c = (code ?? '').toLowerCase();
  const m = (message ?? '').toLowerCase();
  if (c.includes('phone') || /phone.*format|invalid.*(phone|recipient|number)/.test(m)) {
    return 'INVALID_RECIPIENT';
  }
  if (c === 'off' || /try again later|temporarily|unavailable/.test(m)) {
    return 'TEMPORARY';
  }
  if (
    c.includes('condition.fail') ||
    c.includes('transfer.failed') ||
    /reach out to the receiver|contact the receiver/.test(m)
  ) {
    return 'RECEIVER';
  }
  return 'GENERIC';
}
