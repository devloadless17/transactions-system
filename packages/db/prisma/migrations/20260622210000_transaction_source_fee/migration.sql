-- ============================================================
-- 20260622210000_transaction_source_fee
--
-- Scale + correctness fix for net-revenue. Previously the source fee a deposit
-- cost the platform was RE-COMPUTED per-deposit on every analytics call via a
-- correlated subquery (O(deposits) sub-probes per dashboard load) — fine on a
-- small DB, a timeout at millions of deposits. We now PERSIST the per-deposit
-- source fee on the transaction at settlement (exactly like `commission_amount`),
-- so analytics just SUM a column. It also freezes the cost at settlement time
-- (a later fee-schedule edit no longer rewrites history), which is the correct
-- semantic for a cost ledger.
--
-- Additive: one nullable-defaulted money column. NOT a ledger account — this is a
-- recorded cost estimate alongside commission_amount, with no wallet/ledger
-- impact. Backfill below populates existing COMPLETED deposits from the current
-- schedule (one-time; classifies channel by the whish_payments link, which is
-- already set for historical rows).
-- ============================================================

ALTER TABLE "transactions"
  ADD COLUMN "source_fee_amount" DECIMAL(20, 8) NOT NULL DEFAULT 0;

-- Backfill historical COMPLETED deposits: pick the lowest-min matching tier for
-- the deposit's channel and apply FIXED / PERCENTAGE. round(.,8) to match the
-- ledger's money scale (new rows are rounded ROUND_HALF_EVEN in app code).
UPDATE "transactions" t
SET "source_fee_amount" = COALESCE((
  SELECT round(
    CASE r.fee_type
      WHEN 'FIXED' THEN r.fee_value
      ELSE t.amount * r.fee_value / 100
    END, 8)
  FROM "source_fee_rules" r
  WHERE r.source_id = t.source_id
    AND r.active
    AND r.channel = (
      CASE WHEN EXISTS (SELECT 1 FROM "whish_payments" wp WHERE wp.transaction_id = t.id)
           THEN 'WHISH_PAY'::"SourceFeeChannel"
           ELSE 'INGEST'::"SourceFeeChannel" END)
    AND t.amount >= r.min_amount
    AND (r.max_amount IS NULL OR t.amount <= r.max_amount)
  ORDER BY r.min_amount ASC
  LIMIT 1
), 0)
WHERE t.status = 'COMPLETED';
