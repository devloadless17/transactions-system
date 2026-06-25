-- =================================================================
-- 20260625120000_withdrawal_auto_approval
--
-- Single-row config for auto-approving Whish (WISH) withdrawals. Like
-- whish_transfers / whish_session_credentials this is PLATFORM-level: the
-- RLS policy allows ONLY app_bypass_rls() (set by runAsAdmin) for read AND
-- write, so no tenant role can ever see/write it.
--
-- Ships disabled: `enabled` defaults false, so creating this table changes
-- nothing — auto-approval only begins when a SUPER_ADMIN flips it on.
-- =================================================================

CREATE TABLE "withdrawal_auto_approval_configs" (
  "id"                         TEXT                        NOT NULL DEFAULT 'default',
  "enabled"                    BOOLEAN                     NOT NULL DEFAULT false,
  "enabled_at"                 TIMESTAMP(6) WITH TIME ZONE,
  "hold_seconds"               INTEGER                     NOT NULL DEFAULT 30,
  "max_auto_approve_amount"    DECIMAL(20, 8)              NOT NULL DEFAULT 500,
  "circuit_breaker_tripped_at" TIMESTAMP(6) WITH TIME ZONE,
  "consecutive_failures"       INTEGER                     NOT NULL DEFAULT 0,
  "failure_threshold"          INTEGER                     NOT NULL DEFAULT 3,
  "updated_at"                 TIMESTAMP(6) WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT "withdrawal_auto_approval_configs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "withdrawal_auto_approval_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_auto_approval_configs" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_auto_approval_configs_admin_only" ON "withdrawal_auto_approval_configs"
  USING      (app_bypass_rls())
  WITH CHECK (app_bypass_rls());

GRANT SELECT, INSERT, UPDATE, DELETE ON "withdrawal_auto_approval_configs" TO txn_app_rls;
