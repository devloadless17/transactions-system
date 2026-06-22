import { TeamView } from '@/features/company/team-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Prefetch the team member list so the table renders populated on first paint.
  return withListPrefetch([{ queryKey: ['company', 'team'], path: '/company/team' }], <TeamView />);
}
