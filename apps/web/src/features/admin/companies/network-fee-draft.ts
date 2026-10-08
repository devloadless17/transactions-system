import {
  CommissionType,
  FEE_OPERATION_LABEL,
  FEE_OPERATION_TYPES,
  MONEY_INPUT_DP,
  Money,
  RATE_INPUT_DP,
  isDecimalString,
  setNetworkFeeConfigSchema,
  type FeeOperationType,
  type NetworkFeeConfigResponse,
  type SetNetworkFeeConfigInput,
} from '@app/shared';
import { formatAmount } from '@/lib/format';

/**
 * The pure half of the company "Network fee" card: the editable draft, its
 * validation into the API body, the live "On $100" example and the dirty check.
 * Kept out of the component so the rules that decide what a tenant is charged
 * are unit-tested (network-fee-draft.spec.ts).
 */

/** One flow's editable rate: the $/% toggle and the value exactly as typed. */
export interface NetworkFeeRateDraft {
  feeType: CommissionType;
  // '' = this flow is not charged.
  feeValue: string;
}

/** The card's form state. The switch is part of it: nothing applies until saved. */
export interface NetworkFeeDraft {
  enabled: boolean;
  rates: Record<FeeOperationType, NetworkFeeRateDraft>;
}

export type NetworkFeeBuild =
  | { ok: true; value: SetNetworkFeeConfigInput }
  | {
      ok: false;
      // Per flow, shown under that flow's input.
      rateErrors: Partial<Record<FeeOperationType, string>>;
      // Not tied to one flow (e.g. switched on with no rate at all).
      formError: string | null;
    };

const HUNDRED = Money.of(100);
// The amount the live example is worked on — round, so a % reads straight off.
const EXAMPLE_AMOUNT = Money.of(100);
// Mirrors the API's decimal-string cap (12 integer digits).
const MAX_INTEGER_DIGITS = 12;

const fractionDigits = (v: string): number => v.split('.')[1]?.length ?? 0;

/** The editable draft for a saved config. A flow without a rate starts blank, on %. */
export function draftFromConfig(config: NetworkFeeConfigResponse): NetworkFeeDraft {
  const byOp = new Map(config.rates.map((r) => [r.operationType, r]));
  const rates = Object.fromEntries(
    FEE_OPERATION_TYPES.map((op) => {
      const saved = byOp.get(op);
      const rate: NetworkFeeRateDraft = saved
        ? { feeType: saved.feeType, feeValue: saved.feeValue }
        : { feeType: CommissionType.PERCENTAGE, feeValue: '' };
      return [op, rate];
    }),
  ) as Record<FeeOperationType, NetworkFeeRateDraft>;
  return { enabled: config.enabled, rates };
}

/**
 * Why a typed rate can't be saved, in the card's own words — or null when it
 * can. Blank is valid: that flow is simply not charged. Mirrors the API's
 * networkFeeRateInputSchema; buildInput still runs the real schema last.
 */
export function rateError(rate: NetworkFeeRateDraft): string | null {
  const v = rate.feeValue.trim();
  if (v === '') return null;
  if (!isDecimalString(v)) return 'Enter a number, like 1 or 2.5.';
  if (v.split('.')[0].length > MAX_INTEGER_DIGITS) return 'That value is too large.';
  const fixed = rate.feeType === CommissionType.FIXED;
  if (fixed && fractionDigits(v) > MONEY_INPUT_DP) {
    return `A fixed fee is an amount — at most ${MONEY_INPUT_DP} decimal places.`;
  }
  if (!fixed && fractionDigits(v) > RATE_INPUT_DP) {
    return `A percentage takes at most ${RATE_INPUT_DP} decimal places.`;
  }
  const value = Money.of(v);
  if (!value.isPositive()) return 'Must be more than 0 — leave it blank to not charge this flow.';
  if (!fixed && value.gt(HUNDRED)) return 'A percentage can be at most 100.';
  return null;
}

/**
 * Validate the draft into the PUT body: every flow with a value becomes a rate
 * (a blank flow is left out, i.e. not charged), then the shared
 * setNetworkFeeConfigSchema — the same one the API enforces — has the final
 * word, so the card can never submit what the server would reject.
 */
