-- ============================================================
-- 20260619130000_refresh_token_rotated_at
--
-- Distinguishes a refresh token revoked by benign ROTATION (a refresh minted a
-- successor) from one revoked by a SECURITY action (logout / password change /
-- admin reset / reuse-detection). AuthService.refresh()'s rotation grace window
-- re-issues ONLY for recently-rotated tokens, so a deliberately-killed session
-- can never be resurrected within the grace window. Benign rotation sets
-- rotated_at; security revocations leave it null.
--
-- Additive + nullable; no backfill needed (existing revoked rows are treated as
-- security revocations, which is the safe/fail-closed default).
-- ============================================================

ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_at" timestamptz(6);
