-- =================================================================
-- 20261013140000_whish_refund
--
-- Lets an operator refund a PAID Whish payment back to the payer through
-- Whish's own refund endpoint (POST /payment/whish/refund, Whish Pay v1.4.3+).
--
--   * WhishPaymentStatus gains REFUNDED — the money went back to the payer and
--     the settled deposit was reversed in the ledger.
--   * TransactionLogKind gains WHISH_REFUND — the request we sent Whish and its
--     raw reply, kept for the super-admin log (disputes with the provider).
--   * refund_requested_at — set the moment a refund is sent to Whish, BEFORE the
--     call. It is the lock that stops a double click (or two operators) from
--     sending two refunds, and the marker that tells a later Refresh that a
--     `refunded` reading is OUR refund and may be booked.
--   * refunded_at — when the refund was booked.
--
-- Additive and catalog-only: two nullable columns with no default (no rewrite)
-- and two new enum values. The previous API version never reads or writes any
-- of them, so it keeps working while this runs, and a rollback ignores them.
-- Postgres refuses to USE an enum value inside the transaction that added it;
-- nothing below does (the guard compares status as TEXT).
-- =================================================================

-- AlterEnum
ALTER TYPE "WhishPaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- AlterEnum
ALTER TYPE "TransactionLogKind" ADD VALUE IF NOT EXISTS 'WHISH_REFUND';

-- AlterTable
ALTER TABLE "whish_payments"
  ADD COLUMN "refund_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "refunded_at" TIMESTAMPTZ(6);

-- Defense in depth, as 0018 does for the other money tables: a REFUNDED payment
-- may never change status again. Only REFUNDED is terminal here — FAILED and
-- EXPIRED are not, because a customer who pays after a link lapsed is recovered
-- to PAID on purpose (see reconcile's paid-after-expiry path).
CREATE OR REPLACE FUNCTION reject_terminal_status_change() RETURNS TRIGGER AS $$
DECLARE
  terminal TEXT[];
BEGIN
  -- Only care about actual status changes.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  terminal := CASE TG_TABLE_NAME
    WHEN 'transactions' THEN ARRAY['REVERSED', 'REFUNDED', 'FAILED']
    WHEN 'whish_payments' THEN ARRAY['REFUNDED']
    ELSE ARRAY['COMPLETED', 'REJECTED', 'CANCELLED'] -- withdrawals / payouts / loads
  END;

  IF OLD.status::text = ANY(terminal) THEN
    RAISE EXCEPTION 'Illegal status transition on %: % is terminal (attempted -> %)',
      TG_TABLE_NAME, OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER whish_payments_status_guard
  BEFORE UPDATE ON "whish_payments"
  FOR EACH ROW EXECUTE FUNCTION reject_terminal_status_change();
