-- company_slug_history shipped (20260826130000) without row-level security,
-- contradicting the project's codified posture (0017: FORCE RLS on every
-- tenant table; 0028: refresh_tokens locked to admin/bypass-only). All
-- legitimate access (CompaniesService create/update slug checks + tombstones)
-- already runs under runAsAdmin, so lock the table to admin/bypass only — a
-- tenant-scoped connection (or an injection reaching it) must not be able to
-- read other companies' slug history or plant/remove tombstones.
ALTER TABLE "company_slug_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_slug_history" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "company_slug_history_admin_only" ON "company_slug_history"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());
