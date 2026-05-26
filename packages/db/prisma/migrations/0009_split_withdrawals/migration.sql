-- =================================================================
-- 0009_split_withdrawals: Split `withdrawals` into three independent
-- processes — withdrawals, payouts, loads.
--
-- Why: each of WITHDRAW / PAYOUT / LOAD is a distinct user-facing
-- process with its own page, endpoint, and lifecycle. Sharing a table
-- with a discriminator (`kind`) made every list/filter/index pay for
-- the others. Splitting gives each process its own clean storage and
-- makes future divergence cheap.
--
-- Shape: the three tables have the same columns as `withdrawals` did
-- (minus the `kind` discriminator). PAYOUT and LOAD rows are migrated
-- out of the existing `withdrawals` table; only WITHDRAW rows remain
-- there. Ledger entries gain `payout_id` and `load_id` so ledger lines
-- can still reference the originating row.
-- =================================================================

-- ----- 1. Create the new tables (mirror of withdrawals minus `kind`) -----

CREATE TABLE "payouts" (
  "id"                 UUID                            NOT NULL DEFAULT gen_random_uuid(),
  "company_id"         UUID                            NOT NULL,
  "amount"             NUMERIC(20, 8)                  NOT NULL,
  "currency"           CHAR(3)                         NOT NULL,
  "status"             "WithdrawalStatus"              NOT NULL DEFAULT 'PENDING',
  "requested_by_id"    UUID                            NOT NULL,
  "approved_by_id"     UUID,
  "notes"              TEXT,
  "metadata"           JSONB,
  "processed_at"       TIMESTAMP(6) WITH TIME ZONE,
  "created_at"         TIMESTAMP(6) WITH TIME ZONE     NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMP(6) WITH TIME ZONE     NOT NULL DEFAULT NOW(),
  "payout_method"      "PayoutMethod"                  NOT NULL,
  "payout_details"     JSONB,
  "external_reference" TEXT,

  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payouts_amount_pos_chk" CHECK ("amount" > 0),
  CONSTRAINT "payouts_company_id_fkey"   FOREIGN KEY ("company_id")      REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "payouts_requested_by_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"     ("id") ON DELETE RESTRICT,
  CONSTRAINT "payouts_approved_by_fkey"  FOREIGN KEY ("approved_by_id")  REFERENCES "users"     ("id") ON DELETE RESTRICT
);

CREATE INDEX "payouts_company_created_idx" ON "payouts" ("company_id", "created_at");
CREATE INDEX "payouts_company_status_idx"  ON "payouts" ("company_id", "status");
CREATE INDEX "payouts_payout_method_idx"   ON "payouts" ("payout_method");

CREATE TABLE "loads" (
  "id"                 UUID                            NOT NULL DEFAULT gen_random_uuid(),
  "company_id"         UUID                            NOT NULL,
  "amount"             NUMERIC(20, 8)                  NOT NULL,
  "currency"           CHAR(3)                         NOT NULL,
  "status"             "WithdrawalStatus"              NOT NULL DEFAULT 'PENDING',
  "requested_by_id"    UUID                            NOT NULL,
  "approved_by_id"     UUID,
  "notes"              TEXT,
  "metadata"           JSONB,
  "processed_at"       TIMESTAMP(6) WITH TIME ZONE,
  "created_at"         TIMESTAMP(6) WITH TIME ZONE     NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMP(6) WITH TIME ZONE     NOT NULL DEFAULT NOW(),
  "payout_method"      "PayoutMethod"                  NOT NULL,
  "payout_details"     JSONB,
  "external_reference" TEXT,

  CONSTRAINT "loads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loads_amount_pos_chk" CHECK ("amount" > 0),
  CONSTRAINT "loads_company_id_fkey"   FOREIGN KEY ("company_id")      REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "loads_requested_by_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"     ("id") ON DELETE RESTRICT,
  CONSTRAINT "loads_approved_by_fkey"  FOREIGN KEY ("approved_by_id")  REFERENCES "users"     ("id") ON DELETE RESTRICT
);

