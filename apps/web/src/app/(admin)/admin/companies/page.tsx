import { getSession } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CompaniesView } from '@/features/admin/companies/companies-view';

export const dynamic = 'force-dynamic';

export default async function CompaniesPage() {
  // Layout already guarantees an admin session. Back office sees a read-only
  // list (no create, no drill-in); full admins manage companies.
  const session = await getSession();
  const canManage = !!session && FULL_ADMIN_ROLES.includes(session.role);
  return <CompaniesView canManage={canManage} />;
}
