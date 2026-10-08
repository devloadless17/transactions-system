-- =================================================================
-- 20261008120100_network_fees
--
-- Optional per-company NETWORK FEE: a second platform fee charged next to the
-- commission, priced per flow. OFF for every company by default — until a
-- SUPER_ADMIN switches it on for a company, nothing anywhere changes.
--
-- Additive and catalog-only, safe while the previous API version serves:
--   * ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only change
--     (no table rewrite); every existing row reads as 0 / false, which is
--     exactly the old behaviour.
--   * CHECKs on the hot tables are added NOT VALID (no scan). They are still
--     enforced on every new or updated row, and every existing row is 0.
--   * No index on any hot table (migration-lock-safety.spec.ts).
-- Each ALTER holds its ACCESS EXCLUSIVE lock until this file commits, so the
-- ingest hot path (companies read, transactions insert) is altered LAST to
-- keep its lock hold as short as possible.
--
-- network_fee_amount is DECIMAL(20,2): a new column has no pre-cent history,
-- so the database itself enforces whole cents (docs/MONEY_SCALE.md). It also
-- never widens the scale of `net + fee + network_fee` sums beyond the table's
-- existing money columns.
-- =================================================================

-- 1) Frozen per-row network fee on the money-movement flows (low traffic first).
ALTER TABLE "withdrawals"
  ADD COLUMN "network_fee_amount" DECIMAL(20, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "withdrawals_network_fee_nonneg_chk" CHECK ("network_fee_amount" >= 0) NOT VALID;
ALTER TABLE "payouts"
  ADD COLUMN "network_fee_amount" DECIMAL(20, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "payouts_network_fee_nonneg_chk" CHECK ("network_fee_amount" >= 0) NOT VALID;
ALTER TABLE "loads"
  ADD COLUMN "network_fee_amount" DECIMAL(20, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "loads_network_fee_nonneg_chk" CHECK ("network_fee_amount" >= 0) NOT VALID;

-- 2) Per-company, per-flow rate. Row absent = no network fee on that flow.
CREATE TABLE "company_network_fees" (
  "company_id"     UUID               NOT NULL,
  "operation_type" "FeeOperationType" NOT NULL,
  "fee_type"       "CommissionType"   NOT NULL,
  -- DUAL-TYPED like commission_rules.commission_value: dollars when FIXED,
  -- a RATE (percent) when PERCENTAGE.
  "fee_value"      DECIMAL(20, 8)     NOT NULL,
  "created_at"     TIMESTAMPTZ(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6)     NOT NULL,

  CONSTRAINT "company_network_fees_pkey" PRIMARY KEY ("company_id", "operation_type"),
  CONSTRAINT "company_network_fees_company_id_fkey" FOREIGN KEY ("company_id")
    REFERENCES "companies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "company_network_fees_value_pos_chk" CHECK ("fee_value" > 0),
  CONSTRAINT "company_network_fees_pct_bound_chk"
    CHECK ("fee_type" <> 'PERCENTAGE' OR "fee_value" <= 100),
  CONSTRAINT "company_network_fees_fixed_cents_chk"
    CHECK ("fee_type" <> 'FIXED' OR "fee_value" = round("fee_value", 2))
);

-- A tenant may READ its own rows (the money flows read the rate inside the
-- company-scoped transaction); only admin/bypass may write. Two policies on
-- purpose: a single FOR ALL policy with a tenant USING clause would still let
-- a tenant DELETE its rows (DELETE is checked against USING only).
ALTER TABLE "company_network_fees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_network_fees" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "company_network_fees_tenant_read" ON "company_network_fees"
  FOR SELECT
  USING (app_bypass_rls() OR "company_id" = app_current_company_id());
CREATE POLICY "company_network_fees_admin_write" ON "company_network_fees"
  FOR ALL
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_network_fees" TO txn_app_rls;

-- 3) Master switch, default OFF.
ALTER TABLE "companies" ADD COLUMN "network_fee_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 4) Deposits LAST: shortest hold of the ingest hot-path lock.
ALTER TABLE "transactions"
  ADD COLUMN "network_fee_amount" DECIMAL(20, 2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "transactions_network_fee_nonneg_chk" CHECK ("network_fee_amount" >= 0) NOT VALID;
