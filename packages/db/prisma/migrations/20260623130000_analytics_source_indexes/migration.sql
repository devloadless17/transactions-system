-- ============================================================
-- 20260623130000_analytics_source_indexes
--
-- One partial index for the ADMIN per-source analytics drilldown (sourceOverview /
-- source-fees.ts sourceFeeForSource): the query filters
-- `status='COMPLETED' AND source_id=? AND currency=? AND created_at BETWEEN ?`
-- and GROUPs by company_id. The only source_id-leading index is the
-- (source_id, external_transaction_id) UNIQUE, which serves source_id alone and
-- then scans that source's ENTIRE lifetime, filtering created_at in the heap. This
-- partial composite matches source_id + currency + the created_at range as leading
-- columns, so at scale it range-scans only the in-window rows instead of the
-- source's whole history (an unbounded, ever-growing scan otherwise).
--
-- Deliberately NOT adding a `(currency, created_at)` index for the platform-wide
-- source-fee SUMs: those GROUP BY *all* currencies with no currency-equality
-- predicate, so a currency-leading index can't serve their WHERE and the planner
-- (verified via EXPLAIN) keeps using transactions_created_at_idx regardless — the
-- index would only add write cost on the hot ingest path for zero read benefit.
--
-- NOTE: a plain CREATE INDEX briefly write-locks the table — on an already-large
-- `transactions`, build it CONCURRENTLY out-of-band first (the IF NOT EXISTS then
-- no-ops on deploy). See docs/DEPLOYMENT.md → "Scaling & operational notes".
-- ============================================================

CREATE INDEX IF NOT EXISTS "transactions_completed_source_created_idx"
  ON "transactions" ("source_id", "currency", "created_at")
  WHERE "status" = 'COMPLETED';
