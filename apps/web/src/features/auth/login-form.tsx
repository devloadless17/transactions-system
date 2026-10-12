'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  ADMIN_ROLES,
  COMPANY_ROLES,
  loginSchema,
  type LoginInput,
  type MeResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { adminLandingPath } from '@/features/admin/access';

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const me = await apiFetch<MeResponse>('/auth/login', { method: 'POST', body: values });
      // Start this session from an empty query cache. Whatever is in it belongs
      // to whoever used this tab before (sign-out, a password change and the
      // server's redirect of a lapsed session all arrive here by soft
      // navigation), and query keys carry no user or role — so it would render
      // for this user: a full admin's unredacted rows for back office, one
      // company's data for another's. Cleared BEFORE navigating, so the landing
      // page hydrates its server-prefetched data into an empty cache.
      qc.clear();
      toast.success('Signed in');
      // Pick landing page based on role.
      if (ADMIN_ROLES.includes(me.role)) router.push(adminLandingPath(me.role));
      else if (COMPANY_ROLES.includes(me.role)) router.push('/app');
      else router.push('/');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : 'Unable to sign in. Please try again.';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <PasswordInput id="password" autoComplete="current-password" {...register('password')} />
        {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
