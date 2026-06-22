-- ============================================================
-- 20260622220000_source_fee_rules_grant
--
-- Explicit table privileges for the runtime RLS role on source_fee_rules — every
-- other table's migration grants this explicitly; source_fee_rules previously
-- relied only on ALTER DEFAULT PRIVILEGES (it works, but the inconsistency is a
-- footgun if default privileges ever change). source_fee_rules is global admin
-- config (no company_id, not under RLS), reached only via runAsAdmin in the
-- admin-guarded sources controller. Idempotent (GRANT is a no-op if already held).
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON "source_fee_rules" TO txn_app_rls;
