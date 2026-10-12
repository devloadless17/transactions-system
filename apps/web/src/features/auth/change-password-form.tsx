'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

// Client-side UX schema (the server's changePasswordSchema is the authority).
// Adds the confirm field + match check so a mistyped new password is caught
// before it locks the user out.
const formSchema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: z.string().min(6, 'must be at least 6 characters').max(128),
    confirmPassword: z.string().min(1, 'Required'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from current',
    path: ['newPassword'],
  });
type FormValues = z.infer<typeof formSchema>;

export function ChangePasswordForm({ forced = false }: { forced?: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    setSubmitting(true);
    try {
      await apiFetch<void>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      toast.success('Password changed — please sign in again');
      // Backend clears the access cookie; route to login. That is a sign-out by
      // soft navigation, so this user's cached data goes too (see QueryProvider).
      qc.clear();
      router.push('/login');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to change password');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="currentPassword">
          {forced ? 'Temporary password' : 'Current password'}
        </Label>
        <PasswordInput
          id="currentPassword"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        {errors.currentPassword && (
          <p className="text-sm text-destructive">{errors.currentPassword.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="newPassword">New password</Label>
        <PasswordInput id="newPassword" autoComplete="new-password" {...register('newPassword')} />
        {errors.newPassword && (
          <p className="text-sm text-destructive">{errors.newPassword.message}</p>
        )}
        <p className="text-xs text-muted-foreground">At least 6 characters.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p className="text-sm text-destructive">{errors.confirmPassword.message}</p>
        )}
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save and sign in again'}
      </Button>
    </form>
  );
}
