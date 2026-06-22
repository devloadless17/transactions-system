-- ============================================================
-- 20260622230000_audit_logs_list_index
--
-- The default (unfiltered) admin audit-log list orders by (created_at DESC,
-- id DESC) but no existing index covered that order — at scale it seq-scans +
-- external-sorts the whole table. This (created_at DESC, id DESC) index lets the
-- planner do a backward index scan that early-stops on LIMIT+OFFSET.
--
-- Additive. IF NOT EXISTS so it's a no-op on a DB that already has it. NOTE: a
-- plain CREATE INDEX briefly write-locks the table — on an already-large
-- audit_logs, build it CONCURRENTLY out-of-band first (this then no-ops). See
-- docs/DEPLOYMENT.md → "Scaling & operational notes".
-- ============================================================

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_id_idx"
  ON "audit_logs" ("created_at" DESC, "id" DESC);
