-- ============================================================
-- 20260622230000_recompute_source_fee_backfill
--
-- One-time re-backfill of transactions.source_fee_amount from the CURRENT
-- source-fee schedules. The initial backfill (20260622210000) ran on deploy
-- BEFORE any source_fee_rules were configured in production, so it set every
-- deposit's source fee to 0. Operators then configured schedules (e.g. Whish)
-- through the UI — but the per-deposit fee is frozen at settlement, so those
-- already-settled deposits stayed at 0 and net-revenue under-counted source cost.
--
-- This recomputes every COMPLETED deposit once, now that schedules exist, so
-- historical deposits reflect them. Going forward this is handled in-app:
-- saving a source's schedule recomputes that source's deposits (SourcesService
-- .setFeeRules → recomputeSourceFeeAmounts), so this migration is a one-shot
-- catch-up, not a recurring need.
--
-- Idempotent (recomputes from current rules; re-running yields the same values).
-- O(completed deposits) — trivial at current volume; batch in a window if the
-- table is ever very large (see DEPLOYMENT.md).
-- ============================================================

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
