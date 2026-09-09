import type { Request, Response, NextFunction } from 'express';

/**
 * Mark every API response as uncacheable.
 *
 * This API is authenticated and every response is tenant-scoped, so a shared
 * cache entry is a cross-tenant leak waiting to happen: two companies asking
 * for the same report over the same date range produce a BYTE-IDENTICAL URL
 * (`/company/activity/export.csv?from=…&to=…`), and the only thing separating
 * their data is the session cookie. Without a directive, a browser, a corporate
 * proxy or a CDN may reuse the first tenant's response for the second — the CSV
 * exports especially, since a `.csv` path is on Cloudflare's default
 * cache-by-extension list.
 *
 * Reported 2026-09-09: a partner operating two merchant accounts exported from
 * one session and opened a file belonging to the other. Our own scoping was
 * correct (RLS proves it — see the activity-feed export isolation test), but
 * nothing told the caches that.
 *
 * `no-store` (not merely `no-cache`) is deliberate: it forbids writing the
 * response to disk at all, rather than allowing a stored copy to be revalidated.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, private');
  // Belt and braces for any intermediary that still keys on URL alone.
  res.setHeader('Vary', 'Cookie, Authorization');
  next();
}
