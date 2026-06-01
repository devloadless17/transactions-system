'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createCommissionRuleSchema,
  CommissionType,
  FeeApplication,
  FeeOperationType,
  FEE_OPERATION_TYPES,
  type CommissionRuleResponse,
  type CompanyResponse,
  type CreateCommissionRuleInput,
  type SourceResponse,
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: SourceResponse[];
  companies: CompanyResponse[];
  onCreated: () => void;
}

export function CreateCommissionRuleDialog({
  open,
  onOpenChange,
  sources,
  companies,
  onCreated,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateCommissionRuleInput>({
    resolver: zodResolver(createCommissionRuleSchema),
    defaultValues: {
      companyId: null,
      sourceId: null,
      operationType: FeeOperationType.TRANSACTION,
      feeApplication: FeeApplication.DEDUCTED,
      minAmount: '0',
      maxAmount: '100',
      commissionType: CommissionType.FIXED,
      commissionValue: '1',
      priority: 100,
      active: true,
    },
  });

  const companyId = watch('companyId');
  const sourceId = watch('sourceId');
  const type = watch('commissionType');
  const operationType = watch('operationType');
  const feeApplication = watch('feeApplication');

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await apiFetch<CommissionRuleResponse>('/admin/commission-rules', {
        method: 'POST',
        body: values,
      });
      toast.success('Rule created');
      reset();
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New commission rule</DialogTitle>
          <DialogDescription>
            Scope this rule to a company, a source, both, or leave both blank for a global rule.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
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
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
