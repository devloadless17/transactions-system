-- =================================================================
-- 20260622120000_notifications
--
-- In-app notifications for the topbar bell.
--
--   notifications       — one row per event. ADMIN-scope rows (a new
--                         withdrawal/payout/load request to action) are stored
--                         with company_id = NULL so RLS can never leak them to a
--                         tenant; the subject company is in `metadata`.
--                         COMPANY-scope rows (request approved/rejected/…)
--                         belong to one company and are RLS-isolated by it.
--   notification_reads  — per-user read marker. Unread until a row exists for
--                         (notification_id, user_id). company_id denormalised so
--                         a tenant only sees its own markers.
--
-- RLS mirrors the other tenant tables (see 0026_crm_integration).
-- =================================================================

-- ----- notifications -----
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"         UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "scope"      TEXT                        NOT NULL,
  "company_id" UUID,
  "flow"       TEXT                        NOT NULL,
  "event"      TEXT                        NOT NULL,
  "title"      TEXT                        NOT NULL,
  "body"       TEXT                        NOT NULL,
  "link"       TEXT                        NOT NULL,
  "entity_id"  UUID,
  "metadata"   JSONB,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notifications_scope_company_created_idx"
  ON "notifications" ("scope", "company_id", "created_at");

-- ----- notification_reads -----
CREATE TABLE IF NOT EXISTS "notification_reads" (
  "id"              UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "notification_id" UUID                        NOT NULL,
  "user_id"         UUID                        NOT NULL,
  "company_id"      UUID,
  "read_at"         TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_reads_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_reads_notification_user_key"
  ON "notification_reads" ("notification_id", "user_id");
CREATE INDEX IF NOT EXISTS "notification_reads_user_idx"
  ON "notification_reads" ("user_id");

-- ----- Row-level security (mirror of the other tenant tables) -----
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING      (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR "company_id" = app_current_company_id());

ALTER TABLE "notification_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_reads" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "notification_reads_tenant_isolation" ON "notification_reads"
  USING      (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR "company_id" = app_current_company_id());

-- ----- Grants — match the existing pattern from 0003_app_rls_role. -----
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications"      TO txn_app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_reads" TO txn_app_rls;
