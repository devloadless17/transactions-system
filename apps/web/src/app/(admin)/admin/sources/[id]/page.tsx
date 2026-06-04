import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { SourceDetailView } from '@/features/admin/sources/source-detail-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(FULL_ADMIN_ROLES);
  const { id } = await params;
  return <SourceDetailView sourceId={id} />;
}
