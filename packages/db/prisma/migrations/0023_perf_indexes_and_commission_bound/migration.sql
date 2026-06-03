-- ============================================================
-- 0023_perf_indexes_and_commission_bound
--
-- (1) Scale-time indexes for the cross-tenant admin analytics, mirroring 0019.
--     The platform / flows rollups aggregate the flow tables by
--     (status='COMPLETED', processed_at) and the FEE ledger by
--     (account_type='FEE', created_at) with NO company_id predicate, so the
--     existing company_id-leading indexes don't help and Postgres seq-scans the
--     whole table at 1M-10M+ rows (4-5 such queries run per admin dashboard load,
--     against Prisma's 5s tx timeout). Partial indexes (not expressible in the
--     Prisma schema) live here as raw SQL, consistent with the other hand-written
--     migrations.
-- (2) Defense-in-depth CHECK so a PERCENTAGE commission rule can never store a
--     value > 100. The service now validates the effective merged rule on update
--     (commissions.service.ts); this guarantees it at the DB even against direct
--     SQL or a future code path.
-- ============================================================

-- (1a) Out-flows (withdrawals, payouts) and loads settle on approval; the platform
-- rollup windows the COMPLETED rows by processed_at per currency, cross-tenant.
-- Matches platform-analytics.service.ts.
CREATE INDEX IF NOT EXISTS "withdrawals_completed_currency_processed_idx"
  ON "withdrawals" ("currency", "processed_at")
  WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "payouts_completed_currency_processed_idx"
  ON "payouts" ("currency", "processed_at")
  WHERE "status" = 'COMPLETED';

CREATE INDEX IF NOT EXISTS "loads_completed_currency_processed_idx"
  ON "loads" ("currency", "processed_at")
  WHERE "status" = 'COMPLETED';

-- (1b) Platform fee revenue = SUM over the FEE ledger account by currency +
-- created_at range, cross-tenant. Matches analytics.service.ts (totalFees) and
-- platform-analytics.service.ts. FEE is a large share of a ledger several times
-- the transaction count, so a partial (currency, created_at) WHERE FEE index keeps
-- the aggregate focused instead of scanning the whole ledger.
CREATE INDEX IF NOT EXISTS "ledger_entries_fee_currency_created_idx"
  ON "ledger_entries" ("currency", "created_at")
  WHERE "account_type" = 'FEE';

-- (2) A PERCENTAGE commission value must be in [0, 100]. FIXED values stay only
-- non-negative (commission_rules_value_nonneg_chk from 0001); the resolver caps a
-- FIXED fee at the amount at compute time (CommissionExceedsAmountError).
ALTER TABLE "commission_rules"
  ADD CONSTRAINT "commission_rules_pct_value_bound_chk"
  CHECK ("commission_type" <> 'PERCENTAGE' OR "commission_value" <= 100);
