import type { Prisma } from '@app/db';

/**
 * Source fees = what upstream sources (e.g. Whish) charge THE PLATFORM on each
 * incoming deposit (the platform's cost of funds). Net revenue = platform revenue
 * (FEE ledger) − source fees. System/admin-only — these helpers must only run
 * inside an admin-scoped (bypass-RLS) transaction and never feed a company response.
 *
 * The fee is computed and FROZEN per deposit at settlement (transactions.source_fee_amount,
 * see TransactionsService.ingest + the 20260622210000 migration's backfill). These
 * helpers therefore just SUM that column over a window — an O(rows-in-range) indexed
 * aggregate, with NO per-deposit subquery — so the admin dashboard stays fast at
 * millions of deposits. (Previously this re-priced every deposit on each call via a
 * correlated subquery, which did not scale.)
 */
type Tx = Prisma.TransactionClient;

/** Total source fees per currency over [from, to] (COMPLETED deposits). */
export async function sourceFeesByCurrency(
  tx: Tx,
  from: Date,
  to: Date,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ currency: string; fees: string }>>(
    `
    SELECT currency, COALESCE(SUM(source_fee_amount), 0)::text AS fees
    FROM transactions
    WHERE status = 'COMPLETED'
      AND created_at >= $1 AND created_at <= $2
    GROUP BY currency
    `,
    from,
    to,
  );
  return new Map(rows.map((r) => [r.currency.trim(), r.fees ?? '0']));
}

/** Per-source, per-currency source fees over [from, to] (only non-zero rows). */
export async function sourceFeesBreakdown(
  tx: Tx,
  from: Date,
  to: Date,
): Promise<
  Array<{
    sourceId: string;
    sourceCode: string;
    sourceName: string;
    currency: string;
    fees: string;
  }>
> {
  const rows = await tx.$queryRawUnsafe<
    Array<{ source_id: string; code: string; name: string; currency: string; fees: string }>
  >(
    `
    SELECT t.source_id, s.code, s.name, t.currency,
      COALESCE(SUM(t.source_fee_amount), 0)::text AS fees
    FROM transactions t
    JOIN sources s ON s.id = t.source_id
    WHERE t.status = 'COMPLETED'
      AND t.created_at >= $1 AND t.created_at <= $2
    GROUP BY t.source_id, s.code, s.name, t.currency
    HAVING COALESCE(SUM(t.source_fee_amount), 0) > 0
    ORDER BY COALESCE(SUM(t.source_fee_amount), 0) DESC
    `,
    from,
    to,
  );
  return rows.map((r) => ({
    sourceId: r.source_id,
    sourceCode: r.code,
    sourceName: r.name,
    currency: r.currency.trim(),
    fees: r.fees ?? '0',
  }));
}

/** Source fees a single source charged in one currency over [from, to]. */
export async function sourceFeeForSource(
  tx: Tx,
  sourceId: string,
  currency: string,
  from: Date,
  to: Date,
): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ fees: string }>>(
    `
    SELECT COALESCE(SUM(source_fee_amount), 0)::text AS fees
    FROM transactions
    WHERE status = 'COMPLETED'
      AND source_id = $1::uuid
      AND currency = $2
      AND created_at >= $3 AND created_at <= $4
    `,
    sourceId,
    currency,
    from,
    to,
  );
  return rows[0]?.fees ?? '0';
}
