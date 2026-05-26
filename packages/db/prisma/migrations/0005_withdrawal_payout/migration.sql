-- ============================================================
-- 0005_withdrawal_payout
--
-- Adds payout method + per-method details to withdrawals.
-- The admin who approves needs to know *where* the money goes;
-- without this, "Approve" was a leap of faith.
--
-- payout_method   : enum (BANK_TRANSFER | CRYPTO | CASH | OTHER)
-- payout_details  : jsonb shape depends on the method (validated app-side)
-- external_reference : optional bank tx ref / crypto tx hash / receipt
--                       number written when the admin approves so the
--                       audit trail records HOW the money left.
-- ============================================================

CREATE TYPE "PayoutMethod" AS ENUM ('BANK_TRANSFER', 'CRYPTO', 'CASH', 'OTHER');

ALTER TABLE "withdrawals"
  ADD COLUMN "payout_method"      "PayoutMethod" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "payout_details"     JSONB,
  ADD COLUMN "external_reference" TEXT;

-- Drop the default once the column exists — new rows must specify a method.
ALTER TABLE "withdrawals" ALTER COLUMN "payout_method" DROP DEFAULT;

CREATE INDEX "withdrawals_payout_method_idx" ON "withdrawals"("payout_method");
