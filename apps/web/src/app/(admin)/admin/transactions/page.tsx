import { UserRole } from '@app/shared';
import { ActivityView } from '@/features/activity/activity-view';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

// The unified activity feed (all completed deposits/loads/withdrawals/payouts
// across companies). The default range is date-dependent, so we skip SSR
// prefetch and let the client fetch on mount.
export default async function Page() {
  // Back office sees each operation's single amount, never a platform fee.
  const session = await getSession();
  const backoffice = session?.role === UserRole.BACKOFFICE;
  return <ActivityView scope="admin" backoffice={backoffice} />;
}
