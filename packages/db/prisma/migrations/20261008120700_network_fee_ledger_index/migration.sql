-- =================================================================
-- 20261008120700_network_fee_ledger_index
--
-- Network-fee revenue = SUM over the NETWORK_FEE ledger account by currency +
-- created_at range (analytics.service.ts, platform-analytics.service.ts) — the
-- twin of the FEE revenue sum, which has had its own partial index since 0023
-- (ledger_entries_fee_currency_created_idx). Without this twin every dashboard
-- recompute walks the ledger rows of its whole window, and the all-time view the
-- whole ledger, to add up network fees — even while no company is charged one.
--
-- Partial on account_type = 'NETWORK_FEE', so it holds only network-fee legs:
-- EMPTY when this ships, and it grows only with network-fee revenue.
--
-- Its own file (after 20261008120000): Postgres refuses to USE an enum value
-- inside the transaction that added it.
--
-- NOTE: a plain CREATE INDEX reads the table once while holding a SHARE lock
-- (ledger writes wait for it). The ledger is small enough today for that to be
-- a blink; on an already-large ledger build it CONCURRENTLY out-of-band first
-- (the IF NOT EXISTS below then no-ops on deploy). See docs/DEPLOYMENT.md →
-- "Scaling & operational notes". Out-of-band command:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ledger_entries_network_fee_currency_created_idx"
--     ON "ledger_entries" ("currency", "created_at")
--     WHERE "account_type" = 'NETWORK_FEE';
-- =================================================================

CREATE INDEX IF NOT EXISTS "ledger_entries_network_fee_currency_created_idx"
  ON "ledger_entries" ("currency", "created_at")
  WHERE "account_type" = 'NETWORK_FEE';
