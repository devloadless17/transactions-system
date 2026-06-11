import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Generic page placeholder shown during route navigation (via each route
 * group's `loading.tsx`). The authenticated layout — sidebar + topbar — stays
 * mounted, so this only fills the `<main>` content area: navigation feels
 * instant (skeleton paints immediately) while the server renders the real page.
 *
 * Neutral on purpose: it reads sensibly for dashboards, tables, and detail
 * views alike, so one component covers every page in a group.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header: title + subtitle on the left, controls on the right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>

      {/* Row of summary cards. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Wide content block: chart, table, or detail panel. */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
