-- =================================================================
-- 0027_money_out_nonneg_checks
--
-- Defense-in-depth: transactions already CHECK commission_amount >= 0 and
-- net_amount >= 0 (migration 0016). The money-OUT flows (withdrawals, payouts,
-- loads) only had amount > 0 and lacked the same guards on fee/net. The app
-- layer already rejects a fee > amount (CommissionExceedsAmountError), so this
-- is a last line of defence: a future fee-rule edge, an ON_TOP miscalculation,
-- or a direct/SQL backfill can never silently persist a negative fee or net.
--
-- Pre-verified against live data: MIN(fee_amount), MIN(net_amount) >= 0 across
-- withdrawals/payouts/loads before adding these constraints.
-- =================================================================

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_fee_nonneg_chk" CHECK ("fee_amount" >= 0),
  ADD CONSTRAINT "withdrawals_net_nonneg_chk" CHECK ("net_amount" >= 0);

ALTER TABLE "payouts"
  ADD CONSTRAINT "payouts_fee_nonneg_chk" CHECK ("fee_amount" >= 0),
  ADD CONSTRAINT "payouts_net_nonneg_chk" CHECK ("net_amount" >= 0);

ALTER TABLE "loads"
  ADD CONSTRAINT "loads_fee_nonneg_chk" CHECK ("fee_amount" >= 0),
  ADD CONSTRAINT "loads_net_nonneg_chk" CHECK ("net_amount" >= 0);
