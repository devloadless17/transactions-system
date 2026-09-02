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
  // A company's IDENTITY — its display name and its slug — is SUPER_ADMIN-only.
  // The API enforces both per-field in CompaniesService.update; this prop just
  // hides the controls. One prop, because the two share one rule and one role
  // check: two props here could only ever drift apart wrongly.
  return (
    <CompanyDetailView companyId={id} canEditIdentity={session.role === UserRole.SUPER_ADMIN} />
  );
}
