import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CompanyDetailView } from '@/features/admin/companies/company-detail-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  // Company detail exposes analytics, audit, wallets & team management — full
  // admins only. Back office can list companies but not drill into one.
  const session = await requireRole(FULL_ADMIN_ROLES);
  const { id } = await params;
  // The slug is the public identifier sources ingest with — renaming it is
  // SUPER_ADMIN-only (the API enforces this; the prop just hides the control).
  return <CompanyDetailView companyId={id} canEditSlug={session.role === UserRole.SUPER_ADMIN} />;
}
