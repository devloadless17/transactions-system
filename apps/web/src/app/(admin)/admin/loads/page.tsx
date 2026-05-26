import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import { ADMIN_LOAD_CONFIG } from '@/features/admin/withdrawals/process-configs';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <AdminWithdrawalsView config={ADMIN_LOAD_CONFIG} />;
}
