-- =================================================================
-- 20261008120600_network_fee_transactions
--
-- Network fee, step: the frozen per-row fee on `transactions`.
-- Deposits LAST: the ingest hot path, altered once everything else is in place.
--
-- Additive and catalog-only, safe while the previous API version serves:
--   * ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only change
--     (no table rewrite); every existing row reads as 0 — the old behaviour.
--   * The CHECK is added NOT VALID (no scan). It is still enforced on every
--     new or updated row, and every existing row is 0.
--   * No index.
-- network_fee_amount is DECIMAL(20,2): a new column has no pre-cent history,
-- so the database itself enforces whole cents (docs/MONEY_SCALE.md).
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

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "network_fee_amount" DECIMAL(20, 2) NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS "transactions_network_fee_nonneg_chk",
  ADD CONSTRAINT "transactions_network_fee_nonneg_chk" CHECK ("network_fee_amount" >= 0) NOT VALID;
