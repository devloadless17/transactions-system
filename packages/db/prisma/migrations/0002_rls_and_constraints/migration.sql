-- ============================================================
-- 0002_rls_and_constraints — RLS policies + append-only triggers
--
-- Tenant isolation strategy: every tenant-scoped table has an RLS
-- policy comparing company_id to the GUC `app.current_company_id`,
-- which the API sets per request via `SET LOCAL` inside a
-- transaction. SUPER_ADMIN bypass is achieved by setting the GUC
-- `app.bypass_rls = on` (also per-request).
--
-- Append-only ledger and audit_logs: triggers reject UPDATE/DELETE.
-- ============================================================

-- ----------------- Helper: current_company_id() ------------------
CREATE OR REPLACE FUNCTION app_current_company_id() RETURNS UUID AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('app.current_company_id', true);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS BOOLEAN AS $$
DECLARE
  v TEXT;
BEGIN
  v := current_setting('app.bypass_rls', true);
  RETURN v = 'on';
END;
$$ LANGUAGE plpgsql STABLE;

-- ----------------- Enable RLS on tenant tables ------------------
ALTER TABLE "companies"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commission_rules"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "wallets"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ledger_entries"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawals"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys"   ENABLE ROW LEVEL SECURITY;

-- Companies: a row is visible if it is the current company, OR bypass is on.
CREATE POLICY "companies_tenant_isolation" ON "companies"
  USING (app_bypass_rls() OR id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR id = app_current_company_id());

-- Generic policy for tables with company_id (incl. NULL == admin/global).
CREATE POLICY "users_tenant_isolation" ON "users"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

-- commission_rules: company_id NULL = global rule, visible to all tenants.
CREATE POLICY "commission_rules_tenant_isolation" ON "commission_rules"
  USING (app_bypass_rls() OR company_id IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "transactions_tenant_isolation" ON "transactions"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "wallets_tenant_isolation" ON "wallets"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "ledger_entries_tenant_isolation" ON "ledger_entries"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "withdrawals_tenant_isolation" ON "withdrawals"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  USING (app_bypass_rls() OR company_id IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR (company_id IS NULL OR company_id = app_current_company_id()));

CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

CREATE POLICY "idempotency_keys_tenant_isolation" ON "idempotency_keys"
  USING (app_bypass_rls() OR company_id = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR company_id = app_current_company_id());

-- ----------------- Append-only enforcement -----------------------
-- ledger_entries and audit_logs are immutable records. We reject any
-- UPDATE or DELETE attempt at the database level so that even a bug in
-- application code cannot mutate history.

CREATE OR REPLACE FUNCTION reject_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
