import { NotificationsView } from '@/features/notifications/notifications-view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <NotificationsView scope="admin" />;
}
