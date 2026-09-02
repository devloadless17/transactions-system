import { Logger } from '@nestjs/common';
import type { AuditChanges } from '@app/shared';
import type { AuthenticatedRequest } from '../../common/types/request.types';

const logger = new Logger('AuditChanges');

/** Bounds an audit row's size — a diff is a summary, not a payload dump. */
const MAX_FIELDS = 20;
const MAX_STRING = 200;

/**
 * Belt-and-braces denylist. The type system already restricts a change to JSON
 * scalars and every producer must pass an explicit field allowlist, so nothing
 * should ever match this — it exists because the cost of one careless adopter
 * is credentials written into a table ADMIN_OPERATOR can read.
 */
const SENSITIVE = /pass|secret|token|key|hash|otp|pin|cvv|auth/i;

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Diff a patch against the row it will be applied to, restricted to `fields`.
 *
 * A field is included only when the patch actually defines it AND the value
 * genuinely differs, so a no-op PATCH produces `{}` and the audit row gets no
 * `changes` key at all rather than an empty one.
 *
 * There is deliberately NO "diff everything" mode: the allowlist is the primary
 * defence against a future caller diffing an entity row that carries secrets
 * alongside the fields worth auditing.
 */
export function diffFields<T extends object>(
  before: T,
  patch: Partial<T>,
  fields: ReadonlyArray<keyof T & string>,
): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of fields) {
    const next = patch[field];
    if (next === undefined) continue;
    const prev = before[field];
    if (prev === next) continue;
    if (!isScalar(prev) || !isScalar(next)) {
      // A non-scalar slipped past the allowlist — drop it rather than serialize
      // an unknown shape into the audit row.
      logger.warn(`skipping non-scalar audit field '${field}'`);
      continue;
    }
    changes[field] = { from: prev, to: next };
  }
  return changes;
}

/**
 * Publish a diff for the current request, for AuditInterceptor to merge.
 *
 * Merges rather than replaces, so two services handling one request can each
 * contribute. Call this only AFTER the write has committed — an interactive
 * transaction can still roll back, and an audit row describing a change that
 * never landed is worse than no row at all.
 */
export function recordAuditChanges(req: AuthenticatedRequest, changes: AuditChanges): void {
  const bag = (req.auditChanges ??= {});
  for (const [field, change] of Object.entries(changes)) {
    if (SENSITIVE.test(field)) {
      logger.warn(`refusing to audit sensitive field '${field}'`);
      continue;
    }
    if (Object.keys(bag).length >= MAX_FIELDS && !(field in bag)) continue;
    bag[field] = { from: truncate(change.from), to: truncate(change.to) };
  }
}

function truncate(value: Scalar): Scalar {
  if (typeof value !== 'string' || value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…`;
}
