import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CompanyDetailView } from '@/features/admin/companies/company-detail-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  // Company detail exposes analytics, audit, wallets & team management — full
  // admins only. Back office can list companies but not drill into one.
  await requireRole(FULL_ADMIN_ROLES);
  const { id } = await params;
  return <CompanyDetailView companyId={id} />;
}
