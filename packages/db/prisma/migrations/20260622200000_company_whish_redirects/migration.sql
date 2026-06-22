-- ============================================================
-- 20260622200000_company_whish_redirects
--
-- Per-company default redirect URLs for Whish collect links: where the PAYER's
-- browser is sent after a successful / failed payment. Previously hardcoded to
-- the platform's own /pay/success and /pay/failure pages; companies can now point
-- payers at their OWN pages. A per-link override is also supported (passed in the
-- create-payment request) — these columns are the company's default when no
-- override is given. NULL falls back to the platform pages.
--
-- IMPORTANT: this only affects the customer-facing REDIRECT URLs. The
-- server-to-server success/failure CALLBACK URLs (which carry the settlement
-- token + externalId) stay platform-controlled and are unaffected.
--
-- Additive: two nullable columns on an existing table. No data change, no RLS
-- change (companies is already tenant-scoped under RLS).
-- ============================================================

ALTER TABLE "companies" ADD COLUMN "whish_success_redirect_url" TEXT;
ALTER TABLE "companies" ADD COLUMN "whish_failure_redirect_url" TEXT;
