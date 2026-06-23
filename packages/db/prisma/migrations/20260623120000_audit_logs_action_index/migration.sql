-- ============================================================
-- 20260623120000_audit_logs_action_index
--
-- The admin audit-log list can filter by `action` (e.g. action='withdrawal.approve')
-- and orders by (created_at DESC). `action` was a bare column with no index, so an
-- action-filtered view fell to a scan + sort at scale. This (action, created_at DESC)
-- index serves the filter and the order together (backward index scan, early-stops
-- on LIMIT+OFFSET). The existing (entity_type, entity_id) index already covers an
-- entityType-only filter as a prefix.
--
-- Additive. IF NOT EXISTS so it's a no-op on a DB that already has it. NOTE: a
-- plain CREATE INDEX briefly write-locks the table — on an already-large
-- audit_logs, build it CONCURRENTLY out-of-band first (this then no-ops). See
-- docs/DEPLOYMENT.md → "Scaling & operational notes".
-- ============================================================

CREATE INDEX IF NOT EXISTS "audit_logs_action_created_idx"
  ON "audit_logs" ("action", "created_at" DESC);
