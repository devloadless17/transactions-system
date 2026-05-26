import { CompanyDetailView } from '@/features/admin/companies/company-detail-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompanyDetailView companyId={id} />;
}
