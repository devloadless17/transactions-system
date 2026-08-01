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

// An operation the rule prices (its ladder lives in the draft's tier state).
export interface OperationDraft {
  operationType: FeeOperationType;
  feeApplication: FeeApplication;
}

// SHARED = one ladder applied to every selected operation (the common case);
// PER_TYPE = each operation edits its own ladder (deposits 1%, withdrawals 2%…).
export type TierMode = 'SHARED' | 'PER_TYPE';

// The editable rule pricing spec. The wire schema is ALWAYS per-operation tiers;
// SHARED mode is a UI convenience that copies one ladder to every operation on
// submit. Ladders live in a per-operation record so toggling an operation (or the
// mode) off and back on never loses what was typed. Name/companies live on the
// parent — they differ between the standalone rule dialog and company onboarding.
export interface RuleDraft {
  mode: TierMode;
  operations: OperationDraft[];
  sharedTiers: TierForm[];
  tiersByOp: Partial<Record<FeeOperationType, TierForm[]>>;
  priority: number;
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
const DEFAULT_OPERATIONS: OperationDraft[] = [
  FeeOperationType.TRANSACTION,
  FeeOperationType.WITHDRAWAL,
].map((operationType) => ({ operationType, feeApplication: defaultApplicationFor(operationType) }));

export function defaultRuleDraft(): RuleDraft {
  return {
    mode: 'SHARED',
    operations: DEFAULT_OPERATIONS,
    sharedTiers: DEFAULT_TIERS,
    tiersByOp: {},
    priority: 100,
  };
}

// Canonical fingerprint of a ladder — used to detect "every operation charges the
// same fees" so an edit opens in the simpler SHARED mode. Money normalizes the
// decimal strings ("1.0" === "1").
function ladderSignature(tiers: TierForm[]): string {
  return [...tiers]
    .sort((a, b) => (Money.of(a.minAmount).gt(Money.of(b.minAmount)) ? 1 : -1))
    .map(
      (t) =>
        `${Money.of(t.minAmount).toString()}|${t.commissionType}|${Money.of(t.commissionValue).toString()}`,
    )
    .join(';');
}

/** Re-derive the editable draft from a saved rule group (for editing). */
export function draftFromGroup(group: CommissionRuleGroupResponse): RuleDraft {
  const tiersByOp: Partial<Record<FeeOperationType, TierForm[]>> = {};
  for (const op of group.operations) {
    // Only the tier STARTS matter in the threshold form; max is re-derived on save.
    tiersByOp[op.operationType] = op.tiers.map((t) => ({
      minAmount: t.minAmount,
      commissionType: t.commissionType,
      commissionValue: t.commissionValue,
    }));
  }
  const ladders = Object.values(tiersByOp) as TierForm[][];
  const allSame = ladders.every((l) => ladderSignature(l) === ladderSignature(ladders[0]!));
  return {
    // Identical ladders across every operation → open in the simpler SHARED mode.
    mode: allSame ? 'SHARED' : 'PER_TYPE',
    operations: group.operations.map((o) => ({
      operationType: o.operationType,
      feeApplication: o.feeApplication,
    })),
    // Seed the shared ladder from the first operation either way, so toggling
    // between modes never starts from an empty editor.
    sharedTiers: ladders[0] ?? DEFAULT_TIERS,
    tiersByOp,
    priority: group.priority,
  };
}

/** The ladder an operation is edited/saved with under the draft's current mode. */
export function ladderFor(draft: RuleDraft, op: FeeOperationType): TierForm[] {
  if (draft.mode === 'SHARED') return draft.sharedTiers;
  return draft.tiersByOp[op] ?? draft.sharedTiers;
}

// Validate one ladder and derive the stored maxes. `label` prefixes errors when
// several ladders are in play so the admin knows which operation to fix.
function buildLadder(
  tiers: TierForm[],
  label: string | null,
):
  | { ok: true; value: CompanyScopedCommissionRuleInput['operations'][number]['tiers'] }
  | { ok: false; error: string } {
  const prefix = label ? `${label}: ` : '';
  const decimal = /^\d+(\.\d+)?$/;
  for (const t of tiers) {
    if (!decimal.test(t.minAmount.trim())) {
      return {
        ok: false,
        error: `${prefix}each tier needs a valid start amount (e.g. 0, 100, 1000).`,
      };
    }
    if (!decimal.test(t.commissionValue.trim())) {
      return { ok: false, error: `${prefix}each tier needs a fee value.` };
    }
  }
  const sorted = [...tiers].sort((a, b) =>
    Money.of(a.minAmount).gt(Money.of(b.minAmount)) ? 1 : -1,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (!Money.of(sorted[i - 1]!.minAmount).lt(Money.of(sorted[i]!.minAmount))) {
      return { ok: false, error: `${prefix}tier start amounts must be different and increasing.` };
    }
  }
  return {
    ok: true,
    // Each tier ends just below the next tier's start; the last is open-ended.
    value: sorted.map((t, i) => ({
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
}

/**
 * Validate the draft and build the company-scoped rule spec (operations, each
 * with its own derived tier ladder, priority, name, active) — WITHOUT companyIds,
 * which the caller adds (rule dialog) or the server injects (onboarding).
 */
export function buildRuleSpec(
  draft: RuleDraft,
  opts: { name: string | null; active: boolean },
): { ok: true; value: CompanyScopedCommissionRuleInput } | { ok: false; error: string } {
  if (draft.operations.length === 0) {
    return { ok: false, error: 'Pick at least one operation for the rule.' };
  }
  const operations: CompanyScopedCommissionRuleInput['operations'] = [];
  for (const op of draft.operations) {
    const ladder = buildLadder(
      ladderFor(draft, op.operationType),
      // Only prefix when ladders differ per operation — one shared ladder needs
      // no attribution.
      draft.mode === 'PER_TYPE' ? FEE_OPERATION_LABEL[op.operationType] : null,
    );
    if (!ladder.ok) return ladder;
    operations.push({
      operationType: op.operationType,
      feeApplication: op.feeApplication,
      tiers: ladder.value,
    });
  }
  const candidate = {
    name: opts.name,
    operations,
    priority: draft.priority,
    active: opts.active,
  };
  const parsed = companyScopedCommissionRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the rule.' };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The shared commission-rule editor: per-operation fee application, the fee-tier
 * ladder(s) — one shared ladder or one per operation — and priority. Controlled —
 * the parent owns the {@link RuleDraft}. Used by the standalone rule dialog AND
 * company onboarding so both stay identical.
 */
export function CommissionRuleFields({
  draft,
  onChange,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
}) {
  const setOps = (operations: OperationDraft[]) => onChange({ ...draft, operations });
  const toggleOperation = (op: FeeOperationType) => {
    if (draft.operations.some((o) => o.operationType === op)) {
      setOps(draft.operations.filter((o) => o.operationType !== op));
      return;
    }
    onChange({
      ...draft,
      operations: [
        ...draft.operations,
        { operationType: op, feeApplication: defaultApplicationFor(op) },
      ],
      // In per-type mode a newly enabled operation starts from the shared
      // ladder (kept if it had one from a previous toggle).
      tiersByOp:
        draft.mode === 'PER_TYPE' && !draft.tiersByOp[op]
          ? { ...draft.tiersByOp, [op]: draft.sharedTiers.map((t) => ({ ...t })) }
          : draft.tiersByOp,
    });
  };
  const setOpApplication = (op: FeeOperationType, feeApplication: FeeApplication) =>
    setOps(draft.operations.map((o) => (o.operationType === op ? { ...o, feeApplication } : o)));

  const setMode = (mode: TierMode) => {
    if (mode === draft.mode) return;
    if (mode === 'SHARED') {
      // Non-destructive: per-operation ladders stay in tiersByOp for a later
      // switch back.
      onChange({ ...draft, mode });
      return;
    }
    // Seed each selected operation that has no ladder yet with a copy of the
    // shared one, so per-type editing starts from what was already entered.
    const tiersByOp = { ...draft.tiersByOp };
    for (const o of draft.operations) {
      if (!tiersByOp[o.operationType]) {
        tiersByOp[o.operationType] = draft.sharedTiers.map((t) => ({ ...t }));
      }
    }
    onChange({ ...draft, mode, tiersByOp });
  };

  const setSharedTiers = (tiers: TierForm[]) => onChange({ ...draft, sharedTiers: tiers });
  const setOpTiers = (op: FeeOperationType, tiers: TierForm[]) =>
    onChange({ ...draft, tiersByOp: { ...draft.tiersByOp, [op]: tiers } });

  return (
    <div className="space-y-5">
      {/* Operations & per-operation fee application */}
      <div className="space-y-2">
        <Label>Operations &amp; fee</Label>
        <p className="text-xs text-muted-foreground">
          Pick which operations this rule prices, and per operation whether the fee is{' '}
          <span className="font-medium">deducted</span> from the amount or added{' '}
          <span className="font-medium">on top</span>. The fee tiers below can be the same for every
          operation or customized per operation.
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

      {/* Tiers — threshold model, shared or per operation */}
      <div className="space-y-2">
        <Label>Fee tiers</Label>
        <p className="text-xs text-muted-foreground">
          Enter the amount each tier{' '}
          <span className="font-medium">starts at (that amount is included)</span> and its fee. A
          tier runs from its start up to — but <span className="font-medium">not</span> including —
          the next tier&apos;s start; the highest tier covers everything above.
        </p>
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs transition-colors ${draft.mode === 'SHARED' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
            onClick={() => setMode('SHARED')}
          >
            Same fees for all operations
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-xs transition-colors ${draft.mode === 'PER_TYPE' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'}`}
            onClick={() => setMode('PER_TYPE')}
          >
            Customize per operation
          </button>
        </div>
        {draft.mode === 'SHARED' ? (
          <TierLadderEditor tiers={draft.sharedTiers} onChange={setSharedTiers} />
        ) : draft.operations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Pick at least one operation above to set its fees.
          </p>
        ) : (
          <div className="space-y-4">
            {draft.operations.map((o) => (
              <div key={o.operationType} className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">
                  {FEE_OPERATION_LABEL[o.operationType]}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {o.feeApplication === FeeApplication.ON_TOP ? 'on top' : 'deducted'}
                  </span>
                </p>
                <TierLadderEditor
                  tiers={ladderFor(draft, o.operationType)}
                  onChange={(tiers) => setOpTiers(o.operationType, tiers)}
                />
              </div>
            ))}
          </div>
        )}
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

/** One editable threshold ladder: tier rows, add button and live preview. */
function TierLadderEditor({
  tiers,
  onChange,
}: {
  tiers: TierForm[];
  onChange: (tiers: TierForm[]) => void;
}) {
  const setTier = (i: number, patch: Partial<TierForm>) =>
    onChange(tiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTier = () =>
    onChange([
      ...tiers,
      { minAmount: '', commissionType: CommissionType.FIXED, commissionValue: '' },
    ]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>Starts at (incl.)</span>
        <span className="text-center">Fee</span>
        <span />
        <span />
      </div>
      {tiers.map((t, i) => (
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
            disabled={tiers.length === 1}
            onClick={() => onChange(tiers.filter((_, idx) => idx !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addTier}>
        <Plus className="mr-1 h-4 w-4" /> Add tier
      </Button>
      <TierPreview tiers={tiers} />
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
