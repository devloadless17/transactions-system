import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { SourcesView } from '@/features/admin/sources/sources-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  await requireRole(FULL_ADMIN_ROLES);
  // Prefetch the sources list so the table renders populated on first paint.
  return withListPrefetch(
    [{ queryKey: ['admin', 'sources'], path: '/admin/sources?pageSize=100' }],
    <SourcesView />,
  );
}
