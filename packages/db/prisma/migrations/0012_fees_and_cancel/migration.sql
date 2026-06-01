-- =================================================================
-- 0012_fees_and_cancel
--
-- 1. Per-company, per-operation fees: the commission-rule engine gains an
--    operation_type (TRANSACTION/WITHDRAWAL/PAYOUT/LOAD) and a fee_application
--    (DEDUCTED/ON_TOP). Existing rules default to TRANSACTION/DEDUCTED, so the
--    transaction path is unchanged.
-- 2. Withdrawals/payouts/loads carry the realized fee_amount + net_amount and
--    the fee_application used (so approve/cancel are deterministic), plus a
--    cancelled_by_id for the new company-initiated cancel.
--
-- No new tables → existing RLS policies + grants (0002, 0003) already apply.
-- =================================================================

-- 1. New enums
CREATE TYPE "FeeOperationType" AS ENUM ('TRANSACTION', 'WITHDRAWAL', 'PAYOUT', 'LOAD');
CREATE TYPE "FeeApplication"   AS ENUM ('DEDUCTED', 'ON_TOP');

-- 2. commission_rules — backward-compatible defaults
ALTER TABLE "commission_rules"
  ADD COLUMN "operation_type" "FeeOperationType" NOT NULL DEFAULT 'TRANSACTION',
  ADD COLUMN "fee_application" "FeeApplication"  NOT NULL DEFAULT 'DEDUCTED';

DROP INDEX IF EXISTS "commission_rules_company_source_active_priority_idx";
CREATE INDEX "commission_rules_company_source_op_active_priority_idx"
  ON "commission_rules" ("company_id", "source_id", "operation_type", "active", "priority");

-- 3. fee/net/application + cancelled_by on the three flow tables
ALTER TABLE "withdrawals"
  ADD COLUMN "fee_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "net_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "fee_application" "FeeApplication" NOT NULL DEFAULT 'DEDUCTED',
  ADD COLUMN "cancelled_by_id" UUID,
  ADD CONSTRAINT "withdrawals_cancelled_by_fkey"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT;

ALTER TABLE "payouts"
  ADD COLUMN "fee_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "net_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "fee_application" "FeeApplication" NOT NULL DEFAULT 'DEDUCTED',
  ADD COLUMN "cancelled_by_id" UUID,
  ADD CONSTRAINT "payouts_cancelled_by_fkey"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT;

ALTER TABLE "loads"
  ADD COLUMN "fee_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "net_amount"      NUMERIC(20, 8)   NOT NULL DEFAULT 0,
  ADD COLUMN "fee_application" "FeeApplication" NOT NULL DEFAULT 'DEDUCTED',
  ADD COLUMN "cancelled_by_id" UUID,
  ADD CONSTRAINT "loads_cancelled_by_fkey"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "users" ("id") ON DELETE RESTRICT;

-- 4. Backfill net_amount = amount for historical rows (they had no fee).
UPDATE "withdrawals" SET "net_amount" = "amount";
UPDATE "payouts"     SET "net_amount" = "amount";
UPDATE "loads"       SET "net_amount" = "amount";
