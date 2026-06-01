'use client';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CommissionType,
  updateCommissionRuleSchema,
  type CommissionRuleResponse,
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
  onClose: () => void;
  onSaved: () => void;
}

export function EditCommissionRuleDialog({ rule, onClose, onSaved }: Props) {
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

  // Reset form whenever the targeted rule changes.
  useEffect(() => {
    if (rule) {
      reset({
        minAmount: rule.minAmount,
        maxAmount: rule.maxAmount,
        commissionType: rule.commissionType,
        commissionValue: rule.commissionValue,
        priority: rule.priority,
        active: rule.active,
      });
    }
  }, [rule, reset]);

  const type = watch('commissionType');

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
            Scope (company / source) is fixed at creation — create a new rule if you need to change
            scope.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => mu.mutate(values))} className="space-y-4">
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
          <div className="space-y-2">
            <Label htmlFor="priority">Priority</Label>
            <Input id="priority" type="number" {...register('priority', { valueAsNumber: true })} />
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
