import { redirect } from 'next/navigation';
import { ADMIN_ROLES, COMPANY_ROLES } from '@app/shared';
import { getSession } from '@/lib/session';
import { adminLandingPath } from '@/features/admin/access';

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (ADMIN_ROLES.includes(session.role)) redirect(adminLandingPath(session.role));
  if (COMPANY_ROLES.includes(session.role)) redirect('/app');
  redirect('/login');
}
