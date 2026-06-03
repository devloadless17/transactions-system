'use client';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CommissionType,
  FeeApplication,
  FeeOperationType,
  FEE_OPERATION_TYPES,
  updateCommissionRuleSchema,
  type CommissionRuleResponse,
  type CompanyResponse,
  type SourceResponse,
  type UpdateCommissionRuleInput,
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

interface Props {
  rule: CommissionRuleResponse | null;
  sources: SourceResponse[];
  companies: CompanyResponse[];
  onClose: () => void;
  onSaved: () => void;
}

export function EditCommissionRuleDialog({ rule, sources, companies, onClose, onSaved }: Props) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<UpdateCommissionRuleInput>({
    resolver: zodResolver(updateCommissionRuleSchema),
    defaultValues: {},
  });

  // Reset form whenever the targeted rule changes, populating every field so the
  // whole rule can be edited (not just amounts/type/priority).
  useEffect(() => {
    if (rule) {
      reset({
        companyId: rule.companyId,
        sourceId: rule.sourceId,
        operationType: rule.operationType,
        feeApplication: rule.feeApplication,
        minAmount: rule.minAmount,
        maxAmount: rule.maxAmount,
        commissionType: rule.commissionType,
        commissionValue: rule.commissionValue,
        priority: rule.priority,
        active: rule.active,
      });
    }
  }, [rule, reset]);

  const companyId = watch('companyId');
  const sourceId = watch('sourceId');
  const type = watch('commissionType');
  const operationType = watch('operationType');
  const feeApplication = watch('feeApplication');
  const active = watch('active');

  const mu = useMutation({
    mutationFn: (input: UpdateCommissionRuleInput) => {
      if (!rule) throw new Error('no rule');
      return apiFetch<CommissionRuleResponse>(`/admin/commission-rules/${rule.id}`, {
        method: 'PATCH',
        body: input,
      });
    },
    onSuccess: () => {
      toast.success('Rule updated');
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  return (
    <Dialog open={!!rule} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit commission rule</DialogTitle>
          <DialogDescription>
            Edit any field of this rule — operation, scope, fee application, range, value, priority,
            or active state.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => mu.mutate(values))} className="space-y-4">
          <div className="space-y-2">
            <Label>Operation</Label>
            <div className="flex flex-wrap gap-2">
              {FEE_OPERATION_TYPES.map((op) => (
                <Button
                  key={op}
                  type="button"
                  size="sm"
                  variant={operationType === op ? 'default' : 'outline'}
                  onClick={() => {
                    setValue('operationType', op);
                    if (op !== FeeOperationType.TRANSACTION) setValue('sourceId', null);
                  }}
                >
                  {op.charAt(0) + op.slice(1).toLowerCase()}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="companyId">Company (optional)</Label>
              <select
                id="companyId"
                value={companyId ?? ''}
                onChange={(e) => setValue('companyId', e.target.value || null)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">(global)</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {operationType === FeeOperationType.TRANSACTION ? (
              <div className="space-y-2">
                <Label htmlFor="sourceId">Source (optional)</Label>
                <select
                  id="sourceId"
                  value={sourceId ?? ''}
                  onChange={(e) => setValue('sourceId', e.target.value || null)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">(global)</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Fee application</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={feeApplication === 'DEDUCTED' ? 'default' : 'outline'}
                    onClick={() => setValue('feeApplication', FeeApplication.DEDUCTED)}
                  >
                    Deducted
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={feeApplication === 'ON_TOP' ? 'default' : 'outline'}
                    onClick={() => setValue('feeApplication', FeeApplication.ON_TOP)}
                  >
                    On top
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="minAmount">Min amount</Label>
              <Input id="minAmount" {...register('minAmount')} />
              {errors.minAmount && (
                <p className="text-sm text-destructive">{errors.minAmount.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxAmount">Max amount</Label>
              <Input id="maxAmount" {...register('maxAmount')} />
              {errors.maxAmount && (
                <p className="text-sm text-destructive">{errors.maxAmount.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={type === 'FIXED' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setValue('commissionType', 'FIXED' as CommissionType)}
                >
                  Fixed
                </Button>
                <Button
                  type="button"
                  variant={type === 'PERCENTAGE' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setValue('commissionType', 'PERCENTAGE' as CommissionType)}
                >
                  Percentage
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="commissionValue">
                {type === 'PERCENTAGE' ? 'Percent' : 'Amount'}
              </Label>
              <Input id="commissionValue" {...register('commissionValue')} />
              {errors.commissionValue && (
                <p className="text-sm text-destructive">{errors.commissionValue.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                {...register('priority', { valueAsNumber: true })}
              />
            </div>
            <div className="space-y-2">
              <Label>Active</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  onClick={() => setValue('active', true)}
                >
                  Active
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={active === false ? 'default' : 'outline'}
                  onClick={() => setValue('active', false)}
                >
                  Inactive
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mu.isPending}>
              {mu.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
