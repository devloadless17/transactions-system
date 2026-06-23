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
 *
 * REVERSAL SYMMETRY: every SUM counts deposits that SETTLED — `status IN
 * ('COMPLETED','REVERSED')` — anchored at the settlement `created_at`. A source
 * fee is a real cost the platform paid the upstream when the deposit settled, and
 * the upstream does NOT refund it when WE later reverse/claw back the deposit, so
 * the cost must stay counted in its original window. This mirrors the realized-time
 * FEE-revenue side (a reversal books a dated FEE DEBIT at reversal time, it does
 * not erase the original CREDIT from its window). Counting only COMPLETED would let
 * a reversal silently delete a real cost from every window and overstate net revenue.
 * (If a source ever DID refund its fee on reversal, book a compensating reduction at
 * reversal time instead of changing this filter.)
 */
type Tx = Prisma.TransactionClient;

// Deposits whose source fee was actually incurred = those that settled, even if
// later reversed (the upstream fee is not refunded on our clawback).
const SETTLED = `status IN ('COMPLETED', 'REVERSED')`;

/** Total source fees per currency over [from, to] (settled deposits). */
export async function sourceFeesByCurrency(
  tx: Tx,
  from: Date,
  to: Date,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ currency: string; fees: string }>>(
    `
    SELECT currency, COALESCE(SUM(source_fee_amount), 0)::text AS fees
    FROM transactions
    WHERE ${SETTLED}
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
    WHERE t.${SETTLED}
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
    WHERE ${SETTLED}
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

// Retroactive re-pricing of a source's already-settled deposits now lives in
// SourcesService.repriceExistingDeposits — it runs POST-COMMIT in keyset-batched
// short transactions using the shared computeSourceFee (ROUND_HALF_EVEN), so a
// high-volume source can't blow the 5s tx limit / hold a long lock and the value
// matches what ingest froze. (This module stays read-only: it only SUMs the
// frozen column.)
