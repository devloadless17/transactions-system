'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import {
  createCompanySchema,
  FEE_OPERATION_LABEL,
  SUPPORTED_CURRENCIES,
  type CommissionRuleGroupResponse,
  type CreateCompanyInput,
  type CreateCompanyResponse,
  type PaginatedResponse,
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
import {
  CommissionRuleFields,
  buildRuleSpec,
  defaultRuleDraft,
  draftFromGroup,
  type RuleDraft,
} from '@/features/admin/commissions/rule-fields';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

// A readable label for an existing rule in the picker.
function ruleLabel(g: CommissionRuleGroupResponse): string {
  const ops = g.operations.map((o) => FEE_OPERATION_LABEL[o.operationType]).join(' / ');
  return g.name?.trim() || `Rule · ${ops || 'no operations'}`;
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
    defaultValues: { name: '', slug: '', defaultCurrency: 'USD', ownerEmail: '' },
  });
  const currency = watch('defaultCurrency');

  // Starter commission rule. 'new' = build one (editor), a groupId = start from
  // that existing rule (prefills the same editor; saved as THIS company's own
  // rule), 'skip' = leave unpriced (configure later).
  const [ruleChoice, setRuleChoice] = useState<'new' | 'skip' | string>('new');
  const [draft, setDraft] = useState<RuleDraft>(defaultRuleDraft);

  // Existing rules to pick from (cloned into the new company's own rule on save).
  const rulesQ = useQuery({
    queryKey: ['admin', 'commission-rules', 'picker'],
    queryFn: () =>
      apiFetch<PaginatedResponse<CommissionRuleGroupResponse>>(
        '/admin/commission-rules?page=1&pageSize=100',
      ),
    enabled: open,
  });
  const groups = rulesQ.data?.data ?? [];

  useEffect(() => {
    if (!open) {
      setRuleChoice('new');
      setDraft(defaultRuleDraft());
    }
  }, [open]);

  function selectRule(choice: string) {
    setRuleChoice(choice);
    if (choice === 'new') setDraft(defaultRuleDraft());
    else if (choice !== 'skip') {
      const g = groups.find((x) => x.groupId === choice);
      if (g) setDraft(draftFromGroup(g));
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    let commission: CreateCompanyInput['commission'];
    if (ruleChoice !== 'skip') {
      const built = buildRuleSpec(draft, { name: `${values.name} fees`, active: true });
      if (!built.ok) {
        toast.error(built.error);
        return;
      }
      commission = built.value;
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
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to create company');
    } finally {
      setSubmitting(false);
    }
  });

  function handleClose(next: boolean) {
    if (!next && result) {
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
                Provisions the tenant, an owner user, a default wallet, and (optionally) its
                commission rule.
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

              {/* Starter commission rule: new, from an existing rule, or skip. */}
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="rule-choice">Commission rule</Label>
                  <select
                    id="rule-choice"
                    className="h-9 max-w-[16rem] rounded-md border border-input bg-background px-2 text-sm"
                    value={ruleChoice}
                    onChange={(e) => selectRule(e.target.value)}
                  >
                    <option value="new">Create a new rule</option>
                    {groups.length > 0 && (
                      <optgroup label="Start from an existing rule">
                        {groups.map((g) => (
                          <option key={g.groupId} value={g.groupId}>
                            {ruleLabel(g)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="skip">Skip for now</option>
                  </select>
                </div>

                {ruleChoice === 'skip' ? (
                  <p className="text-xs text-muted-foreground">
                    Heads up — this company won&apos;t be able to receive transactions until a
                    commission rule (or a platform-wide default rule) covers it. You can add one
                    later under Commissions.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {ruleChoice !== 'new' && (
                      <p className="text-xs text-muted-foreground">
                        Prefilled from an existing rule — tweak it below if you like. It&apos;s
                        saved as <span className="font-medium">this company&apos;s own</span> rule.
                      </p>
                    )}
                    <CommissionRuleFields draft={draft} onChange={setDraft} />
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
