-- =================================================================
-- 20261014120000_transaction_refunded_at
--
-- A deposit that was refunded to the payer (a Whish refund) says so itself:
-- transactions.refunded_at, written in the SAME database transaction as the
-- reversal that books the refund. A refunded deposit is REVERSED, exactly like
-- one an operator reversed without a refund; this column is what tells the two
-- apart. The transactions API and the CRM `transaction.reversed` event carry it
-- as `refunded` / `refundedAt`.
--
-- Additive and catalog-only: one nullable column with no default (no table
-- rewrite). No backfill: no refund had been booked in production or staging
-- when it was added (checked 2026-10-14). The previous API version never reads
-- or writes it, so it keeps working while this runs, and a rollback ignores
-- it. One table (migration-lock-safety.spec.ts); deploy.sh bounds the lock wait.
-- =================================================================

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ(6);
