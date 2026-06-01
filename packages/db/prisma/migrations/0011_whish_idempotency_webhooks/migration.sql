-- =================================================================
-- 0011_whish_idempotency_webhooks
--
-- 1. Create-idempotency for Whish payments: an optional client key so a
--    retried "create link" call returns the same payment instead of
--    minting a duplicate. Unique per (company, key); NULLs are allowed
--    and distinct, so unkeyed creates are unaffected.
-- 2. Per-company outbound webhook config: where to POST payment events
--    and the secret used to HMAC-sign the payload.
-- =================================================================

-- Idempotent: some environments already carried the company webhook columns.
-- 1. Whish create-idempotency
ALTER TABLE "whish_payments" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "whish_payments_company_idempotency_key"
  ON "whish_payments" ("company_id", "idempotency_key");

-- 2. Company webhook config
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "webhook_url"    TEXT;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "webhook_secret" TEXT;
