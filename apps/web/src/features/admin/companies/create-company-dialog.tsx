'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createCompanySchema,
  SUPPORTED_CURRENCIES,
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

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const res = await apiFetch<CreateCompanyResponse>('/admin/companies', {
        method: 'POST',
        body: values,
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
