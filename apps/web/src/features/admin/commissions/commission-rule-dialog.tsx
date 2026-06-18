'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import {
  createCommissionRuleGroupSchema,
  CommissionType,
  FeeApplication,
  FeeOperationType,
  FEE_OPERATION_TYPES,
  Money,
  type CommissionRuleGroupResponse,
  type CompanyResponse,
} from '@app/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { CompanyMultiSelect } from './company-multi-select';

// Threshold tiers: the admin enters only the amount each tier STARTS at + its fee.
// A tier runs from its start up to the next tier's start; the highest tier covers
// everything above. We derive each row's stored max on submit.
interface TierForm {
  minAmount: string;
  commissionType: CommissionType;
  commissionValue: string;
}

const DEFAULT_TIERS: TierForm[] = [
  { minAmount: '0', commissionType: CommissionType.FIXED, commissionValue: '1' },
];

// Smallest representable step at the ledger's Decimal(20,8) scale — a tier's max
// is the next tier's start minus this, so brackets are contiguous with no overlap.
const EPSILON = '0.00000001';

function titleCase(op: FeeOperationType): string {
  return op.charAt(0) + op.slice(1).toLowerCase();
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companies: CompanyResponse[];
  group?: CommissionRuleGroupResponse | null;
  onSaved: () => void;
}

export function CommissionRuleDialog({ open, onOpenChange, companies, group, onSaved }: Props) {
  const editing = !!group;
  const [name, setName] = useState('');
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [operations, setOperations] = useState<FeeOperationType[]>([
    FeeOperationType.TRANSACTION,
    FeeOperationType.WITHDRAWAL,
  ]);
  const [feeApplication, setFeeApplication] = useState<FeeApplication>(FeeApplication.DEDUCTED);
  const [priority, setPriority] = useState(100);
  const [tiers, setTiers] = useState<TierForm[]>(DEFAULT_TIERS);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (group) {
      setName(group.name ?? '');
      setCompanyIds(group.companyIds ?? []);
      setOperations(group.operationTypes);
      setFeeApplication(group.feeApplication);
      setPriority(group.priority);
      // Re-derive the threshold form from the stored tiers: only the starts matter.
      setTiers(
        group.tiers.map((t) => ({
          minAmount: t.minAmount,
          commissionType: t.commissionType,
          commissionValue: t.commissionValue,
        })),
      );
    } else {
      setName('');
      setCompanyIds([]);
      setOperations([FeeOperationType.TRANSACTION, FeeOperationType.WITHDRAWAL]);
      setFeeApplication(FeeApplication.DEDUCTED);
      setPriority(100);
      setTiers(DEFAULT_TIERS);
    }
  }, [open, group]);

  function toggleOperation(op: FeeOperationType) {
    setOperations((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]));
  }

  function setTier(i: number, patch: Partial<TierForm>) {
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }

  function addTier() {
    setTiers((prev) => [
      ...prev,
      { minAmount: '', commissionType: CommissionType.FIXED, commissionValue: '' },
    ]);
  }

  async function submit() {
    // Validate the starts are valid, non-negative, and strictly ascending.
    const decimal = /^\d+(\.\d+)?$/;
    for (const t of tiers) {
      if (!decimal.test(t.minAmount.trim())) {
        toast.error('Each tier needs a valid start amount (e.g. 0, 100, 1000).');
        return;
      }
      if (!decimal.test(t.commissionValue.trim())) {
        toast.error('Each tier needs a fee value.');
        return;
      }
    }
    const sorted = [...tiers].sort((a, b) =>
      Money.of(a.minAmount).gt(Money.of(b.minAmount)) ? 1 : -1,
    );
    for (let i = 1; i < sorted.length; i++) {
      if (!Money.of(sorted[i - 1]!.minAmount).lt(Money.of(sorted[i]!.minAmount))) {
        toast.error('Tier start amounts must be different and increasing.');
        return;
      }
    }

    const input = {
      name: name.trim() || null,
      companyIds: companyIds.length ? companyIds : null,
      operationTypes: operations,
      feeApplication,
      priority,
      active: group?.active ?? true,
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

    const parsed = createCommissionRuleGroupSchema.safeParse(input);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        await apiFetch(`/admin/commission-rules/${group.groupId}`, {
          method: 'PATCH',
          body: parsed.data,
        });
        toast.success('Rule updated');
      } else {
        await apiFetch('/admin/commission-rules', { method: 'POST', body: parsed.data });
        toast.success('Rule created');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit commission rule' : 'New commission rule'}</DialogTitle>
          <DialogDescription>
            Apply the same fee tiers to a set of companies and operations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="rule-name">
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="rule-name"
              placeholder="e.g. Standard fees, VIP partners…"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A label so you can recognise this rule later.
            </p>
          </div>

          {/* Companies */}
          <div className="space-y-2">
            <Label>Companies</Label>
            <CompanyMultiSelect companies={companies} value={companyIds} onChange={setCompanyIds} />
            <p className="text-xs text-muted-foreground">
              Leave empty to apply to <span className="font-medium">all companies</span>.
            </p>
          </div>

          {/* Operations */}
          <div className="space-y-2">
            <Label>Operations</Label>
            <div className="flex flex-wrap gap-2">
              {FEE_OPERATION_TYPES.map((op) => (
                <Button
                  key={op}
                  type="button"
                  size="sm"
                  variant={operations.includes(op) ? 'default' : 'outline'}
                  onClick={() => toggleOperation(op)}
                >
                  {titleCase(op)}
                </Button>
              ))}
            </div>
          </div>

          {/* Tiers — threshold model */}
          <div className="space-y-2">
            <Label>Fee tiers</Label>
            <p className="text-xs text-muted-foreground">
              Enter the amount each tier <span className="font-medium">starts at</span> and its fee.
              Every tier applies up to the next tier&apos;s start — the highest tier covers
              everything above it.
            </p>
            <div className="space-y-2">
              {/* column hint */}
              <div className="grid grid-cols-[1fr_auto_1fr_2rem] items-center gap-2 px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span>Starts at</span>
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
                    onClick={() => setTiers((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addTier}>
              <Plus className="mr-1 h-4 w-4" /> Add tier
            </Button>
            <TierPreview tiers={tiers} />
          </div>

          {/* Advanced */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>Fee application</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={feeApplication === FeeApplication.DEDUCTED ? 'default' : 'outline'}
                  onClick={() => setFeeApplication(FeeApplication.DEDUCTED)}
                >
                  Deducted
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={feeApplication === FeeApplication.ON_TOP ? 'default' : 'outline'}
                  onClick={() => setFeeApplication(FeeApplication.ON_TOP)}
                >
                  On top
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={submitting} onClick={submit}>
            {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                  ? `Up to ${fmt(next.minAmount)}`
                  : `${fmt(t.minAmount)} – ${fmt(next.minAmount)}`;
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
