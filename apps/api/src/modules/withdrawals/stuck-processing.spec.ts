import { describe, expect, it } from 'vitest';
import { isStuckProcessing, processingSince, STUCK_PROCESSING_AFTER_MS } from './stuck-processing';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (over: {
  status?: string;
  autoApproval?: Record<string, unknown>;
  updatedAt?: Date;
}) => ({
  status: over.status ?? 'PROCESSING',
  metadata: over.autoApproval ? { autoApproval: over.autoApproval } : null,
  updatedAt: over.updatedAt ?? NOW,
});

describe('isStuckProcessing — money held that a person must look at', () => {
  it('an unknown transfer outcome (needsReconcile) is stuck at once', () => {
    const r = row({
      autoApproval: { status: 'UNKNOWN', needsReconcile: true, attemptedAt: NOW.toISOString() },
    });
    expect(isStuckProcessing(r, NOW)).toBe(true);
  });

  it('a transfer in flight is not stuck (PROCESSING is normally seconds long)', () => {
    const r = row({ autoApproval: { attemptedAt: ago(30_000).toISOString() } });
    expect(isStuckProcessing(r, NOW)).toBe(false);
  });

  it('anything still PROCESSING after the limit is stuck (a settle that keeps failing, a crash)', () => {
    const settling = row({
      autoApproval: {
        needsAttention: true,
        attemptedAt: ago(STUCK_PROCESSING_AFTER_MS).toISOString(),
      },
    });
    expect(isStuckProcessing(settling, NOW)).toBe(true);
    const justUnder = row({
      autoApproval: { attemptedAt: ago(STUCK_PROCESSING_AFTER_MS - 1).toISOString() },
    });
    expect(isStuckProcessing(justUnder, NOW)).toBe(false);
  });

  it('measures from the attempt, not the last metadata write', () => {
    // A settle retry rewrites metadata (updatedAt moves) — the attempt time does not.
    const r = row({
      autoApproval: { needsAttention: true, attemptedAt: ago(10 * 60_000).toISOString() },
      updatedAt: NOW,
    });
    expect(isStuckProcessing(r, NOW)).toBe(true);
  });

  it('without an attempt time it falls back to updatedAt', () => {
    expect(processingSince(row({ updatedAt: ago(1_000) }))).toEqual(ago(1_000));
    expect(isStuckProcessing(row({ updatedAt: ago(STUCK_PROCESSING_AFTER_MS) }), NOW)).toBe(true);
    expect(
      isStuckProcessing(row({ autoApproval: { attemptedAt: 'not a date' }, updatedAt: NOW }), NOW),
    ).toBe(false);
  });

  it('only PROCESSING rows can be stuck', () => {
    for (const status of ['PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED']) {
      const r = row({ status, autoApproval: { needsReconcile: true }, updatedAt: ago(86_400_000) });
      expect(isStuckProcessing(r, NOW)).toBe(false);
    }
  });
});
