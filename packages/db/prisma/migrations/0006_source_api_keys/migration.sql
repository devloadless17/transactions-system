-- Source-bound API keys.
--
-- Until now api_keys.company_id was NOT NULL. We're introducing a second
-- key flavour for external sources (OMT, wish_money, ...) that posts
-- transactions to /v1/ingest/transactions and addresses a company via
-- `companySlug` in the body. Source keys have company_id NULL and
-- source_id NOT NULL. Existing company keys keep their company_id.

ALTER TABLE "api_keys"
  ALTER COLUMN "company_id" DROP NOT NULL,
  ADD COLUMN "source_id" UUID NULL REFERENCES "sources"("id") ON DELETE CASCADE;

-- Exactly one of (company_id, source_id) must be set.
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_owner_xor"
  CHECK (
    (company_id IS NOT NULL AND source_id IS NULL)
    OR (company_id IS NULL AND source_id IS NOT NULL)
  );

CREATE INDEX "api_keys_source_id_idx" ON "api_keys"("source_id");

-- Drop the (company_id, name) uniqueness — it's no longer the right
-- key for source-bound rows. Names are free-form; rotation/revocation
-- happens by id.
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_company_id_name_key";

-- Tenant isolation: company users see only their own COMPANY keys.
-- Source keys (company_id IS NULL) are admin-only and visible only when
-- bypass_rls is on. We drop & recreate the policy to keep it explicit.
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING (
    app_bypass_rls()
    OR (company_id IS NOT NULL AND company_id = app_current_company_id())
  )
  WITH CHECK (
    app_bypass_rls()
    OR (company_id IS NOT NULL AND company_id = app_current_company_id())
  );
