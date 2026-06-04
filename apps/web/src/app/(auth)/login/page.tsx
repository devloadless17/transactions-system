import { redirect } from 'next/navigation';
import { ADMIN_ROLES, COMPANY_ROLES } from '@app/shared';
import { getSession } from '@/lib/session';
import { adminLandingPath } from '@/features/admin/access';
import { LoginForm } from '@/features/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function LoginPage() {
  const session = await getSession();
  if (session) {
    if (ADMIN_ROLES.includes(session.role)) redirect(adminLandingPath(session.role));
    if (COMPANY_ROLES.includes(session.role)) redirect('/app');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your platform credentials to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  );
}
