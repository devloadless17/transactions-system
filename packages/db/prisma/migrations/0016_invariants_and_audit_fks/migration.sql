-- =================================================================
-- 0016_invariants_and_audit_fks
--
-- 1. DB-level financial invariants (last line of defence for money math):
--    - ledger_entries must reference EXACTLY ONE origin (transaction / withdrawal
--      / payout / load) — no orphans, no double-linked rows.
--    - transactions.net_amount must be >= 0 (a negative credit is never valid).
-- 2. audit_logs FK on-delete: SET NULL -> RESTRICT. audit_logs is append-only
--    (a BEFORE UPDATE/DELETE trigger rejects mutation), so the SET NULL that
--    fired when a referenced user/company was deleted would throw a cryptic
--    immutability error. Entities with audit history are disabled, not deleted;
--    RESTRICT makes that explicit and keeps the trail intact.
--
-- Pre-verified against live data: all ledger rows already have exactly one
-- origin and min(net_amount) = 0, so both CHECKs validate cleanly.
-- =================================================================

-- 1. Invariants
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_one_origin_chk" CHECK (
    ( (CASE WHEN "transaction_id" IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "withdrawal_id"  IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "payout_id"      IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "load_id"        IS NOT NULL THEN 1 ELSE 0 END) ) = 1
  );

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_net_nonneg_chk" CHECK ("net_amount" >= 0);

-- 2. audit_logs FKs: SET NULL -> RESTRICT
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_id_fkey";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_company_id_fkey";
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
