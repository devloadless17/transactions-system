import { ValidationError } from './errors/domain.error';

/**
 * Deep-offset guard shared by every paginated list endpoint.
 *
 * `page` is only bounded by `>= 1` in the shared schema (pageSize is capped, page
 * isn't), so without this a caller can pass `page=999999999` and turn a list read
 * into an O(table) OFFSET scan — a cheap DoS on any list, and slow at scale. Past
 * this offset we reject with a clear 422 ("narrow your filters") instead of
 * scanning; genuinely deep navigation should use filters or keyset paging, not raw
 * OFFSET. Keep this the single definition so every list enforces the same bound.
 */
export const MAX_LIST_OFFSET = 50_000;

/** Throw a 422 ValidationError when `skip` exceeds the deep-offset bound. */
export function assertListOffset(skip: number, max: number = MAX_LIST_OFFSET): void {
  if (skip > max) {
    throw new ValidationError(
      'Page too deep to scan efficiently. Narrow the results with filters (date range, type, status) instead of paging this far.',
    );
  }
}
