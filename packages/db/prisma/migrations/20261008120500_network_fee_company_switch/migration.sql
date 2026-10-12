-- =================================================================
-- 20261008120500_network_fee_company_switch
--
-- Network fee, step: the per-company master switch, default OFF. Until a
-- SUPER_ADMIN switches it on for a company, nothing anywhere changes.
--
-- ADD COLUMN ... NOT NULL DEFAULT false is a metadata-only change (no table
-- rewrite); every existing company reads as false — the old behaviour.
--
-- ONE TABLE PER FILE, on purpose. Prisma applies a migration file as a single
-- transaction, and an ALTER TABLE holds its ACCESS EXCLUSIVE lock until that
-- transaction commits — while the PREVIOUS API version is still serving. A
-- migration that locks two live tables can therefore deadlock against a money
-- write that touches them in the opposite order (an ingest holds a lock on
-- `companies`/`transactions` and then, through the ledger's foreign keys, needs
-- `withdrawals`/`payouts`/`loads`). Postgres would abort the migration, and a
-- failed migration blocks every later deploy until it is resolved by hand.
-- A file that locks ONE table can only ever wait; it can never be half of a
-- cycle. Guarded by migration-lock-safety.spec.ts.
--
-- Idempotent (IF NOT EXISTS / DROP ... IF EXISTS): staging and development
-- databases applied an earlier revision of 20261008120100_network_fees that
-- held all of these statements in one file. There this file is a no-op.
-- =================================================================

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "network_fee_enabled" BOOLEAN NOT NULL DEFAULT false;
