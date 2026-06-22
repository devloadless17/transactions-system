import { SourcesView } from '@/features/company/sources-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Prefetch the sources list (key ['sources','all'], path /admin/sources/all) so
  // the table renders populated on first paint instead of flashing a skeleton.
  return withListPrefetch(
    [{ queryKey: ['sources', 'all'], path: '/admin/sources/all' }],
    <SourcesView />,
  );
}
