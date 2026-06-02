-- =================================================================
-- 0015_company_sources
--
-- A SOURCE API key (held by an external provider, e.g. OMT/Whish) could
-- previously ingest a money-creating transaction for ANY active company by
-- passing its id in the request body — the comments promised a `company_sources`
-- opt-in that was never built. This adds it and the ingest path enforces it.
--
-- Backfill preserves current behaviour: every (company, source) pair that
-- already has a transaction (or a Whish payment) is enabled. New pairings
-- require an explicit admin opt-in; the Whish flow self-provisions on link
-- creation.
--
-- Tenant-scoped (RLS by company_id), mirroring the other tenant tables.
-- =================================================================

CREATE TABLE "company_sources" (
  "id"         UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "company_id" UUID                        NOT NULL,
  "source_id"  UUID                        NOT NULL,
  "enabled"    BOOLEAN                     NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "company_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_sources_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE CASCADE,
  CONSTRAINT "company_sources_source_id_fkey"
    FOREIGN KEY ("source_id")  REFERENCES "sources"   ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "company_sources_company_source_unique"
  ON "company_sources" ("company_id", "source_id");
CREATE INDEX "company_sources_source_enabled_idx"
  ON "company_sources" ("source_id", "enabled");

-- Row-level security (mirror of the other tenant tables).
ALTER TABLE "company_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_sources_tenant_isolation" ON "company_sources"
  USING      (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK (app_bypass_rls() OR "company_id" = app_current_company_id());

-- Grants — match the existing pattern from 0003_app_rls_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_sources" TO txn_app_rls;

-- ----- Backfill: keep every established pairing working -----
INSERT INTO "company_sources" ("company_id", "source_id", "enabled")
SELECT DISTINCT "company_id", "source_id", true
FROM "transactions"
ON CONFLICT ("company_id", "source_id") DO NOTHING;

-- Companies that have minted Whish links keep settling after the change.
INSERT INTO "company_sources" ("company_id", "source_id", "enabled")
SELECT DISTINCT wp."company_id", s."id", true
FROM "whish_payments" wp
CROSS JOIN "sources" s
WHERE s."code" = 'whish'
ON CONFLICT ("company_id", "source_id") DO NOTHING;
