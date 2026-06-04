import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { SourceApiKeysView } from '@/features/admin/sources/source-api-keys-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(FULL_ADMIN_ROLES);
  const { id } = await params;
  return <SourceApiKeysView sourceId={id} />;
}
