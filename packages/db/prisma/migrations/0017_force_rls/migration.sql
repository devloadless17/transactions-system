-- =================================================================
-- 0017_force_rls
--
-- Defense-in-depth: FORCE ROW LEVEL SECURITY on every tenant table. By default
-- the table OWNER is exempt from RLS; FORCE removes that exemption so even a
-- connection as the owning role is constrained by the policies. (Superusers
-- still bypass — migrations run as a superuser — and the app's explicit
-- app.bypass_rls='on' path is policy logic, so both keep working.)
--
-- Combined with the runtime connecting as the non-owner txn_app_rls role, this
-- means a misconfigured DATABASE_URL pointing at the owner can no longer
-- silently disable tenant isolation.
-- =================================================================

ALTER TABLE "companies"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"              FORCE ROW LEVEL SECURITY;
ALTER TABLE "api_keys"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "commission_rules"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "transactions"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "wallets"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "withdrawals"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "payouts"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "loads"              FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "whish_payments"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "company_sources"    FORCE ROW LEVEL SECURITY;
