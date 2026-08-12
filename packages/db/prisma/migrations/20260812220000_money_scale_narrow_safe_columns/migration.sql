-- Stage B, restricted to the columns where it is PROVABLY a no-op.
--
-- The platform money scale is 2 dp. This narrows the money columns that already
-- contain nothing but cent values, so the database enforces the rule too rather
-- than relying solely on the application.
--
-- DELIBERATELY EXCLUDED, and this is permanent:
--
--   * ledger_entries.amount / wallets.* — the ledger is append-only and accepts
--     only balanced sets, so a global imbalance introduced by re-scaling history
--     could never be repaired by appending. Measured on production data: the
--     books net exactly 0 today, but rounding every historical leg would net
--     -0.58. A wallet is that ledger's projection, so it stays wide too.
--     `ledger_entries_amount_cent_chk` constrains new rows instead.
--
--   * transactions.* and withdrawals.* — these carry legacy over-scale rows that
--     currently AGREE, to the digit, with the ledger legs they produced (verified
--     on production: 71 of 71 legacy transactions match their FEE leg exactly).
--     Because the ledger cannot follow them down to cents, narrowing these would
--     BREAK that agreement — making the data less internally consistent, not
--     more. They are quantized on read (Money.fromDb) instead.
--
--   * commission_rules.commission_value / source_fee_rules.fee_value — DUAL-TYPED:
--     dollars when the type is FIXED, a RATE when PERCENTAGE. A rate is not money
--     and keeps its precision, so 0.125% stays expressible.
--
-- Gate: refuse to run if any targeted column holds a non-cent value, so the type
-- change can never silently rewrite money. (Postgres would round half-AWAY-from-
-- zero here, while the engine rounds half-even — they must never disagree.)
DO $$
DECLARE n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM payouts WHERE amount<>round(amount,2) OR fee_amount<>round(fee_amount,2) OR net_amount<>round(net_amount,2))
  + (SELECT count(*) FROM loads   WHERE amount<>round(amount,2) OR fee_amount<>round(fee_amount,2) OR net_amount<>round(net_amount,2))
  + (SELECT count(*) FROM whish_payments  WHERE amount<>round(amount,2))
  + (SELECT count(*) FROM whish_transfers WHERE amount<>round(amount,2))
  + (SELECT count(*) FROM commission_rules WHERE min_amount<>round(min_amount,2) OR max_amount<>round(max_amount,2))
  + (SELECT count(*) FROM source_fee_rules WHERE min_amount<>round(min_amount,2) OR max_amount<>round(max_amount,2))
  + (SELECT count(*) FROM withdrawal_auto_approval_configs WHERE max_auto_approve_amount<>round(max_auto_approve_amount,2))
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing to narrow: % row(s) still hold a non-cent value; quantize them deliberately first', n;
  END IF;
END $$;

-- One ALTER TABLE per table: multiple clauses share a single rewrite. Every table
-- here is small (largest ~2.7 MB), so each lock is milliseconds.
ALTER TABLE "payouts"
  ALTER COLUMN "amount"     TYPE numeric(20,2),
  ALTER COLUMN "fee_amount" TYPE numeric(20,2),
  ALTER COLUMN "net_amount" TYPE numeric(20,2);

ALTER TABLE "loads"
  ALTER COLUMN "amount"     TYPE numeric(20,2),
  ALTER COLUMN "fee_amount" TYPE numeric(20,2),
  ALTER COLUMN "net_amount" TYPE numeric(20,2);

ALTER TABLE "whish_payments"  ALTER COLUMN "amount" TYPE numeric(20,2);
ALTER TABLE "whish_transfers" ALTER COLUMN "amount" TYPE numeric(20,2);

-- Bounds only — the VALUE columns stay wide because they are dual-typed rates.
ALTER TABLE "commission_rules"
  ALTER COLUMN "min_amount" TYPE numeric(20,2),
  ALTER COLUMN "max_amount" TYPE numeric(20,2);

ALTER TABLE "source_fee_rules"
  ALTER COLUMN "min_amount" TYPE numeric(20,2),
  ALTER COLUMN "max_amount" TYPE numeric(20,2);

ALTER TABLE "withdrawal_auto_approval_configs"
  ALTER COLUMN "max_auto_approve_amount" TYPE numeric(20,2);
