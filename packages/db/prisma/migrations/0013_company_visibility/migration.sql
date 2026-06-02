-- =================================================================
-- 0013_company_visibility
--
-- Companies gain a `visible` flag. When false the company is hidden from
-- discovery/list APIs (the source-facing GET /v1/ingest/companies), while
-- all of its data is retained. Existing rows default to visible = true, so
-- current behaviour is unchanged. Toggled by SUPER_ADMIN.
--
-- No new tables → existing RLS policies + grants (0002, 0003) already apply.
-- =================================================================

ALTER TABLE "companies"
  ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;
