-- =================================================================
-- 20261008120000_network_fee_ledger_account
--
-- Adds the NETWORK_FEE ledger account: platform revenue from the optional
-- per-company network fee (a second fee charged next to the commission).
-- It is booked APART from FEE so every FEE-based figure keeps its meaning —
-- platform fee revenue, a company's fee totals, and true commission
-- (FEE − Σ rounding_remainder) — and so a company can tell the two fees apart
-- in its ledger and ledger CSV.
--
-- No wallet projection (like FEE/EXTERNAL/RECEIVABLE), so the ledger↔wallet
-- reconciliation invariant is unaffected.
--
-- Its own migration: Prisma applies a file as ONE transaction, and Postgres
-- refuses to USE an enum value inside the transaction that added it.
-- Precedent: 0014_ledger_receivable. No new tables → existing RLS + grants apply.
-- =================================================================

-- AlterEnum
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'NETWORK_FEE';
