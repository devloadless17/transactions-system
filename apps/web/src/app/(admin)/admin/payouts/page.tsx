import { UserRole } from '@app/shared';
import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import {
  ADMIN_PAYOUT_CONFIG,
  defaultListPrefetch,
} from '@/features/admin/withdrawals/process-configs';
import { getSession } from '@/lib/session';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  const backoffice = session?.role === UserRole.BACKOFFICE;
  return withListPrefetch(
    [defaultListPrefetch(ADMIN_PAYOUT_CONFIG)],
    <AdminWithdrawalsView config={ADMIN_PAYOUT_CONFIG} backoffice={backoffice} />,
  );
}
