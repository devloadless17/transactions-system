-- ============================================================
-- 20260703120000_analytics_settled_and_processed_indexes
--
-- Two analytics index gaps found by the 2026-07-03 production-readiness audit:
--
-- 1. Source-fee sums filter SETTLED = status IN ('COMPLETED','REVERSED')
--    (source-fees.ts — a reversal does NOT refund the upstream fee, so REVERSED
--    stays counted), but the only per-source analytics index
--    (transactions_completed_source_created_idx) is partial on
--    status = 'COMPLETED' ONLY. `status='COMPLETED'` does not-imply-match the
--    other way: the SETTLED sum can't use it and falls back to scanning the
--    source's whole history. Replace it with the same composite under the
--    broader SETTLED predicate — `status='COMPLETED'` IMPLIES the broader
--    predicate, so the replacement serves the COMPLETED-only sibling queries
--    (agg/daily/company drilldowns) too, and REVERSED rows are rare so the
--    index stays effectively the same size. Create-new-then-drop-old so there
--    is no unindexed window.
--
-- 2. The platform-overview OUT/load aggregates filter
--    `status='COMPLETED' AND processed_at BETWEEN ?` and GROUP BY currency
--    (platform-analytics.service.ts platform()). The existing
--    *_completed_currency_processed_idx indexes lead with currency, so a
--    range-only query (no currency equality) cannot seek processed_at and
--    reads the entire COMPLETED history per dashboard load. A processed_at-
--    leading partial index per flow table lets the planner range-scan just
--    the window and hash-group the small windowed subset.
--
-- NOTE: a plain CREATE INDEX briefly write-locks the table — on an already-
-- large table, build it CONCURRENTLY out-of-band first (the IF NOT EXISTS
-- below then no-ops on deploy). See docs/DEPLOYMENT.md → "Scaling &
-- operational notes". Out-of-band commands:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_settled_source_created_idx"
--     ON "transactions" ("source_id", "currency", "created_at")
--     WHERE "status" IN ('COMPLETED', 'REVERSED');
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "withdrawals_completed_processed_idx"
--     ON "withdrawals" ("processed_at") WHERE "status" = 'COMPLETED';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "payouts_completed_processed_idx"
--     ON "payouts" ("processed_at") WHERE "status" = 'COMPLETED';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "loads_completed_processed_idx"
--     ON "loads" ("processed_at") WHERE "status" = 'COMPLETED';
--   DROP INDEX CONCURRENTLY IF EXISTS "transactions_completed_source_created_idx";
-- ============================================================

CREATE INDEX IF NOT EXISTS "transactions_settled_source_created_idx"
  ON "transactions" ("source_id", "currency", "created_at")
  WHERE "status" IN ('COMPLETED', 'REVERSED');

DROP INDEX IF EXISTS "transactions_completed_source_created_idx";

CREATE INDEX IF NOT EXISTS "withdrawals_completed_processed_idx"
  ON "withdrawals" ("processed_at")
  WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "payouts_completed_processed_idx"
  ON "payouts" ("processed_at")
  WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "loads_completed_processed_idx"
  ON "loads" ("processed_at")
  WHERE "status" = 'COMPLETED';
