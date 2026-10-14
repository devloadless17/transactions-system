/**
 * When is a withdrawal in PROCESSING "stuck" — money held that a person must
 * look at? PROCESSING is normally seconds long: auto-approval claims the row,
 * sends the Whish transfer, and settles or reverts it. It stays there only when
 * that did not finish:
 *
 * - needsReconcile: the transfer's outcome is unknown (Whish timed out, or an
 *   error after the call). Auto-approval never touches it again, so it is stuck
 *   from the moment it is flagged.
 * - anything else still PROCESSING after STUCK_PROCESSING_AFTER_MS — a settle
 *   that keeps failing (needsAttention), or a crash mid-transfer.
 *
 * Measured from `autoApproval.attemptedAt` (stamped when the row entered
 * PROCESSING), falling back to the row's `updatedAt`.
 */
export const STUCK_PROCESSING_AFTER_MS = 5 * 60_000;

export interface ProcessingRow {
  status: string;
  metadata: unknown;
  updatedAt: Date;
}

function autoApproval(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const a = (metadata as Record<string, unknown>).autoApproval;
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
}

/** When the row entered PROCESSING (auto-approval's attempt), else its last update. */
export function processingSince(row: ProcessingRow): Date {
  const at = autoApproval(row.metadata)?.attemptedAt;
  if (typeof at === 'string') {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return row.updatedAt;
}

export function isStuckProcessing(row: ProcessingRow, now: Date = new Date()): boolean {
  if (row.status !== 'PROCESSING') return false;
  if (autoApproval(row.metadata)?.needsReconcile === true) return true;
  return now.getTime() - processingSince(row).getTime() >= STUCK_PROCESSING_AFTER_MS;
}
