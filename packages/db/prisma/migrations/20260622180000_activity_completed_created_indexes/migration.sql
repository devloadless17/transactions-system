-- ============================================================
-- 20260622180000_activity_completed_created_indexes
--
-- Backs the unified activity feed (activity.service.ts): a UNION ALL of the four
-- COMPLETED money tables (transactions/loads/withdrawals/payouts) merged by
-- (created_at DESC, id DESC) with an outer LIMIT, plus the company balance-mode
-- window SUM that scans a company's COMPLETED history in (created_at, id) order.
--
-- Each branch filters `WHERE status = 'COMPLETED'` and is consumed in
-- (created_at DESC, id DESC) order. No existing index produces that order for the
-- COMPLETED subset — the plain (created_at) indexes cover all statuses and don't
-- carry the id tiebreaker — so Postgres sorts each branch and the outer LIMIT
-- can't early-stop. These partial (created_at DESC, id DESC) WHERE COMPLETED
-- indexes let the planner do a MergeAppend of ordered index scans and stop after
-- LIMIT+OFFSET. They cover only the COMPLETED subset, so they stay small.
--
-- Partial indexes (a WHERE clause) aren't expressible in the Prisma schema (same
-- as the existing partial/trigram indexes), so they live here as raw SQL; a
-- discovery comment is added to each model in schema.prisma. Additive + idempotent
-- (CREATE INDEX IF NOT EXISTS); no data change.
--
-- NOTE: a plain CREATE INDEX takes a brief write lock while it builds. On a very
-- large production table, build these CONCURRENTLY out-of-band instead
-- (CONCURRENTLY cannot run inside a Prisma migration transaction); the
-- IF NOT EXISTS here then no-ops.
-- ============================================================

CREATE INDEX IF NOT EXISTS "transactions_completed_created_idx"
  ON "transactions" ("created_at" DESC, "id" DESC) WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "loads_completed_created_idx"
  ON "loads" ("created_at" DESC, "id" DESC) WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "withdrawals_completed_created_idx"
  ON "withdrawals" ("created_at" DESC, "id" DESC) WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "payouts_completed_created_idx"
  ON "payouts" ("created_at" DESC, "id" DESC) WHERE "status" = 'COMPLETED';
