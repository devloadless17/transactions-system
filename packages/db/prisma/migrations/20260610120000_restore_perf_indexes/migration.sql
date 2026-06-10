-- ============================================================
-- 20260610120000_restore_perf_indexes
--
-- The 20260609153054_nullable_requested_by migration was an auto-generated
-- `prisma migrate dev` diff for an unrelated change (nullable requested_by_id).
-- Because two performance indexes had been created in raw SQL and were NOT
-- declared in schema.prisma, that diff treated them as drift and emitted
-- DROP INDEX for both — without recreating them:
--
--   * ledger_entries_created_at_idx        (added in 0020) — windowed reconciliation
--   * transactions_external_id_trgm_idx    (added in 0024) — admin substring search
--
-- This migration restores both (idempotently). They are now ALSO declared in
-- schema.prisma (@@index([createdAt]) and a Gin @@index with gin_trgm_ops), so a
-- future `prisma migrate dev` will track them and never drift-drop them again.
--
-- transaction_logs_created_at_idx is new: the default admin Logs view sorts by
-- created_at with no `kind` filter, which the existing (kind, created_at) index
-- cannot serve.
-- ============================================================

-- Windowed reconciliation: groupBy(where created_at > since), cross-tenant.
CREATE INDEX IF NOT EXISTS "ledger_entries_created_at_idx"
  ON "ledger_entries" ("created_at");

-- Admin transaction search: externalTransactionId `contains` (substring LIKE),
-- which a btree cannot serve. Requires pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "transactions_external_id_trgm_idx"
  ON "transactions" USING gin ("external_transaction_id" gin_trgm_ops);

-- Default admin transaction-logs list: order by created_at desc with no kind filter.
CREATE INDEX IF NOT EXISTS "transaction_logs_created_at_idx"
  ON "transaction_logs" ("created_at");
