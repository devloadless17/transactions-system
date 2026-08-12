/**
 * Batched, out-of-band maintenance backfill for `transactions.source_fee_amount`.
 *
 * BACKGROUND: the column is populated three ways already —
 *   1. the 20260622210000 migration adds it and backfills inline at deploy,
 *   2. 20260622230000_recompute_source_fee_backfill re-backfills once schedules
 *      exist, and
 *   3. going forward `SourcesService.setFeeRules` recomputes a source's deposits
 *      in-app whenever its schedule changes.
 * Those inline migration backfills are fine on a fresh or small database. This
 * script exists for the case the migrations are NOT safe for: re-backfilling a
 * VERY LARGE `transactions` table (millions of COMPLETED rows) without taking a
 * table-wide lock or holding a long `migrate deploy` transaction — e.g. after a
 * bulk fee-schedule change, or if you ever need to recompute history out of band.
 *
 * Run AFTER migrations, manually, in a maintenance window:
 *
 *   pnpm --filter @app/db exec tsx scripts/backfill-source-fee.ts
 *
 * Safe & resumable:
 *   - Keyset-paginated by `id` in bounded batches (BACKFILL_BATCH_SIZE, default
 *     1000) — never a table-wide lock; each batch is its own short transaction.
 *   - IDEMPOTENT: only rows still at the 0 default are recomputed, so re-running
 *     (or resuming after an interruption) skips already-backfilled rows and never
 *     double-applies. Rows the app already priced (>0) are left untouched.
 *   - Money math is IDENTICAL to TransactionsService/computeSourceFee: the
 *     lowest-`min` active tier of the deposit's channel whose [min,max] band
 *     (inclusive) contains `amount`, FIXED or PERCENTAGE, rounded ROUND_HALF_EVEN
 *     at the 8dp money scale — so backfilled history matches app-computed rows.
 *     (The inline migration UPDATE used SQL `round()` = half-up; this fixes that
 *     divergence for any rows it recomputes.)
 *
 * Channel classification matches the app: WHISH_PAY when a whish_payments row
 * links the transaction, else INGEST.
 *
 * Connects via DATABASE_URL, exactly like prisma/seed.ts — point it at the
 * migrations (superuser) role; each batch sets `app.bypass_rls` so it is
 * unaffected by RLS.
 */
import { Prisma, PrismaClient, TransactionStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Must match the platform money scale in packages/shared/src/money.ts. Hardcoded
// (not imported) because this script talks to @prisma/client directly — so it is
// NOT typechecked against the shared constant. If the scale moves again, this
// line has to move with it, or the backfill re-introduces over-scale rows that
// the ledger now refuses outright (LedgerScaleError).
const MONEY_SCALE = 2;
const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? '1000');

// Channel of a source-fee rule / deposit. Mirrors @app/shared SourceFeeChannel
// (packages/db has no @app/shared dependency, so the values are inlined).
type SourceFeeChannel = 'INGEST' | 'WHISH_PAY';

interface FeeRuleRow {
  channel: string;
  minAmount: Prisma.Decimal;
  maxAmount: Prisma.Decimal | null;
  feeType: string;
  feeValue: Prisma.Decimal;
  active: boolean;
}

/**
 * The source fee a single deposit costs the platform — a faithful port of
 * apps/api/.../sources/source-fee.compute.ts `computeSourceFee`. TOTAL by
 * design: returns 0 when no tier matches, never throws.
 */
function computeSourceFee(
  rules: FeeRuleRow[],
  channel: SourceFeeChannel,
  amount: Prisma.Decimal,
): Prisma.Decimal {
  const tier = rules
    .filter((r) => r.active && r.channel === channel)
    .filter((r) => {
      const withinMax = r.maxAmount === null || amount.lte(r.maxAmount);
      return amount.gte(r.minAmount) && withinMax;
    })
    .sort((a, b) => a.minAmount.cmp(b.minAmount))[0];

  if (!tier) return new Prisma.Decimal(0);
  const fee =
    tier.feeType === 'FIXED'
      ? new Prisma.Decimal(tier.feeValue)
      : amount.times(tier.feeValue).dividedBy(100);
  return fee.toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_EVEN);
}

async function main(): Promise<void> {
  if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE <= 0) {
    throw new Error(
      `BACKFILL_BATCH_SIZE must be a positive integer (got '${process.env.BACKFILL_BATCH_SIZE}')`,
    );
  }

  const zero = new Prisma.Decimal(0);
  // Cache the active fee tiers per source so we don't re-query per row.
  const rulesBySource = new Map<string, FeeRuleRow[]>();
  async function rulesFor(sourceId: string): Promise<FeeRuleRow[]> {
    let cached = rulesBySource.get(sourceId);
    if (!cached) {
      cached = await prisma.sourceFeeRule.findMany({
        where: { sourceId, active: true },
        select: {
          channel: true,
          minAmount: true,
          maxAmount: true,
          feeType: true,
          feeValue: true,
          active: true,
        },
      });
      rulesBySource.set(sourceId, cached);
    }
    return cached;
  }

  let cursorId: string | null = null;
  let scanned = 0;
  let updated = 0;

  console.log(`==> Backfilling source_fee_amount (batch size ${BATCH_SIZE})`);

  for (;;) {
    // Keyset page: only COMPLETED rows still at the 0 default (idempotent), in id
    // order. Pulling the page outside a write tx keeps the read lock-free; we
    // recompute in memory then write each row's value in a short batch tx.
    const page: { id: string; amount: Prisma.Decimal; sourceId: string; isWhish: boolean }[] =
      await prisma.$queryRaw`
        SELECT t.id, t.amount, t.source_id AS "sourceId",
               EXISTS (SELECT 1 FROM "whish_payments" wp WHERE wp.transaction_id = t.id) AS "isWhish"
        FROM "transactions" t
        WHERE t.status = ${TransactionStatus.COMPLETED}::"TransactionStatus"
          AND t.source_fee_amount = 0
          ${cursorId ? Prisma.sql`AND t.id > ${cursorId}::uuid` : Prisma.empty}
        ORDER BY t.id ASC
        LIMIT ${BATCH_SIZE}`;

    if (page.length === 0) break;
    scanned += page.length;
    cursorId = page[page.length - 1].id;

    // Compute each row's fee, then write the non-zero ones in one short tx (rows
    // that price to 0 already equal the default — skip the write entirely).
    const writes: { id: string; value: Prisma.Decimal }[] = [];
    for (const row of page) {
      const channel: SourceFeeChannel = row.isWhish ? 'WHISH_PAY' : 'INGEST';
      const rules = await rulesFor(row.sourceId);
      const fee = computeSourceFee(rules, channel, new Prisma.Decimal(row.amount));
      if (!fee.eq(zero)) writes.push({ id: row.id, value: fee });
    }

    if (writes.length > 0) {
      await prisma.$transaction(async (tx) => {
        // RLS bypass for this short write tx (matches the app's runAsAdmin); the
        // migrations role is superuser, so this is belt-and-suspenders.
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        for (const w of writes) {
          await tx.transaction.update({
            where: { id: w.id },
            data: { sourceFeeAmount: w.value },
          });
        }
      });
      updated += writes.length;
    }

    console.log(`    scanned ${scanned}, updated ${updated} (last id ${cursorId})`);
  }

  console.log(`==> Done. Scanned ${scanned} COMPLETED rows at default, updated ${updated}.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
