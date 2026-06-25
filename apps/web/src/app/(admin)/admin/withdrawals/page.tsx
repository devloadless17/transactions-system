import { UserRole } from '@app/shared';
import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import {
  ADMIN_WITHDRAWAL_CONFIG,
  defaultListPrefetch,
} from '@/features/admin/withdrawals/process-configs';
import { getSession } from '@/lib/session';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  const backoffice = session?.role === UserRole.BACKOFFICE;
  const superAdmin = session?.role === UserRole.SUPER_ADMIN;
  return withListPrefetch(
    [defaultListPrefetch(ADMIN_WITHDRAWAL_CONFIG)],
    <AdminWithdrawalsView
      config={ADMIN_WITHDRAWAL_CONFIG}
      backoffice={backoffice}
      superAdmin={superAdmin}
    />,
  );
}
