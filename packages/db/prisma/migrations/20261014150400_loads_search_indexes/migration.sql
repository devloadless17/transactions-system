-- =================================================================
-- 20261014150400_loads_search_indexes
--
-- The search indexes for "loads" (see 20261014150000_search_text_functions and
-- apps/api/src/common/search.ts): trigram GIN on its search text and on its
-- phone digits, so a search by phone, name, reference or id is index-backed at
-- any size instead of walking the table.
--
-- fastupdate = off: every insert updates the index directly (measured: +0.15ms
-- a row) — never a pending list that some later insert has to flush, so no
-- write ever pays a surprise.
--
-- A plain CREATE INDEX reads the table once under a SHARE lock (writes wait
-- for it, deploy.sh bounds the wait to acquire it at 5s). "loads" is small
-- (67 rows in production on 2026-10-14), so the build is a blink. On a large
-- table build them CONCURRENTLY out-of-band first (the IF NOT EXISTS below
-- then no-ops):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "loads_search_trgm_idx" ON "loads"
--     USING gin (flow_search_text("id", "external_reference", "notes", "payout_details") gin_trgm_ops) WITH (fastupdate = off);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "loads_search_phones_trgm_idx" ON "loads"
--     USING gin (flow_search_phones("payout_details") gin_trgm_ops) WITH (fastupdate = off);
-- SQL-only (an expression index can't be declared in schema.prisma), so
-- sql-only-indexes.spec.ts fails any later migration that drops them.
-- One table, so this file cannot deadlock against live traffic
-- (migration-lock-safety.spec.ts).
-- =================================================================

CREATE INDEX IF NOT EXISTS "loads_search_trgm_idx" ON "loads"
  USING gin (flow_search_text("id", "external_reference", "notes", "payout_details") gin_trgm_ops) WITH (fastupdate = off);

CREATE INDEX IF NOT EXISTS "loads_search_phones_trgm_idx" ON "loads"
  USING gin (flow_search_phones("payout_details") gin_trgm_ops) WITH (fastupdate = off);
