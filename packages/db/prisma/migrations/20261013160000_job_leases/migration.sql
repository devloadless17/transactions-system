-- =================================================================
-- 20261013160000_job_leases
--
-- Cross-instance leases for background work that must never run in two
-- places at once. A blue/green deploy runs the old and the new API side by
-- side for a few seconds, so an in-process "already running" flag is no
-- longer enough: withdrawal auto-approval (real Whish transfers), every W2W
-- send (one shared session counter) and the Whish payment poller each take a
-- lease here first (apps/api/src/database/job-lease.service.ts).
--
-- One row per lease name. A holder owns it until `expires_at` (the DATABASE
-- clock, never an instance's clock); it renews while it works and releases it
-- when done, and a crashed holder's lease simply runs out.
--
-- PLATFORM-level, like withdrawal_auto_approval_configs: RLS allows only
-- app_bypass_rls() (set by runAsAdmin), so no tenant role can see or write it.
--
-- Additive only: a new table, nothing existing is touched or locked. The
-- previous release ignores it, so it is safe while that release still serves.
-- =================================================================

CREATE TABLE "job_leases" (
  "name"        TEXT                        NOT NULL,
  "holder"      TEXT                        NOT NULL,
  "acquired_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "renewed_at"  TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "expires_at"  TIMESTAMP(6) WITH TIME ZONE NOT NULL,

  CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

ALTER TABLE "job_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_leases" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "job_leases_admin_only" ON "job_leases"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());

GRANT SELECT, INSERT, UPDATE, DELETE ON "job_leases" TO txn_app_rls;
