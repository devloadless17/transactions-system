import { TransactionsView } from '@/features/admin/transactions/transactions-view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <TransactionsView scope="admin" />;
}
