-- =================================================================
-- 20260622170000_notification_dismiss
--
-- Per-user "clear" (dismiss) for notifications. A dismissed notification is
-- hidden from the user's active bell + list but kept for review under the
-- "Cleared" filter. Read state and dismissal are both per-user, tracked on the
-- existing notification_reads row.
-- =================================================================

ALTER TABLE "notification_reads"
  ADD COLUMN IF NOT EXISTS "dismissed_at" TIMESTAMP(6) WITH TIME ZONE;
