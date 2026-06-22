import type { Prisma } from '@app/db';

/**
 * Source fees = what an upstream source (e.g. Whish) charges THE PLATFORM on each
 * incoming deposit, per its configured fee schedule (source_fee_rules). This is
 * the platform's cost of funds and is subtracted from platform revenue to get
 * net revenue. System/admin-only — these helpers must only ever run inside an
 * admin-scoped (bypass-RLS) transaction, and never feed a company-facing response.
 *
 * The fee is evaluated PER DEPOSIT (a flat-fee-below-threshold tier can't be a
 * single rate over volume). Each deposit is classified by channel — WHISH_PAY if
 * a whish_payments row references it (a company-generated collect link), else
 * INGEST (direct ingest API) — then matched to the LOWEST-`min_amount` tier whose
 * [min, max] band (both inclusive) contains the amount. So at a touching boundary
 * the lower band wins: with Whish INGEST tiers [0,10] $1 and [10,∞] 1%, exactly
 * $10 is charged the flat $1 and only $10.00000001+ is charged 1%. The per-deposit
 * fee is rounded to 2dp (cents), the unit a payment processor actually bills in.
 */
const FEE_EXPR = `
  COALESCE((
    SELECT round(
      CASE r.fee_type
        WHEN 'FIXED' THEN r.fee_value
        ELSE t.amount * r.fee_value / 100
      END, 2)
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
`;

type Tx = Prisma.TransactionClient;

/** Total source fees per currency over [from, to] (COMPLETED deposits). */
export async function sourceFeesByCurrency(
  tx: Tx,
  from: Date,
  to: Date,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ currency: string; fees: string }>>(
    `
    SELECT t.currency, COALESCE(SUM(${FEE_EXPR}), 0)::text AS fees
    FROM transactions t
    WHERE t.status = 'COMPLETED'
      AND t.created_at >= $1 AND t.created_at <= $2
    GROUP BY t.currency
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
      COALESCE(SUM(${FEE_EXPR}), 0)::text AS fees
    FROM transactions t
    JOIN sources s ON s.id = t.source_id
    WHERE t.status = 'COMPLETED'
      AND t.created_at >= $1 AND t.created_at <= $2
    GROUP BY t.source_id, s.code, s.name, t.currency
    HAVING COALESCE(SUM(${FEE_EXPR}), 0) > 0
    ORDER BY COALESCE(SUM(${FEE_EXPR}), 0) DESC
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
    SELECT COALESCE(SUM(${FEE_EXPR}), 0)::text AS fees
    FROM transactions t
    WHERE t.status = 'COMPLETED'
      AND t.source_id = $1::uuid
      AND t.currency = $2
      AND t.created_at >= $3 AND t.created_at <= $4
    `,
    sourceId,
    currency,
    from,
    to,
  );
  return rows[0]?.fees ?? '0';
}
