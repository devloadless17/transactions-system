-- ============================================================
-- 0004_must_change_password
--
-- Adds a flag set when a temp password is issued (invite, create
-- company owner). The /auth/me endpoint surfaces this so the UI
-- can force a password change before granting access to features.
-- ============================================================

ALTER TABLE "users"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing rows with temp passwords from company creation should be
-- treated as needing a change. The seed admin is the only legacy row
-- we can safely leave alone.
UPDATE "users"
  SET "must_change_password" = TRUE
  WHERE role = 'COMPANY_OWNER';
