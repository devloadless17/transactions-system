-- ============================================================
-- 0019_perf_indexes
--
-- Performance indexes from the architecture audit. Partial indexes
-- (not expressible in the Prisma schema) live here as raw SQL,
-- consistent with the other hand-written migrations.
-- ============================================================

-- Reconciliation: RECEIVABLE rows are rare (only under-funded reversals), so a
-- partial index stays microscopic while turning listReceivables (cross-tenant)
-- and outstandingReceivable (per-tenant) from filtered scans into focused
-- lookups. Matches ledger.service.ts:outstandingReceivable and
-- reconciliation.service.ts:listReceivables.
CREATE INDEX IF NOT EXISTS "ledger_entries_receivable_idx"
  ON "ledger_entries" ("company_id", "currency")
  WHERE "account_type" = 'RECEIVABLE';

-- Admin analytics always pin status='COMPLETED' and run cross-tenant (no
-- company_id predicate to lean on), so (currency, created_at) WHERE COMPLETED
-- matches the dashboard aggregate shape (analytics.service.ts compute /
-- platform-analytics.service.ts) without indexing non-completed rows.
CREATE INDEX IF NOT EXISTS "transactions_completed_currency_created_idx"
  ON "transactions" ("currency", "created_at")
  WHERE "status" = 'COMPLETED';

-- Drop low-selectivity standalone payout_method indexes. payout_method is a
-- 5-value enum used only as an optional secondary filter on an already
-- tenant-scoped, (company_id, created_at)-ordered list — Postgres prefers the
-- composite and never uses these, so they are pure write overhead. (They were
-- never declared in the Prisma schema; this realigns the DB with it.)
DROP INDEX IF EXISTS "withdrawals_payout_method_idx";
DROP INDEX IF EXISTS "payouts_payout_method_idx";
DROP INDEX IF EXISTS "loads_payout_method_idx";
