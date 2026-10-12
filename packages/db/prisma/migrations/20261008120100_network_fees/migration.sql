-- =================================================================
-- 20261008120100_network_fees
--
-- Optional per-company NETWORK FEE: a second platform fee charged next to the
-- commission, priced per flow. OFF for every company by default — until a
-- SUPER_ADMIN switches it on for a company, nothing anywhere changes.
--
-- This file creates the rate table only. The rest of the feature's schema is
-- in the files that follow, ONE LIVE TABLE PER FILE:
--   20261008120200_network_fee_withdrawals     withdrawals.network_fee_amount
--   20261008120300_network_fee_payouts         payouts.network_fee_amount
--   20261008120400_network_fee_loads           loads.network_fee_amount
--   20261008120500_network_fee_company_switch  companies.network_fee_enabled
--   20261008120600_network_fee_transactions    transactions.network_fee_amount
--   20261008120700_network_fee_ledger_index    NETWORK_FEE revenue index
--
-- Why split: Prisma applies a file as a single transaction, and an ALTER TABLE
-- holds its ACCESS EXCLUSIVE lock until that transaction commits — while the
-- PREVIOUS API version is still serving. One file altering several live tables
-- can deadlock against a money write that touches them in the opposite order;
-- Postgres would abort the migration, and a failed migration blocks every later
-- deploy until it is resolved by hand. A file that locks one table can only
-- wait, never deadlock. (An earlier revision of this file held every statement;
-- it only ever reached staging and development databases, where the follow-up
-- files are no-ops.)
--
-- Safe while the previous API version serves: a brand-new table nobody reads
-- yet. Its foreign key takes a SHARE ROW EXCLUSIVE lock on `companies`, which
-- does not block reads or the foreign-key checks of money writes.
-- =================================================================

-- Per-company, per-flow rate. Row absent = no network fee on that flow.
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
