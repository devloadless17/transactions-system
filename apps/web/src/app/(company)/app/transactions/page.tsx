import { ActivityView } from '@/features/activity/activity-view';

export const dynamic = 'force-dynamic';

// The unified activity feed (all completed deposits/loads/withdrawals/payouts).
// The default range is date-dependent, so we skip SSR prefetch and let the
// client fetch on mount.
export default function Page() {
  return <ActivityView scope="company" />;
}
