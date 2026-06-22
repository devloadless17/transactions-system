'use client';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import {
  CommissionType,
  FeeApplication,
  FeeOperationType,
  FEE_OPERATION_TYPES,
  FEE_OPERATION_LABEL,
  Money,
  companyScopedCommissionRuleSchema,
  type CommissionOperationInput,
  type CommissionRuleGroupResponse,
  type CompanyScopedCommissionRuleInput,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Threshold tiers: the admin enters only the amount each tier STARTS at + its fee.
// A tier runs from its start up to the next tier's start; the highest tier covers
// everything above. We derive each row's stored max in buildRuleSpec.
export interface TierForm {
  minAmount: string;
  commissionType: CommissionType;
  commissionValue: string;
}

// The editable rule pricing spec (operations + their per-op application, the
// shared fee tiers, and priority). Name/companies live on the parent — they
// differ between the standalone rule dialog and company onboarding.
export interface RuleDraft {
  operations: CommissionOperationInput[];
  priority: number;
  tiers: TierForm[];
}

// Smallest representable step at the ledger's Decimal(20,8) scale — a tier's max
// is the next tier's start minus this, so brackets are contiguous with no overlap.
const EPSILON = '0.00000001';

const DEFAULT_TIERS: TierForm[] = [
  { minAmount: '0', commissionType: CommissionType.FIXED, commissionValue: '1' },
];

// Default fee application when an operation is first added. Withdrawals default to
// ON_TOP (the company pays the fee on top, so the withdrawal pays out in full);
// everything else defaults to DEDUCTED. Always editable per operation.
export function defaultApplicationFor(op: FeeOperationType): FeeApplication {
  return op === FeeOperationType.WITHDRAWAL ? FeeApplication.ON_TOP : FeeApplication.DEDUCTED;
}

// New rules price Deposits + Withdrawals by default; Payouts/Loads are opt-in.
const DEFAULT_OPERATIONS: CommissionOperationInput[] = [
  FeeOperationType.TRANSACTION,
  FeeOperationType.WITHDRAWAL,
].map((operationType) => ({ operationType, feeApplication: defaultApplicationFor(operationType) }));

export function defaultRuleDraft(): RuleDraft {
  return { operations: DEFAULT_OPERATIONS, priority: 100, tiers: DEFAULT_TIERS };
}

/** Re-derive the editable draft from a saved rule group (for editing). */
export function draftFromGroup(group: CommissionRuleGroupResponse): RuleDraft {
  return {
    operations: group.operations,
    priority: group.priority,
    // Only the tier STARTS matter in the threshold form; max is re-derived on save.
    tiers: group.tiers.map((t) => ({
      minAmount: t.minAmount,
      commissionType: t.commissionType,
      commissionValue: t.commissionValue,
    })),
  };
}

/**
 * Validate the draft and build the company-scoped rule spec (operations, the
 * tier ladder with derived maxes, priority, name, active) — WITHOUT companyIds,
 * which the caller adds (rule dialog) or the server injects (onboarding).
 */
export function buildRuleSpec(
  draft: RuleDraft,
  opts: { name: string | null; active: boolean },
): { ok: true; value: CompanyScopedCommissionRuleInput } | { ok: false; error: string } {
  const decimal = /^\d+(\.\d+)?$/;
  for (const t of draft.tiers) {
    if (!decimal.test(t.minAmount.trim())) {
      return { ok: false, error: 'Each tier needs a valid start amount (e.g. 0, 100, 1000).' };
    }
    if (!decimal.test(t.commissionValue.trim())) {
      return { ok: false, error: 'Each tier needs a fee value.' };
    }
  }
  if (draft.operations.length === 0) {
    return { ok: false, error: 'Pick at least one operation for the rule.' };
  }
  const sorted = [...draft.tiers].sort((a, b) =>
    Money.of(a.minAmount).gt(Money.of(b.minAmount)) ? 1 : -1,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (!Money.of(sorted[i - 1]!.minAmount).lt(Money.of(sorted[i]!.minAmount))) {
      return { ok: false, error: 'Tier start amounts must be different and increasing.' };
    }
  }
  const candidate = {
    name: opts.name,
    operations: draft.operations,
    priority: draft.priority,
    active: opts.active,
    // Each tier ends just below the next tier's start; the last is open-ended.
    tiers: sorted.map((t, i) => ({
      minAmount: t.minAmount.trim(),
      maxAmount:
        i < sorted.length - 1
          ? Money.of(sorted[i + 1]!.minAmount)
              .sub(Money.of(EPSILON))
              .toString()
          : null,
      commissionType: t.commissionType,
      commissionValue: t.commissionValue.trim(),
    })),
  };
  const parsed = companyScopedCommissionRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the rule.' };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The shared commission-rule editor: per-operation fee application, the threshold
 * fee-tier ladder (with live preview), and priority. Controlled — the parent owns
 * the {@link RuleDraft}. Used by the standalone rule dialog AND company onboarding
 * so both stay identical.
 */
export function CommissionRuleFields({
  draft,
  onChange,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
}) {
  const setOps = (operations: CommissionOperationInput[]) => onChange({ ...draft, operations });
  const toggleOperation = (op: FeeOperationType) =>
    setOps(
      draft.operations.some((o) => o.operationType === op)
        ? draft.operations.filter((o) => o.operationType !== op)
        : [...draft.operations, { operationType: op, feeApplication: defaultApplicationFor(op) }],
    );
  const setOpApplication = (op: FeeOperationType, feeApplication: FeeApplication) =>
    setOps(draft.operations.map((o) => (o.operationType === op ? { ...o, feeApplication } : o)));

  const setTiers = (tiers: TierForm[]) => onChange({ ...draft, tiers });
  const setTier = (i: number, patch: Partial<TierForm>) =>
    setTiers(draft.tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTier = () =>
    setTiers([
      ...draft.tiers,
      { minAmount: '', commissionType: CommissionType.FIXED, commissionValue: '' },
    ]);

  return (
    <div className="space-y-5">
      {/* Operations & per-operation fee application */}
      <div className="space-y-2">
        <Label>Operations &amp; fee</Label>
        <p className="text-xs text-muted-foreground">
          Pick which operations this rule prices. The fee tiers below apply to all of them; choose
          per operation whether the fee is <span className="font-medium">deducted</span> from the
          amount or added <span className="font-medium">on top</span> — e.g. Deposits deducted,
          Withdrawals on top, at the same fees.
        </p>
        <div className="space-y-2">
          {FEE_OPERATION_TYPES.map((op) => {
            const selected = draft.operations.find((o) => o.operationType === op);
            return (
              <div
                key={op}
                className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 p-2"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  onClick={() => toggleOperation(op)}
                >
                  {FEE_OPERATION_LABEL[op]}
                </Button>
                {selected ? (
                  <div className="inline-flex overflow-hidden rounded-md border">
                    <button
                      type="button"
                      className={`px-3 py-1.5 text-xs transition-colors ${selected.feeApplication === FeeApplication.DEDUCTED ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                      onClick={() => setOpApplication(op, FeeApplication.DEDUCTED)}
                    >
                      Deducted
                    </button>
                    <button
                      type="button"
                      className={`px-3 py-1.5 text-xs transition-colors ${selected.feeApplication === FeeApplication.ON_TOP ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                      onClick={() => setOpApplication(op, FeeApplication.ON_TOP)}
                    >
                      On top
                    </button>
                  </div>
                ) : (
                  <span className="pr-1 text-xs text-muted-foreground">not priced</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tiers — threshold model */}
      <div className="space-y-2">
        <Label>Fee tiers</Label>
        <p className="text-xs text-muted-foreground">
          Enter the amount each tier{' '}
          <span className="font-medium">starts at (that amount is included)</span> and its fee. A
          tier runs from its start up to — but <span className="font-medium">not</span> including —
          the next tier&apos;s start; the highest tier covers everything above.
        </p>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Starts at (incl.)</span>
            <span className="text-center">Fee</span>
            <span />
            <span />
          </div>
          {draft.tiers.map((t, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 rounded-md border bg-muted/20 p-2"
            >
              <Input
                inputMode="decimal"
                placeholder="0"
                value={t.minAmount}
                onChange={(e) => setTier(i, { minAmount: e.target.value })}
              />
              <div className="flex overflow-hidden rounded-md border">
                <button
                  type="button"
                  className={`px-2.5 py-2 text-xs ${t.commissionType === CommissionType.FIXED ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                  onClick={() => setTier(i, { commissionType: CommissionType.FIXED })}
                >
                  $
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-2 text-xs ${t.commissionType === CommissionType.PERCENTAGE ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
                  onClick={() => setTier(i, { commissionType: CommissionType.PERCENTAGE })}
                >
                  %
                </button>
              </div>
              <Input
                inputMode="decimal"
                placeholder={t.commissionType === CommissionType.PERCENTAGE ? '2.5' : '5'}
                value={t.commissionValue}
                onChange={(e) => setTier(i, { commissionValue: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove tier"
                disabled={draft.tiers.length === 1}
                onClick={() => setTiers(draft.tiers.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addTier}>
          <Plus className="mr-1 h-4 w-4" /> Add tier
        </Button>
        <TierPreview tiers={draft.tiers} />
      </div>

      {/* Priority */}
      <div className="space-y-2">
        <Label htmlFor="rule-priority">Priority</Label>
        <Input
          id="rule-priority"
          type="number"
          value={draft.priority}
          onChange={(e) => onChange({ ...draft, priority: Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">
          When more than one rule matches, the highest priority wins (then the most
          company-specific).
        </p>
      </div>
    </div>
  );
}

/** Live "this is what it means" preview of the tier ladder. */
function TierPreview({ tiers }: { tiers: TierForm[] }) {
  const valid = tiers.filter((t) => /^\d+(\.\d+)?$/.test(t.minAmount.trim()));
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) =>
    Money.of(a.minAmount).gt(Money.of(b.minAmount)) ? 1 : -1,
  );
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-1.5 font-medium text-muted-foreground">Preview</p>
      <ul className="space-y-1">
        {sorted.map((t, i) => {
          const next = sorted[i + 1];
          const range =
            !next && Number(t.minAmount) === 0 && sorted.length === 1
              ? 'Any amount'
              : !next
                ? `${fmt(t.minAmount)} and above`
                : Number(t.minAmount) === 0
                  ? `Under ${fmt(next.minAmount)}`
                  : `${fmt(t.minAmount)} to under ${fmt(next.minAmount)}`;
          const fee =
            t.commissionType === CommissionType.PERCENTAGE
              ? `${fmt(t.commissionValue) || '0'}%`
              : `$${fmt(t.commissionValue) || '0'}`;
          return (
            <li key={i} className="flex items-center gap-2 text-muted-foreground">
              <span className="tabular-nums">{range}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span className="font-medium text-foreground">{fee}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function fmt(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);
}