export function buildInput(draft: NetworkFeeDraft): NetworkFeeBuild {
  const rateErrors: Partial<Record<FeeOperationType, string>> = {};
  const rates: SetNetworkFeeConfigInput['rates'] = [];
  for (const op of FEE_OPERATION_TYPES) {
    const rate = draft.rates[op];
    const error = rateError(rate);
    if (error) {
      rateErrors[op] = error;
      continue;
    }
    const feeValue = rate.feeValue.trim();
    if (feeValue !== '') rates.push({ operationType: op, feeType: rate.feeType, feeValue });
  }
  // Fix the flows first: "set at least one flow" would be wrong while the one
  // that was set is merely invalid.
  if (Object.keys(rateErrors).length > 0) return { ok: false, rateErrors, formError: null };

  const parsed = setNetworkFeeConfigSchema.safeParse({ enabled: draft.enabled, rates });
  if (parsed.success) return { ok: true, value: parsed.data };
  let formError: string | null = null;
  for (const issue of parsed.error.issues) {
    const [head, index] = issue.path;
    const op = head === 'rates' && typeof index === 'number' ? rates[index]?.operationType : null;
    if (op) rateErrors[op] ??= sentence(issue.message);
    else formError ??= sentence(issue.message);
  }
  return { ok: false, rateErrors, formError };
}

/** A rate as people read it: "1%", "0.125%" (a rate keeps its precision), "$2.00". */
export function formatNetworkFeeRate(feeType: CommissionType, feeValue: string): string {
  if (feeType === CommissionType.PERCENTAGE) {
    return `${isDecimalString(feeValue) ? Money.of(feeValue).toExactString() : feeValue}%`;
  }
  return `$${formatAmount(feeValue)}`;
}

/**
 * The live example beside a flow: "On $100: $1.00". Worked exactly as the API
 * computes it — a % of the amount, or the fixed value, each rounded once to
 * cents. Null while the flow is blank or its value can't be saved.
 */
export function exampleOn100(rate: NetworkFeeRateDraft): string | null {
  const v = rate.feeValue.trim();
  if (v === '' || rateError(rate)) return null;
  const fee =
    rate.feeType === CommissionType.PERCENTAGE
      ? EXAMPLE_AMOUNT.percent(v).round()
      : Money.of(v).round();
  return `On $100: $${formatAmount(fee.toString())}`;
}

// Canonical form of a draft, so "1.0" over a saved "1" — or flipping $/% on a
// blank flow — is not an edit.
function signature(draft: NetworkFeeDraft): string {
  const flows = FEE_OPERATION_TYPES.map((op) => {
    const rate = draft.rates[op];
    const v = rate.feeValue.trim();
    if (v === '') return `${op}:-`;
    return `${op}:${rate.feeType}:${isDecimalString(v) ? Money.of(v).toExactString() : v}`;
  });
  return [String(draft.enabled), ...flows].join('|');
}

/** Whether the draft differs from the saved config. */
export function isDirty(draft: NetworkFeeDraft, config: NetworkFeeConfigResponse): boolean {
  return signature(draft) !== signature(draftFromConfig(config));
}

/** The flows a save charges, for the confirmation: "Deposits 1%, Withdrawals $2.00". */
export function rateSummary(rates: SetNetworkFeeConfigInput['rates']): string {
  return rates
    .map(
      (r) =>
        `${FEE_OPERATION_LABEL[r.operationType]} ${formatNetworkFeeRate(r.feeType, r.feeValue)}`,
    )
    .join(', ');
}

/** The confirm() text for a save — says what new operations get, and that history is kept. */
export function confirmSaveMessage(
  companyName: string,
  input: SetNetworkFeeConfigInput,
  wasEnabled: boolean,
): string {
  const kept = 'Existing records keep the fees they were already charged.';
  if (input.enabled) {
    return `Save the network fee for ${companyName}? New operations will be charged ${rateSummary(input.rates)}. ${kept}`;
  }
  if (wasEnabled) {
    return `Turn off the network fee for ${companyName}? New operations won't be charged one. ${kept}`;
  }
  return `Save the network fee rates for ${companyName}? The network fee stays off, so nothing is charged until it's turned on.`;
}

// Schema messages are lower-case fragments ("must be …"); the card shows sentences.
function sentence(message: string): string {
  const s = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
