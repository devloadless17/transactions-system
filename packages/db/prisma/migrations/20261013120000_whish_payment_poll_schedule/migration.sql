-- =================================================================
-- 20261013120000_whish_payment_poll_schedule
--
-- When the reconciliation poller should next ask Whish about a PENDING link.
--
-- The poller is the backstop for Whish payments: Whish only calls us back on a
-- SUCCESS, so a failed or abandoned link reaches the company's CRM only when
-- the poller asks Whish, and a success whose callback was lost is booked the
-- same way. It used to pick the OLDEST pending links, 250 a minute. A link
-- Whish never resolves stays PENDING for 24 hours, so once 250 of those piled
-- up (a few hours at a big company's volume) they took every slot, every
-- minute, and no newer link was ever checked again.
--
-- next_poll_at turns that into a schedule: a link is due when its time comes,
-- the earliest-due first, and each poll sets the next one by the link's age —
-- every minute while it is young (when nearly every link is paid or failed),
-- then less and less often. NULL means "never polled": due once the link is
-- a minute old, which is exactly the old rule, so rows written by the previous
-- API version during a deploy are polled as before.
--
-- Additive and catalog-only: a nullable column with no default (no rewrite).
-- The previous API version never reads or writes it, so it keeps working while
-- this runs, and a rollback simply ignores it.
--
-- The index covers PENDING links only — production has never had more than a
-- handful at once — so it stays tiny however large the table grows. A plain
-- CREATE INDEX reads the table once under a SHARE lock (writes wait for it);
-- whish_payments is small, so that is a blink. On a large table build it
-- CONCURRENTLY out-of-band first (the IF NOT EXISTS below then no-ops):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "whish_payments_pending_poll_idx"
--     ON "whish_payments" ((COALESCE("next_poll_at", "created_at")))
--     WHERE "status" = 'PENDING';
-- One table, so this file cannot deadlock against live traffic
-- (migration-lock-safety.spec.ts).
-- =================================================================

ALTER TABLE "whish_payments" ADD COLUMN IF NOT EXISTS "next_poll_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "whish_payments_pending_poll_idx"
  ON "whish_payments" ((COALESCE("next_poll_at", "created_at")))
  WHERE "status" = 'PENDING';
