-- ============================================================
-- 0003_app_rls_role
--
-- The default DB user used for migrations is a superuser, which
-- BYPASSES RLS. The runtime API must connect as a non-superuser
-- role so that RLS policies actually take effect.
--
-- We create role `txn_app_rls` (no superuser, no BYPASSRLS), give
-- it the privileges needed for normal CRUD, and let it inherit
-- the bypass GUC only when `app.bypass_rls = 'on'` is set inside
-- a transaction (which superusers respect via app_bypass_rls()).
--
-- Operators should point DATABASE_URL to `txn_app_rls` in
-- production. The default .env keeps using `txn_app` for now;
-- the dev workflow is unchanged but RLS will be exercised once
-- the role is wired up.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txn_app_rls') THEN
    CREATE ROLE txn_app_rls LOGIN PASSWORD 'txn_app_rls_dev_password';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO txn_app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO txn_app_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO txn_app_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO txn_app_rls;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO txn_app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO txn_app_rls;
