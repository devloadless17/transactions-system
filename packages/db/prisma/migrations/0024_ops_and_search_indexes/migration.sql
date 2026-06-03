-- ============================================================
-- 0024_ops_and_search_indexes
--
-- Cross-tenant ADMIN reads (no company_id predicate, so the company_id-leading
-- indexes don't apply) were seq-scanning whole tables at 1M-10M+ rows and hitting
-- Prisma's 5s interactive-tx timeout -> 500 on the always-loaded admin overview
-- and on admin transaction search. These partial / trigram indexes make those
-- reads index-backed. Partial indexes are not expressible in the Prisma schema,
-- so they live here as raw SQL, consistent with 0019 / 0023.
-- ============================================================

-- (1) Admin operations queue (platform-analytics.service.ts operations()):
--     PENDING withdrawals/payouts/loads are a tiny slice of a huge table; a partial
--     index on (created_at) WHERE PENDING serves both the groupBy and the
--     ordered findMany without indexing the COMPLETED bulk.
CREATE INDEX IF NOT EXISTS "withdrawals_pending_created_idx"
  ON "withdrawals" ("created_at")
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "payouts_pending_created_idx"
  ON "payouts" ("created_at")
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "loads_pending_created_idx"
  ON "loads" ("created_at")
  WHERE "status" = 'PENDING';

-- (2) Recent reversals feed (operations(): status='REVERSED' AND updated_at >= 7d).
--     REVERSED is rare, so a partial index on (updated_at) WHERE REVERSED keeps it
--     instant cross-tenant.
CREATE INDEX IF NOT EXISTS "transactions_reversed_updated_idx"
  ON "transactions" ("updated_at")
  WHERE "status" = 'REVERSED';

-- (3) Admin transaction search (transactions.service.ts list(): a bare
--     externalTransactionId `contains` filter). A btree can't serve a substring
--     LIKE, so a GIN trigram index makes the cross-tenant search index-backed
--     instead of a full LIKE scan that times out at scale.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "transactions_external_id_trgm_idx"
  ON "transactions" USING gin ("external_transaction_id" gin_trgm_ops);
