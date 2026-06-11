import { cn } from '@/lib/cn';

/** Neutral pulsing placeholder used while content (or a deferred chunk) loads. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
