-- =================================================================
-- 0025_crm_integration
--
-- Per-company CRM integration. We make an outbound HTTP POST to the
-- company's own CRM endpoint for each transaction's status lifecycle
-- (pending → completed, failed/expired, reversed), authenticating with
-- the company's API key in the Authorization header.
--
--   1. companies.crm_*           — the company's CRM POST URL + API key,
--                                  an enabled flag, and the demo inbox
--                                  credentials (token + key) that back the
--                                  built-in live "mock CRM" preview.
--   2. crm_demo_events           — tenant-scoped feed powering that preview;
--                                  one row per logical transaction, upserted
--                                  by (company_id, reference) so a record
--                                  visibly transitions PENDING → COMPLETED.
--
-- Durable, retried delivery reuses the existing webhook_deliveries table
-- (created in 0001, RLS in 0002) — no new delivery table needed.
-- =================================================================

-- ----- 1. Company CRM config (idempotent) -----
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "crm_api_url"    TEXT;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "crm_api_key"    TEXT;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "crm_enabled"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "crm_demo_token" TEXT;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "crm_demo_key"   TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "companies_crm_demo_token_key"
  ON "companies" ("crm_demo_token");

-- ----- 2. CRM demo inbox table -----
CREATE TABLE IF NOT EXISTS "crm_demo_events" (
  "id"          UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "company_id"  UUID                        NOT NULL,
  "reference"   TEXT                        NOT NULL,
  "event_type"  TEXT                        NOT NULL,
  "status"      TEXT                        NOT NULL,
  "payload"     JSONB                       NOT NULL,
  "received_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "crm_demo_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_demo_events_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_demo_events_company_reference_key"
  ON "crm_demo_events" ("company_id", "reference");
CREATE INDEX IF NOT EXISTS "crm_demo_events_company_received_idx"
  ON "crm_demo_events" ("company_id", "received_at");

-- ----- 3. Row-level security (mirror of the other tenant tables) -----
ALTER TABLE "crm_demo_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "crm_demo_events" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "crm_demo_events_tenant_isolation" ON "crm_demo_events"
  USING      (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR "company_id" = app_current_company_id());

-- ----- 4. Grants — match the existing pattern from 0003_app_rls_role. -----
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_demo_events" TO txn_app_rls;
