import { describe, expect, it } from 'vitest';
import { Prisma } from '@app/db';
import {
  AUTO_APPROVE_CURRENCY,
  AUTO_APPROVE_METHOD,
  AUTO_APPROVE_MIN_NET,
  breakerWouldResume,
  type SessionHealth,
} from './auto-approval-rules';

/**
 * PARITY GUARD for the LIVE auto-approval money path.
 *
 * Auto-approval sends real funds (Whish W2W has no sandbox). Two pieces of the
 * poller were refactored to share code with the Telegram alert predicate:
 *   1. `AutoApprovalConfigStore.maybeAutoResume()` now calls `breakerWouldResume()`
 *   2. `WithdrawalsService.findAutoApprovalCandidates()` now uses the shared constants
 *
 * Neither may change behaviour. These tests re-implement the ORIGINAL logic
 * verbatim and assert the refactor agrees on every input, so a future edit to
 * the shared helper cannot silently alter which withdrawals auto-settle.
 */

/** The exact expression that lived inline in `maybeAutoResume` before the refactor. */
function originalHealthy(
  trippedAt: Date,
  session: { configured: boolean; lastRotatedAt: Date | string | null; lastAuthFailureAt: unknown },
): boolean {
  const rotated = session.lastRotatedAt ? new Date(session.lastRotatedAt) : null;
  return (
    session.configured &&
    session.lastAuthFailureAt === null &&
    rotated !== null &&
    rotated > trippedAt
  );
}

const TRIP = new Date('2026-06-01T10:00:00Z');
const BEFORE = new Date('2026-06-01T09:00:00Z');
const AFTER = new Date('2026-06-01T11:00:00Z');

describe('breakerWouldResume — byte-for-byte parity with the pre-refactor logic', () => {
  // Exhaustive cross-product of every field the decision reads.
  const configureds = [true, false];
  const rotations: Array<Date | string | null> = [
    null,
    BEFORE,
    AFTER,
    TRIP, // exactly equal → NOT strictly greater
    AFTER.toISOString(), // string form, as WhishSessionStatus may serialize it
  ];
  const failures: Array<Date | null> = [null, AFTER];

  for (const configured of configureds) {
    for (const lastRotatedAt of rotations) {
      for (const lastAuthFailureAt of failures) {
        const label = `configured=${configured} rotated=${String(lastRotatedAt)} authFail=${String(lastAuthFailureAt)}`;
        it(`agrees for ${label}`, () => {
          const session = { configured, lastRotatedAt, lastAuthFailureAt } as SessionHealth;
          expect(breakerWouldResume(TRIP, session)).toBe(originalHealthy(TRIP, session));
        });
      }
    }
  }

  it('only resumes on a strictly-later rotation with no auth failure', () => {
    const base = { configured: true, lastAuthFailureAt: null };
    expect(breakerWouldResume(TRIP, { ...base, lastRotatedAt: AFTER })).toBe(true);
    expect(breakerWouldResume(TRIP, { ...base, lastRotatedAt: TRIP })).toBe(false);
    expect(breakerWouldResume(TRIP, { ...base, lastRotatedAt: BEFORE })).toBe(false);
    expect(breakerWouldResume(TRIP, { ...base, lastRotatedAt: null })).toBe(false);
  });
});

describe('candidate-query constants equal the literals they replaced', () => {
  it("payoutMethod is still exactly 'WISH'", () => {
    expect(AUTO_APPROVE_METHOD).toBe('WISH');
  });

  it("currency is still exactly 'USD'", () => {
    expect(AUTO_APPROVE_CURRENCY).toBe('USD');
  });

  // The query changed `new Prisma.Decimal(1)` → `new Prisma.Decimal(AUTO_APPROVE_MIN_NET)`.
  // A string '1' and the number 1 must produce an identical Decimal, or the
  // poller's `netAmount >= 1` floor would shift and change which withdrawals pay out.
  it("min-net Decimal('1') is identical to the old Decimal(1)", () => {
    expect(AUTO_APPROVE_MIN_NET).toBe('1');
    const fromString = new Prisma.Decimal(AUTO_APPROVE_MIN_NET);
    const fromNumber = new Prisma.Decimal(1);
    expect(fromString.equals(fromNumber)).toBe(true);
    expect(fromString.toString()).toBe(fromNumber.toString());
  });
});
