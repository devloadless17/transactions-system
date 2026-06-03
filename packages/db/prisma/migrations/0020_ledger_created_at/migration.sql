-- ============================================================
-- 0020_ledger_created_at
--
-- Enables WINDOWED reconciliation: the recurring detective job asks "which
-- companies had ledger activity since the last run?" — a created_at range scan
-- — and re-checks only those companies instead of folding the entire ledger
-- every cycle. (A wallet can only drift alongside a ledger write, so a window
-- keyed on created_at cannot miss a new divergence.) Append-only table, so this
-- btree stays naturally well-clustered.
-- ============================================================

CREATE INDEX IF NOT EXISTS "ledger_entries_created_at_idx"
  ON "ledger_entries" ("created_at");
