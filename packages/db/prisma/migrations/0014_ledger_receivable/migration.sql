-- =================================================================
-- 0014_ledger_receivable
--
-- Adds a RECEIVABLE ledger account: a debt owed by the company to the
-- platform. Used when a transaction reversal cannot be fully covered by
-- the company's available balance (the funds were already withdrawn) — the
-- uncovered remainder is booked to RECEIVABLE so the reversal is always
-- recordable and the ledger stays balanced, instead of throwing and leaving
-- the bad credit on the books forever.
--
-- RECEIVABLE has no wallet projection (like FEE/EXTERNAL), so wallets stay
-- >= 0 and the ledger↔wallet reconciliation invariant is unaffected.
--
-- No new tables → existing RLS policies + grants (0002, 0003) already apply.
-- =================================================================

-- AlterEnum
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'RECEIVABLE';
