-- 1) Durable marker for deposits booked despite a pricing gap ('unpriced': no
--    commission rule matched; 'capped': DEDUCTED fee > amount, capped at it).
--    Both book at net 0 with the full amount withheld as platform fee, and this
--    column is the queryable record of which rows an operator must compensate
--    once pricing is fixed. Nullable + no default → instant, no table rewrite.
ALTER TABLE "transactions" ADD COLUMN "pricing_issue" TEXT;

-- Partial index: compensation queries scan ONLY flagged rows; normal rows pay
-- nothing. Tiny by construction (pricing gaps are alert-on-sight rare).
--
-- NOTE: a plain CREATE INDEX briefly write-locks the table while the build
-- scans it. On an already-large deployment, build it CONCURRENTLY out-of-band
-- FIRST (the IF NOT EXISTS below then no-ops on deploy):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_pricing_issue_idx"
--     ON "transactions" ("created_at") WHERE "pricing_issue" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "transactions_pricing_issue_idx"
  ON "transactions" ("created_at")
  WHERE "pricing_issue" IS NOT NULL;

-- 2) Tombstones for renamed-away company slugs. The slug is the PUBLIC
--    identifier sources ingest with; if a freed slug were re-claimed by a
--    DIFFERENT company, a source still posting to it would book real money
--    into the wrong tenant. Create/rename reject any slug that ever belonged
--    to another company (a company may reclaim its own former slug).
CREATE TABLE "company_slug_history" (
  "slug"       TEXT NOT NULL,
  "company_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_slug_history_pkey" PRIMARY KEY ("slug"),
  CONSTRAINT "company_slug_history_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "company_slug_history_company_id_idx"
  ON "company_slug_history" ("company_id");
