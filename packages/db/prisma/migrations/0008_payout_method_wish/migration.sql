-- Add WISH (Whish Money) as a payout method for withdrawals.
-- Withdraw flow no longer offers bank transfer; the operator pays the
-- third party via Whish Money, cash handover, or crypto.

ALTER TYPE "PayoutMethod" ADD VALUE 'WISH';
