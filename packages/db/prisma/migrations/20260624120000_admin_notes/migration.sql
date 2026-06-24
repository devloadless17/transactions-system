-- ============================================================
-- 20260624120000_admin_notes
--
-- Separate the ADMIN/system note from the COMPANY note on the three
-- request flows. Previously a single `notes` column was reused: the
-- company wrote it at request time, then an admin approve/reject
-- OVERWROTE it — silently destroying the company's original note.
--
-- We keep `notes` as the company's request note (immutable after
-- creation) and add `admin_notes` for the note the admin records when
-- actioning the request (incl. the rejection reason shown to the
-- company). Nullable, no default → instant metadata-only change, no
-- table rewrite, no lock concern. Table-level grants already cover the
-- new column (txn_app_rls has UPDATE on these tables).
-- ============================================================

ALTER TABLE "withdrawals" ADD COLUMN "admin_notes" TEXT;
ALTER TABLE "payouts"     ADD COLUMN "admin_notes" TEXT;
ALTER TABLE "loads"       ADD COLUMN "admin_notes" TEXT;
