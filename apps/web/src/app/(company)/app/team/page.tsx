import { UserRole } from '@app/shared';
import { TeamView } from '@/features/company/team-view';
import { getSession } from '@/lib/session';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Only an owner may reset a teammate's password, and never their own. The API
  // enforces both; these flags just keep the button from appearing where it
  // would always fail.
  const session = await getSession();
  const isOwner = session?.role === UserRole.COMPANY_OWNER;

  // Prefetch the team member list so the table renders populated on first paint.
  return withListPrefetch(
    [{ queryKey: ['company', 'team'], path: '/company/team' }],
    <TeamView isOwner={isOwner} currentUserId={session?.id ?? null} />,
  );
}
