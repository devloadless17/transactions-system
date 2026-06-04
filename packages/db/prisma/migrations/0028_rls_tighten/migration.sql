-- =================================================================
-- 0028_rls_tighten
--
-- Close two RLS defense-in-depth gaps surfaced by the pre-deploy review.
-- Neither is exposed through a current API endpoint (the only readers run
-- under runAsAdmin / app.bypass_rls), but RLS is the backstop that guarantees
-- a forgotten where-clause or an injection on the app connection can't leak
-- across tenants — so it should actually hold for these tables too.
-- =================================================================

-- 1. audit_logs: a tenant-scoped session could read every PLATFORM/ADMIN audit
--    row (company_id IS NULL) — other companies' approvals, admin user/source-key
--    creations. Drop the NULL term from the read policy so a tenant only sees its
--    OWN rows. Admin reads run under app.bypass_rls and are unaffected. WITH CHECK
--    is left unchanged so existing writes (incl. NULL-company platform events) are
--    not affected.
ALTER POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  USING (app_bypass_rls() OR "company_id" = app_current_company_id());

-- 2. refresh_tokens had NO row-level security at all — a tenant-scoped session
--    (or a SQL-injection reaching the app connection) could read every user's
--    session-token hash, enabling session takeover. All legitimate access
--    (auth.service, maintenance.service) already runs under runAsAdmin, so lock
--    the table to admin/bypass only. Mirrors the FORCE-RLS posture already
--    applied to the tenant money tables in 0017.
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "refresh_tokens_admin_only" ON "refresh_tokens"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());
