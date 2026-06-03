-- ============================================================
-- cleanup-test-data.sql
--
-- Removes all test/fake data while preserving structural seeds:
--   - SUPER_ADMIN user(s)
--   - sources catalog (omt, bank_transfer, crypto_gateway, ...)
--   - global commission_rules (where company_id IS NULL)
--
-- Run with: PGPASSWORD=... psql <DATABASE_MIGRATIONS_URL> -f cleanup-test-data.sql
-- ============================================================

BEGIN;
SET LOCAL app.bypass_rls = 'on';

-- The ledger and audit_logs tables have BEFORE DELETE/UPDATE triggers
-- that reject row removal (migration 0002). We disable session_replication_role
-- so triggers don't fire for this cleanup. Restored at the end.
SET session_replication_role = replica;

-- Order matters because of FKs. Innermost children first.

-- Ledger entries (children of transactions, withdrawals, companies)
DELETE FROM ledger_entries;

-- Transactions
DELETE FROM transactions;

-- Withdrawals (children of users + companies)
DELETE FROM withdrawals;

-- Wallets
DELETE FROM wallets;

-- API keys
DELETE FROM api_keys;

-- Refresh tokens (children of users) — wipe all sessions so everyone re-logs in cleanly
DELETE FROM refresh_tokens;

-- Audit logs — note we leave the table truncated so the new state is a clean slate
DELETE FROM audit_logs;

-- Company-scoped commission rules. Keep the global ones (company_id IS NULL).
DELETE FROM commission_rules WHERE company_id IS NOT NULL;

-- Non-admin users (company owners, managers, viewers from test runs)
DELETE FROM users WHERE role <> 'SUPER_ADMIN';

-- Companies last
DELETE FROM companies;

-- Restore the triggers immediately
SET session_replication_role = DEFAULT;

COMMIT;

-- Show what's left so the operator can sanity-check
SELECT 'companies'         AS t, COUNT(*) FROM companies
UNION ALL SELECT 'users (admin)',     COUNT(*) FROM users WHERE role  = 'SUPER_ADMIN'
UNION ALL SELECT 'users (non-admin)', COUNT(*) FROM users WHERE role != 'SUPER_ADMIN'
UNION ALL SELECT 'api_keys',          COUNT(*) FROM api_keys
UNION ALL SELECT 'transactions',      COUNT(*) FROM transactions
UNION ALL SELECT 'wallets',           COUNT(*) FROM wallets
UNION ALL SELECT 'ledger_entries',    COUNT(*) FROM ledger_entries
UNION ALL SELECT 'withdrawals',       COUNT(*) FROM withdrawals
UNION ALL SELECT 'audit_logs',        COUNT(*) FROM audit_logs
UNION ALL SELECT 'refresh_tokens',    COUNT(*) FROM refresh_tokens
UNION ALL SELECT 'sources (kept)',    COUNT(*) FROM sources
UNION ALL SELECT 'commission_rules (global, kept)',  COUNT(*) FROM commission_rules WHERE company_id IS NULL
UNION ALL SELECT 'commission_rules (company-scoped)',COUNT(*) FROM commission_rules WHERE company_id IS NOT NULL
ORDER BY t;
