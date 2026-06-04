import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { SourcesView } from '@/features/admin/sources/sources-view';

export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  await requireRole(FULL_ADMIN_ROLES);
  return <SourcesView />;
}
