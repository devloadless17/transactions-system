import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { ChangePasswordForm } from '@/features/auth/change-password-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function ChangePasswordPage() {
  const session = await requireSession();
  // If they don't need to change their password, send them home.
  if (!session.mustChangePassword) redirect('/');

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>
            Your account uses a temporary password. Choose a new one before continuing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm forced />
        </CardContent>
      </Card>
    </div>
  );
}
