-- Three withdrawal kinds:
--   WITHDRAW — company pays a third party; operator executes externally
--   PAYOUT   — company withdraws funds to itself; operator executes externally
--   LOAD     — company tops up its own wallet (money IN, not out); operator
--              verifies real-world cash receipt and approves
--
-- Existing rows are all WITHDRAW semantics, so we backfill them as such
-- before making the column NOT NULL.

CREATE TYPE "WithdrawalKind" AS ENUM ('WITHDRAW', 'PAYOUT', 'LOAD');

ALTER TABLE "withdrawals"
  ADD COLUMN "kind" "WithdrawalKind";

UPDATE "withdrawals" SET "kind" = 'WITHDRAW' WHERE "kind" IS NULL;

ALTER TABLE "withdrawals"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "kind" SET DEFAULT 'WITHDRAW';
