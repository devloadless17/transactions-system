import { pickGranularity, type BucketGranularity } from '@app/shared';
import type { PrismaService } from '../../database/prisma.service';
import type { CacheService } from '../cache/cache.service';

const DEFAULT_DAYS = 30;
const MINUTE_MS = 60_000;

/**
 * All-time reads scan whole history, so they get a transaction budget well
 * above Prisma's 5s interactive default — without it the feature wouldn't be
 * slow, it would throw P2028. Paired with a statement_timeout so a pathological
 * plan still can't pin a connection indefinitely.
 */
export const ALL_TIME_TX_TIMEOUT_MS = 30_000;
export const ALL_TIME_STATEMENT_TIMEOUT = '15s';

export interface AnalyticsWindow {
  from: Date;
  to: Date;
  granularity: BucketGranularity;
  isAllTime: boolean;
}

interface RangeInput {
  from?: string;
  to?: string;
  preset?: 'all';
}

/**
 * Resolve a request's range into absolute bounds plus the bucket width to use.
 *
 * This is the single home for the default window, which used to be copy-pasted
 * in three services (each with its own drift risk).
 *
 * Two things happen here that the old inline code did not do:
 *
 * 1. A DERIVED `to` (the caller sent none) is anchored to the NEXT minute. The
 *    previous `new Date()` had millisecond precision, so every such request
 *    produced a unique cache key and could never hit the 60s cache. The anchor
 *    rounds UP, never down — the window has to keep including rows written in
 *    the current partial minute, or a dashboard would omit whatever just
 *    happened. This mirrors the `Math.ceil` the web client already applies to
 *    its own preset bounds.
 *
 *    An EXPLICIT `to` is used verbatim: it is already a stable cache token, and
 *    rounding it would silently widen a window the caller chose.
 *
 * 2. `from` is NOT floored to a bucket boundary — see the note at the return.
 *
 * `origin` is the all-time lower bound (see originFor* below). A null
 * origin — an empty platform — falls back to the default window so the response
 * is a valid empty series instead of a crash.
 */
export function resolveWindow(range: RangeInput, origin: Date | null): AnalyticsWindow {
  const to = range.to
    ? new Date(range.to)
    : new Date(Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS);

  const isAllTime = range.preset === 'all' && origin !== null;
  const rawFrom = range.from
    ? new Date(range.from)
    : isAllTime && origin
      ? origin
      : new Date(to.getTime() - DEFAULT_DAYS * 24 * 3600 * 1000);

  // The window is used VERBATIM. It must never be widened to a bucket boundary:
  // the client sends LOCAL midnight for "today" (21:00Z for UTC+3), and flooring
  // that to UTC midnight silently pulled ~21 hours of the previous day into
  // every total — reporting ~9x the real revenue on a UTC+3 dashboard.
  //
  // Bucket alignment does not need this: `eachBucketStartUtc` floors `from`
  // itself when generating bucket KEYS, so the series still starts on a clean
  // boundary. The first bucket is simply partial, which is the truth — the
  // caller asked for a window that begins mid-bucket.
  return { from: rawFrom, to, granularity: pickGranularity(rawFrom, to), isAllTime };
}

/**
 * Resolves the "beginning of time" for an all-time analytics window.
 *
 * The bound is a CREATION DATE (company / source / earliest company), not a
 * MIN() over the fact tables. Both would usually agree, but they fail
 * differently: every fact row FKs to a company created before it, so a creation
 * date can only be EARLIER than the first real row — a superset window, which
 * is harmless. A cached MIN() over facts can go stale in the other direction,
 * silently dropping a backdated row out of an all-time money chart. In a money
 * system that asymmetry decides it. It is also far cheaper: the overview would
 * otherwise need up to five MINs (transactions.created_at plus processed_at on
 * each of the three flow tables plus ledger_entries) to bound every card.
 *
 * Known limitation: a bulk import carrying `created_at` older than its owning
 * company row would be clipped by this bound. If that ever happens, either seed
 * those companies' `created_at` accordingly or switch this one call site to
 * LEAST(company.created_at, MIN(fact.created_at)).
 *
 * Cached under its OWN namespace (`analyticsorigin:`), deliberately not
 * `analytics:` — the latter's generation is bumped on every financial mutation,
 * which would throw this away constantly for a value that barely ever changes.
 * MIN(companies.created_at) is monotonic downward: a new company can never
 * raise it, so a 6h TTL is generous rather than risky.
 */
export interface OriginDeps {
  prisma: PrismaService;
  cache: CacheService;
}

const ORIGIN_TTL_SECONDS = 6 * 3600;

/**
 * Plain functions rather than an injectable service: both analytics services
 * already have `prisma` and `cache` injected, so a second provider would add DI
 * wiring (and a constructor-metadata import in each consumer) for no gain.
 */

/** Earliest data a single company could possibly have: its own creation. */
export function originForCompany(deps: OriginDeps, companyId: string): Promise<Date | null> {
  return resolveOrigin(deps, `analyticsorigin:co:${companyId}`, async () => {
    const row = await deps.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({ where: { id: companyId }, select: { createdAt: true } }),
    );
    return row?.createdAt ?? null;
  });
}

/** Earliest data on the platform: the first company ever created. */
export function originForPlatform(deps: OriginDeps): Promise<Date | null> {
  return resolveOrigin(deps, 'analyticsorigin:platform', async () => {
    const row = await deps.prisma.runAsAdmin((tx) =>
      tx.company.aggregate({ _min: { createdAt: true } }),
    );
    return row._min.createdAt ?? null;
  });
}

/** Earliest data for one source drilldown. */
export function originForSource(deps: OriginDeps, sourceId: string): Promise<Date | null> {
  return resolveOrigin(deps, `analyticsorigin:src:${sourceId}`, async () => {
    const row = await deps.prisma.runAsAdmin((tx) =>
      tx.source.findUnique({ where: { id: sourceId }, select: { createdAt: true } }),
    );
    return row?.createdAt ?? null;
  });
}

/**
 * Pick the right origin for an overview request: a company actor is always its
 * own company; an admin is either drilling into one company or looking at the
 * whole platform.
 */
export function originForOverviewScope(
  deps: OriginDeps,
  scope: 'admin' | { companyId: string },
  companyFilter?: string,
): Promise<Date | null> {
  if (scope !== 'admin') return originForCompany(deps, scope.companyId);
  return companyFilter ? originForCompany(deps, companyFilter) : originForPlatform(deps);
}

// Dates don't survive JSON, so the cache holds an ISO string and it is rehydrated
// here. A missing origin (no companies yet) is stored as an empty string so it is
// still a cache hit rather than a repeated miss.
async function resolveOrigin(
  deps: OriginDeps,
  key: string,
  compute: () => Promise<Date | null>,
): Promise<Date | null> {
  const iso = await deps.cache.wrap(key, ORIGIN_TTL_SECONDS, async () => {
    const value = await compute();
    return value ? value.toISOString() : '';
  });
  return iso ? new Date(iso) : null;
}
