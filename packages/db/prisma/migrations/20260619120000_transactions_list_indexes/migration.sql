-- ============================================================
-- 20260619120000_transactions_list_indexes
--
-- The transactions table — the largest in the system — was missing two indexes
-- its sibling money tables (withdrawals/payouts/loads/whish_payments) already
-- have, so the admin transaction list and status-filtered company lists fell back
-- to a full table scan + external sort as the table grows:
--
--   1. No standalone (created_at): the admin cross-company list (default view)
--      orders by created_at DESC with no company predicate, which the existing
--      (company_id, created_at) index cannot serve. Mirrors the fix already
--      applied to withdrawals/payouts/loads/whish in 20260611170000.
--   2. No (company_id, status, created_at): a company list filtered by a status
--      and ordered by created_at — and the company-scoped COMPLETED volume/daily
--      KPI — could use (company_id, status) to find rows but not to avoid the
--      sort. The composite serves filter + sort + limit + the analytics aggregate
--      from one index.
--
-- Both are now ALSO declared in schema.prisma (@@index), so a future
-- `prisma migrate dev` tracks them and never drift-drops them. Additive +
-- idempotent (CREATE INDEX IF NOT EXISTS); no data change.
--
-- NOTE: a plain CREATE INDEX briefly takes a write lock on `transactions` while
-- it builds. On a very large production table, create these CONCURRENTLY
-- out-of-band instead (CONCURRENTLY cannot run inside a migration transaction).
-- ============================================================

CREATE INDEX IF NOT EXISTS "transactions_created_at_idx"
  ON "transactions" ("created_at");

CREATE INDEX IF NOT EXISTS "transactions_company_status_created_idx"
  ON "transactions" ("company_id", "status", "created_at");
