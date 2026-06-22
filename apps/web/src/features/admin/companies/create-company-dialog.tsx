'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  createCompanySchema,
  CommissionType,
  FeeApplication,
  FeeOperationType,
  SUPPORTED_CURRENCIES,
  type CompanyScopedCommissionRuleInput,
  type CreateCompanyInput,
  type CreateCompanyResponse,
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
import { cn } from '@/lib/cn';

const ALL_OPS = Object.values(FeeOperationType);
// Default selection matches the Commissions page's new-rule default: a starter
// rule covers Deposits + Withdrawals (Payouts/Loads stay opt-in).
const DEFAULT_OPS: FeeOperationType[] = [FeeOperationType.TRANSACTION, FeeOperationType.WITHDRAWAL];
const OP_LABEL: Record<FeeOperationType, string> = {
  TRANSACTION: 'Deposits',
  WITHDRAWAL: 'Withdrawals',
  PAYOUT: 'Payouts',
  LOAD: 'Loads',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreateCompanyDialog({ open, onOpenChange, onCreated }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateCompanyResponse | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
    setValue,
    watch,
  } = useForm<CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: {
      name: '',
      slug: '',
      defaultCurrency: 'USD',
      ownerEmail: '',
    },
  });
  const currency = watch('defaultCurrency');

  // Starter commission rule, created atomically with the company. "Skip" leaves
  // the company unpriced — it can't receive transactions until a rule (or a
  // platform-wide default) exists.
  const [pricing, setPricing] = useState<'now' | 'skip'>('now');
  const [feeType, setFeeType] = useState<CommissionType>(CommissionType.PERCENTAGE);
  const [feeValue, setFeeValue] = useState('');
  const [feeApp, setFeeApp] = useState<FeeApplication>(FeeApplication.DEDUCTED);
  const [ops, setOps] = useState<FeeOperationType[]>(DEFAULT_OPS);

  // Reset the commission section whenever the dialog is closed.
  useEffect(() => {
    if (!open) {
      setPricing('now');
      setFeeType(CommissionType.PERCENTAGE);
      setFeeValue('');
      setFeeApp(FeeApplication.DEDUCTED);
      setOps(DEFAULT_OPS);
    }
  }, [open]);

  const toggleOp = (op: FeeOperationType) =>
    setOps((cur) => (cur.includes(op) ? cur.filter((o) => o !== op) : [...cur, op]));

  const onSubmit = handleSubmit(async (values) => {
    let commission: CompanyScopedCommissionRuleInput | undefined;
    if (pricing === 'now') {
      if (!feeValue.trim()) {
        toast.error('Enter a fee value, or choose “Skip for now”.');
        return;
      }
      if (ops.length === 0) {
        toast.error('Pick at least one operation for the commission rule.');
        return;
      }
      commission = {
        name: `${values.name} fees`,
        operationTypes: ops,
        feeApplication: feeApp,
        priority: 100,
        active: true,
        tiers: [
          {
            minAmount: '0',
            maxAmount: null,
            commissionType: feeType,
            commissionValue: feeValue.trim(),
          },
        ],
      };
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<CreateCompanyResponse>('/admin/companies', {
        method: 'POST',
        body: { ...values, commission },
      });
      setResult(res);
      toast.success(`Created company ${res.company.name}`);
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'Failed to create company';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  });

  function handleClose(next: boolean) {
    if (!next && result) {
      // Closing after success — refresh parent.
      onCreated();
      setResult(null);
      reset();
    } else if (!next) {
      reset();
      onOpenChange(false);
    } else {
      onOpenChange(next);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {result ? (
          <SuccessView
            result={result}
            onClose={() => {
              setResult(null);
              reset();
              onCreated();
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create company</DialogTitle>
              <DialogDescription>
                Provisions the tenant, an owner user, and a default wallet.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...register('name')} />
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">Slug</Label>
                <Input id="slug" placeholder="acme-corp" {...register('slug')} />
                {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Default currency</Label>
                <div className="flex flex-wrap gap-2">
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant={c === currency ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setValue('defaultCurrency', c, { shouldValidate: true })}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
                {errors.defaultCurrency && (
                  <p className="text-sm text-destructive">{errors.defaultCurrency.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="ownerEmail">Owner email</Label>
                <Input id="ownerEmail" type="email" {...register('ownerEmail')} />
                {errors.ownerEmail && (
                  <p className="text-sm text-destructive">{errors.ownerEmail.message}</p>
                )}
              </div>

              {/* Starter commission rule — set pricing now so the company can take
                  transactions immediately, or skip and configure it later. */}
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label>Commission rule</Label>
                  <div className="inline-flex rounded-md border p-0.5">
                    {(['now', 'skip'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPricing(m)}
                        className={cn(
                          'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                          pricing === m
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {m === 'now' ? 'Set now' : 'Skip for now'}
                      </button>
                    ))}
                  </div>
                </div>

                {pricing === 'skip' ? (
                  <p className="text-xs text-muted-foreground">
                    Heads up — this company won&apos;t be able to receive transactions until a
                    commission rule (or a platform-wide default rule) covers it. You can add one
                    later under Commissions.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-end gap-2">
                      <div className="inline-flex rounded-md border p-0.5">
                        {[CommissionType.PERCENTAGE, CommissionType.FIXED].map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setFeeType(t)}
                            className={cn(
                              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                              feeType === t
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {t === CommissionType.PERCENTAGE ? 'Percentage' : 'Fixed'}
                          </button>
                        ))}
                      </div>
                      <div className="relative flex-1">
                        <Input
                          inputMode="decimal"
                          placeholder={
                            feeType === CommissionType.PERCENTAGE ? 'e.g. 2.5' : 'e.g. 1.00'
                          }
                          value={feeValue}
                          onChange={(e) => setFeeValue(e.target.value)}
                          aria-label="Fee value"
                        />
                        <span className="pointer-events-none absolute right-3 top-2.5 text-xs text-muted-foreground">
                          {feeType === CommissionType.PERCENTAGE ? '%' : currency}
                        </span>
                      </div>
                    </div>

                    <div className="inline-flex rounded-md border p-0.5">
                      {[FeeApplication.DEDUCTED, FeeApplication.ON_TOP].map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => setFeeApp(a)}
                          className={cn(
                            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                            feeApp === a
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {a === FeeApplication.DEDUCTED ? 'Deduct from amount' : 'Add on top'}
                        </button>
                      ))}
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">Applies to</span>
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_OPS.map((op) => (
                          <button
                            key={op}
                            type="button"
                            onClick={() => toggleOp(op)}
                            className={cn(
                              'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                              ops.includes(op)
                                ? 'border-primary bg-primary/10 text-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {OP_LABEL[op]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Creates one open-ended tier; refine tiers later under Commissions.
                    </p>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SuccessView({ result, onClose }: { result: CreateCompanyResponse; onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Company created</DialogTitle>
        <DialogDescription>
          Share these credentials with the new owner. The temporary password is shown only once.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <Row label="Name" value={result.company.name} />
        <Row label="Slug" value={result.company.slug} />
        <Row label="Owner email" value={result.owner.email} />
        <Row label="Temporary password" value={result.owner.temporaryPassword} mono />
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    </div>
  );
}
