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

/**
 * Recompute & persist `source_fee_amount` for ONE source's COMPLETED deposits from
 * its CURRENT schedule. Per-deposit source fee is frozen at settlement, so a
 * schedule that's edited — or configured AFTER deposits already settled — wouldn't
 * otherwise apply to those deposits. Call this when a source's schedule is saved
 * so the change is reflected retroactively (and net-revenue analytics, which just
 * SUM the column, stay fast). One UPDATE; must run in an admin-scoped (bypass-RLS)
 * tx. Picks the lowest-min matching tier per deposit, classifying channel by the
 * whish_payments link — identical logic to the settlement-time computation and the
 * migration backfill.
 *
 * Cost is O(deposits for this source); fine for a rare admin action. For a source
 * with millions of deposits, batch/async it (mirror the migration's backfill note).
 */
export async function recomputeSourceFeeAmounts(tx: Tx, sourceId: string): Promise<void> {
  await tx.$executeRawUnsafe(
    `
    UPDATE transactions t SET source_fee_amount = COALESCE((
      SELECT round(
        CASE r.fee_type WHEN 'FIXED' THEN r.fee_value ELSE t.amount * r.fee_value / 100 END, 8)
      FROM source_fee_rules r
      WHERE r.source_id = t.source_id
        AND r.active
        AND r.channel = (
          CASE WHEN EXISTS (SELECT 1 FROM whish_payments wp WHERE wp.transaction_id = t.id)
               THEN 'WHISH_PAY'::"SourceFeeChannel"
               ELSE 'INGEST'::"SourceFeeChannel" END)
        AND t.amount >= r.min_amount
        AND (r.max_amount IS NULL OR t.amount <= r.max_amount)
      ORDER BY r.min_amount ASC
      LIMIT 1
    ), 0)
    WHERE t.source_id = $1::uuid AND t.status = 'COMPLETED'
    `,
    sourceId,
  );
}
