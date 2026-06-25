-- =================================================================
-- 20260625140000_withdrawal_rounding_remainder
--
-- Track the sub-dollar cents the platform keeps when an auto Whish W2W transfer
-- floors the net "to pay" to a whole dollar (net 18.67 → transfer 18 → 0.67).
-- The remainder is realized into the FEE account (platform income) so the ledger
-- stays balanced; this column records it separately so total "leftovers" are
-- auditable and true commission revenue = FEE − SUM(rounding_remainder).
--
-- Constant DEFAULT 0 → no table rewrite (Postgres 11+); 0 for every existing and
-- non-floored row.
-- =================================================================

ALTER TABLE "withdrawals"
  ADD COLUMN "rounding_remainder" DECIMAL(20, 8) NOT NULL DEFAULT 0;
