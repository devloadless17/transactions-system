import { PageSkeleton } from '@/components/page-skeleton';

/**
 * Instant navigation feedback for every page under /admin. Without this boundary
 * the router blocks on the (force-dynamic) server render — including its data
 * prefetch — before swapping pages, which reads as a frozen/heavy UI. This lets
 * the skeleton paint immediately and also lets <Link> prefetch routes up to here.
 */
export default function Loading() {
  return <PageSkeleton />;
}
