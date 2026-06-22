-- ============================================================
-- 20260622190000_source_fee_rules
--
-- Per-source COST schedule: what an upstream payment source (e.g. Whish) charges
-- THE PLATFORM on each incoming deposit. This is the inverse of commission_rules
-- (what the platform charges its companies) and exists only to compute the
-- platform's *net* revenue:  net = platform revenue (FEE ledger) − source fees.
-- It is system/admin-only data — companies never see it.
--
-- Shape mirrors commission_rules: an amount band [min_amount, max_amount] per
-- channel carrying either a FIXED amount or a PERCENTAGE rate. `channel`
-- distinguishes a source's deposit products. For Whish:
--   INGEST     — a direct ingest-API deposit (POST /v1/{sourceCode}/transactions)
--   WHISH_PAY  — a deposit settled from a Whish collect link (a whish_payments row
--                points at the transaction)
-- Net-revenue analytics classify each COMPLETED deposit by whether a
-- whish_payments row references it, then apply the matching tier.
--
-- Additive: a new enum + a new table only. No change to any existing table, to
-- the ledger, or to money-movement logic. `sources` is global/admin-only and not
-- under RLS, so source_fee_rules follows the same posture — no company_id, no
-- RLS, reached only through the admin-guarded sources controller.
-- ============================================================

CREATE TYPE "SourceFeeChannel" AS ENUM ('INGEST', 'WHISH_PAY');

CREATE TABLE "source_fee_rules" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id"  UUID NOT NULL,
  "channel"    "SourceFeeChannel" NOT NULL DEFAULT 'INGEST',
  "min_amount" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "max_amount" DECIMAL(20, 8),
  "fee_type"   "CommissionType" NOT NULL,
  "fee_value"  DECIMAL(20, 8) NOT NULL,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "source_fee_rules_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE,
  CONSTRAINT "source_fee_rules_amount_range_chk" CHECK ("max_amount" IS NULL OR "min_amount" <= "max_amount"),
  CONSTRAINT "source_fee_rules_min_nonneg_chk" CHECK ("min_amount" >= 0),
  CONSTRAINT "source_fee_rules_value_nonneg_chk" CHECK ("fee_value" >= 0)
);

CREATE INDEX "source_fee_rules_source_channel_active_idx"
  ON "source_fee_rules"("source_id", "channel", "active");
