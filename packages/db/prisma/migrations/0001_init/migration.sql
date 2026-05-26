-- ============================================================
-- 0001_init — Initial schema
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------- Enums --------------------------
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN_OPERATOR', 'COMPANY_OWNER', 'COMPANY_MANAGER', 'COMPANY_VIEWER');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'PENDING');
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "CommissionType" AS ENUM ('FIXED', 'PERCENTAGE');
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED', 'REFUNDED');
CREATE TYPE "LedgerAccountType" AS ENUM ('AVAILABLE', 'PENDING', 'RESERVED', 'FEE', 'EXTERNAL');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'RETRYING');

-- ------------------------- Companies ----------------------
CREATE TABLE "companies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
  "default_currency" CHAR(3) NOT NULL,
  "webhook_url" TEXT,
  "webhook_secret" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");
CREATE INDEX "companies_status_idx" ON "companies"("status");

-- --------------------------- Users ------------------------
CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" CITEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "company_id" UUID,
  "last_login_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_company_id_idx" ON "users"("company_id");
CREATE INDEX "users_role_idx" ON "users"("role");

-- ----------------------- Refresh tokens -------------------
CREATE TABLE "refresh_tokens" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_agent" TEXT,
  "ip_address" TEXT,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- --------------------------- Sources ----------------------
CREATE TABLE "sources" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "sources_code_key" ON "sources"("code");

-- --------------------------- API Keys ---------------------
CREATE TABLE "api_keys" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "last_used_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "api_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "api_keys_company_id_name_key" ON "api_keys"("company_id", "name");
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");
CREATE INDEX "api_keys_company_id_idx" ON "api_keys"("company_id");

-- --------------------- Commission rules -------------------
CREATE TABLE "commission_rules" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID,
  "source_id" UUID,
  "min_amount" DECIMAL(20, 8) NOT NULL,
  "max_amount" DECIMAL(20, 8) NOT NULL,
  "commission_type" "CommissionType" NOT NULL,
  "commission_value" DECIMAL(20, 8) NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "commission_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_rules_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE,
  CONSTRAINT "commission_rules_amount_range_chk" CHECK ("min_amount" <= "max_amount"),
  CONSTRAINT "commission_rules_value_nonneg_chk" CHECK ("commission_value" >= 0)
);
CREATE INDEX "commission_rules_company_source_active_priority_idx"
  ON "commission_rules"("company_id", "source_id", "active", "priority");

-- ------------------------ Transactions --------------------
CREATE TABLE "transactions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "external_transaction_id" TEXT NOT NULL,
  "amount" DECIMAL(20, 8) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "commission_amount" DECIMAL(20, 8) NOT NULL,
  "net_amount" DECIMAL(20, 8) NOT NULL,
  "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL,
  "idempotency_key" TEXT,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT,
  CONSTRAINT "transactions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "transactions_amount_pos_chk" CHECK ("amount" > 0),
  CONSTRAINT "transactions_commission_nonneg_chk" CHECK ("commission_amount" >= 0)
);
CREATE UNIQUE INDEX "transactions_source_external_unique"
  ON "transactions"("source_id", "external_transaction_id");
CREATE UNIQUE INDEX "transactions_company_idempotency_unique"
  ON "transactions"("company_id", "idempotency_key");
CREATE INDEX "transactions_company_created_idx"
  ON "transactions"("company_id", "created_at");
CREATE INDEX "transactions_company_status_idx"
  ON "transactions"("company_id", "status");

-- --------------------------- Wallets ----------------------
CREATE TABLE "wallets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "available_balance" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "pending_balance" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "reserved_balance" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "wallets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE,
  CONSTRAINT "wallets_available_nonneg_chk" CHECK ("available_balance" >= 0),
  CONSTRAINT "wallets_pending_nonneg_chk"   CHECK ("pending_balance"   >= 0),
  CONSTRAINT "wallets_reserved_nonneg_chk"  CHECK ("reserved_balance"  >= 0)
);
CREATE UNIQUE INDEX "wallets_company_currency_unique" ON "wallets"("company_id", "currency");

-- ------------------------ Withdrawals ---------------------
CREATE TABLE "withdrawals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "amount" DECIMAL(20, 8) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" UUID NOT NULL,
  "approved_by_id" UUID,
  "notes" TEXT,
  "metadata" JSONB,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "withdrawals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT,
  CONSTRAINT "withdrawals_requested_by_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "withdrawals_approved_by_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "withdrawals_amount_pos_chk" CHECK ("amount" > 0)
);
CREATE INDEX "withdrawals_company_status_idx" ON "withdrawals"("company_id", "status");
CREATE INDEX "withdrawals_company_created_idx" ON "withdrawals"("company_id", "created_at");

-- ------------------------ Ledger Entries -------------------
CREATE TABLE "ledger_entries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "transaction_id" UUID,
  "withdrawal_id" UUID,
  "account_type" "LedgerAccountType" NOT NULL,
  "direction" "LedgerDirection" NOT NULL,
  "amount" DECIMAL(20, 8) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ledger_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entries_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE RESTRICT,
  CONSTRAINT "ledger_entries_amount_pos_chk" CHECK ("amount" > 0)
);
CREATE INDEX "ledger_entries_company_currency_created_idx"
  ON "ledger_entries"("company_id", "currency", "created_at");
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");
CREATE INDEX "ledger_entries_withdrawal_id_idx" ON "ledger_entries"("withdrawal_id");

-- -------------------------- Audit Logs --------------------
CREATE TABLE "audit_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" UUID,
  "company_id" UUID,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "metadata" JSONB,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL
);
CREATE INDEX "audit_logs_company_created_idx" ON "audit_logs"("company_id", "created_at");
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs"("entity_type", "entity_id");

-- ---------------------- Webhook Deliveries ----------------
CREATE TABLE "webhook_deliveries" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "target_url" TEXT NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "response_status" INTEGER,
  "response_body" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ(6),
  "next_retry_at" TIMESTAMPTZ(6),
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "webhook_deliveries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE INDEX "webhook_deliveries_company_created_idx" ON "webhook_deliveries"("company_id", "created_at");
CREATE INDEX "webhook_deliveries_status_next_retry_idx" ON "webhook_deliveries"("status", "next_retry_at");

-- ---------------------- Idempotency Keys ------------------
CREATE TABLE "idempotency_keys" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_snapshot" JSONB,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "idempotency_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "idempotency_keys_company_key_unique" ON "idempotency_keys"("company_id", "key");
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");