CREATE INDEX "loads_company_created_idx" ON "loads" ("company_id", "created_at");
CREATE INDEX "loads_company_status_idx"  ON "loads" ("company_id", "status");
CREATE INDEX "loads_payout_method_idx"   ON "loads" ("payout_method");

-- ----- 2. Ledger gets two new FK columns so payout/load rows can be
--         referenced from their ledger entries. `withdrawal_id` stays
--         for withdrawals. Only one of the three is set per entry.   -----

ALTER TABLE "ledger_entries"
  ADD COLUMN "payout_id" UUID,
  ADD COLUMN "load_id"   UUID;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "ledger_entries_load_id_fkey"   FOREIGN KEY ("load_id")   REFERENCES "loads"   ("id") ON DELETE RESTRICT;

CREATE INDEX "ledger_entries_payout_id_idx" ON "ledger_entries" ("payout_id");
CREATE INDEX "ledger_entries_load_id_idx"   ON "ledger_entries" ("load_id");

-- ----- 3. Move PAYOUT rows out of withdrawals into payouts (and re-point
--         their ledger entries), same for LOAD.
--
-- ledger_entries has append-only triggers (reject_modification on UPDATE
-- and DELETE). For this one-time migration we suspend them, run the
-- re-point, then re-enable. Inside a single statement-level transaction
-- the rows remain invariant from the outside. -----

ALTER TABLE "ledger_entries" DISABLE TRIGGER "ledger_entries_no_update";

-- Copy PAYOUT rows.
INSERT INTO "payouts" (
  "id","company_id","amount","currency","status","requested_by_id",
  "approved_by_id","notes","metadata","processed_at","created_at","updated_at",
  "payout_method","payout_details","external_reference"
)
SELECT
  "id","company_id","amount","currency","status","requested_by_id",
  "approved_by_id","notes","metadata","processed_at","created_at","updated_at",
  "payout_method","payout_details","external_reference"
FROM "withdrawals"
WHERE "kind" = 'PAYOUT';

-- Re-point any ledger entries that referenced those rows.
UPDATE "ledger_entries"
   SET "payout_id"     = "withdrawal_id",
       "withdrawal_id" = NULL
 WHERE "withdrawal_id" IN (SELECT "id" FROM "withdrawals" WHERE "kind" = 'PAYOUT');

-- Copy LOAD rows.
INSERT INTO "loads" (
  "id","company_id","amount","currency","status","requested_by_id",
  "approved_by_id","notes","metadata","processed_at","created_at","updated_at",
  "payout_method","payout_details","external_reference"
)
SELECT
  "id","company_id","amount","currency","status","requested_by_id",
  "approved_by_id","notes","metadata","processed_at","created_at","updated_at",
  "payout_method","payout_details","external_reference"
FROM "withdrawals"
WHERE "kind" = 'LOAD';

UPDATE "ledger_entries"
   SET "load_id"       = "withdrawal_id",
       "withdrawal_id" = NULL
 WHERE "withdrawal_id" IN (SELECT "id" FROM "withdrawals" WHERE "kind" = 'LOAD');

ALTER TABLE "ledger_entries" ENABLE TRIGGER "ledger_entries_no_update";

-- Delete the moved rows from withdrawals.
DELETE FROM "withdrawals" WHERE "kind" IN ('PAYOUT', 'LOAD');

-- ----- 4. Drop the discriminator + enum. -----

ALTER TABLE "withdrawals" DROP COLUMN "kind";
DROP TYPE  "WithdrawalKind";

-- ----- 5. Row-level security on the new tables (mirror of withdrawals). ----

ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payouts_tenant_isolation" ON "payouts"
  USING       (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK  (app_bypass_rls() OR "company_id" = app_current_company_id());

ALTER TABLE "loads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loads_tenant_isolation" ON "loads"
  USING       (app_bypass_rls() OR "company_id" = app_current_company_id())
  WITH CHECK  (app_bypass_rls() OR "company_id" = app_current_company_id());

-- ----- 6. Grants — match the existing pattern from 0003_app_rls_role. ----

GRANT SELECT, INSERT, UPDATE, DELETE ON "payouts" TO txn_app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON "loads"   TO txn_app_rls;
