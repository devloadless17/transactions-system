-- ============================================================
-- 20260611170000_admin_list_created_at_indexes
--
-- The admin cross-company lists for withdrawals, payouts, loads, and whish
-- payments all sort by created_at DESC with no company filter (the default
-- operator views). The existing (company_id, created_at) indexes cannot serve a
-- query that has no company_id predicate, so those lists fall back to a full
-- table scan + sort as the tables grow. Add a bare (created_at) index per table
-- to back the recent-first ordering — exactly the fix already applied to
-- transaction_logs (transaction_logs_created_at_idx in 20260610120000).
--
-- Additive + idempotent (CREATE INDEX IF NOT EXISTS); no data change. Each is
-- also declared in schema.prisma (@@index([createdAt])) so a future
-- `prisma migrate dev` tracks them and never drift-drops them.
-- ============================================================

CREATE INDEX IF NOT EXISTS "withdrawals_created_at_idx" ON "withdrawals" ("created_at");

CREATE INDEX IF NOT EXISTS "payouts_created_at_idx" ON "payouts" ("created_at");

CREATE INDEX IF NOT EXISTS "loads_created_at_idx" ON "loads" ("created_at");

CREATE INDEX IF NOT EXISTS "whish_payments_created_at_idx" ON "whish_payments" ("created_at");
