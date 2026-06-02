import { SourceDetailView } from '@/features/admin/sources/source-detail-view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SourceDetailView sourceId={id} />;
}
