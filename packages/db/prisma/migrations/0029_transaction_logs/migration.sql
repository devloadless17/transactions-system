-- =================================================================
-- 0029_transaction_logs
--
-- Request/response audit for the two transaction entry points, so the
-- super admin can inspect exactly what came in and what we answered:
--   WHISH_LINK — every Whish payment-link generation.
--   INGEST     — every source ingest call (including rejected attempts).
--
-- Admin-only: unlike the tenant tables, the RLS policy allows ONLY
-- app_bypass_rls() (set by runAsAdmin) for both read and write, so no
-- tenant role can ever see these rows. company_id is denormalised (no
-- FK) so a log row is independent of the row it describes.
-- =================================================================

-- ----- 1. Kind enum -----
CREATE TYPE "TransactionLogKind" AS ENUM ('WHISH_LINK', 'INGEST');

-- ----- 2. Table -----
CREATE TABLE "transaction_logs" (
  "id"             UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "kind"           "TransactionLogKind"        NOT NULL,
  "company_id"     UUID,
  "source_code"    TEXT,
  "reference"      TEXT,
  "transaction_id" UUID,
  "status_code"    INTEGER                     NOT NULL,
  "success"        BOOLEAN                     NOT NULL,
  "request"        JSONB,
  "response"       JSONB,
  "created_at"     TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "transaction_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transaction_logs_kind_created_at_idx"
  ON "transaction_logs" ("kind", "created_at");

-- ----- 3. Row-level security: admin-only (bypass) for read AND write. -----
ALTER TABLE "transaction_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transaction_logs" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "transaction_logs_admin_only" ON "transaction_logs"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());

-- ----- 4. Grants — match the existing pattern from 0003_app_rls_role. -----
GRANT SELECT, INSERT, UPDATE, DELETE ON "transaction_logs" TO txn_app_rls;
