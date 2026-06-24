-- =================================================================
-- 20260624130000_whish_transfers
--
-- Outbound whish-to-whish (W2W) transfers + the captured consumer-app
-- session used to sign them.
--
-- Both tables are PLATFORM-level (not tenant-scoped): like transaction_logs,
-- the RLS policy allows ONLY app_bypass_rls() (set by runAsAdmin) for read AND
-- write, so no tenant role can ever see/write these rows.
-- =================================================================

-- ----- 1. Extend the transaction-log kind enum -----
ALTER TYPE "TransactionLogKind" ADD VALUE IF NOT EXISTS 'WHISH_TRANSFER';

-- ----- 2. Transfer status enum -----
CREATE TYPE "WhishTransferStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN');

-- ----- 3. whish_transfers -----
CREATE TABLE "whish_transfers" (
  "id"               UUID                        NOT NULL DEFAULT gen_random_uuid(),
  "reference"        TEXT                        NOT NULL,
  "recipient_phone"  TEXT                        NOT NULL,
  "amount"           DECIMAL(20, 8)              NOT NULL,
  "currency"         CHAR(3)                     NOT NULL DEFAULT 'USD',
  "status"           "WhishTransferStatus"       NOT NULL DEFAULT 'PENDING',
  "trace_id"         TEXT,
  "session_counter"  INTEGER,
  "upstream_code"    TEXT,
  "upstream_message" TEXT,
  "request_body"     JSONB,
  "response_body"    JSONB,
  "actor_id"         UUID,
  "source"           TEXT                        NOT NULL DEFAULT 'ADMIN',
  "company_id"       UUID,
  "withdrawal_id"    UUID,
  "error_detail"     TEXT,
  "created_at"       TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "whish_transfers_pkey" PRIMARY KEY ("id")
);

-- Idempotency keys: one transfer per reference, and one per withdrawal.
CREATE UNIQUE INDEX "whish_transfers_reference_key" ON "whish_transfers" ("reference");
CREATE UNIQUE INDEX "whish_transfers_withdrawal_id_key" ON "whish_transfers" ("withdrawal_id");
CREATE INDEX "whish_transfers_status_created_at_idx" ON "whish_transfers" ("status", "created_at");
CREATE INDEX "whish_transfers_recipient_phone_created_at_idx" ON "whish_transfers" ("recipient_phone", "created_at");
CREATE INDEX "whish_transfers_created_at_idx" ON "whish_transfers" ("created_at");

ALTER TABLE "whish_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whish_transfers" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whish_transfers_admin_only" ON "whish_transfers"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());

GRANT SELECT, INSERT, UPDATE, DELETE ON "whish_transfers" TO txn_app_rls;

-- ----- 4. whish_session_credentials (single row) -----
CREATE TABLE "whish_session_credentials" (
  "id"                   TEXT                        NOT NULL DEFAULT 'default',
  "enc_token"            TEXT                        NOT NULL,
  "enc_uid"              TEXT                        NOT NULL,
  "enc_session_id"       TEXT                        NOT NULL,
  "device_id"            TEXT                        NOT NULL,
  "server_id"            TEXT                        NOT NULL,
  "itel_version"         TEXT                        NOT NULL,
  "os_version"           TEXT                        NOT NULL,
  "operating_system"     TEXT                        NOT NULL,
  "user_agent"           TEXT                        NOT NULL,
  "session_counter"      INTEGER                     NOT NULL DEFAULT 0,
  "last_rotated_at"      TIMESTAMP(6) WITH TIME ZONE,
  "last_auth_failure_at" TIMESTAMP(6) WITH TIME ZONE,
  "updated_at"           TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "whish_session_credentials_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whish_session_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whish_session_credentials" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whish_session_credentials_admin_only" ON "whish_session_credentials"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());

GRANT SELECT, INSERT, UPDATE, DELETE ON "whish_session_credentials" TO txn_app_rls;
