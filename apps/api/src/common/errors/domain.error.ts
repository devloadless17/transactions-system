/**
 * Typed domain errors. Mapped to HTTP by the GlobalExceptionFilter.
 * Services throw these — controllers never construct HTTP errors directly.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', `${entity}${id ? ` ${id}` : ''} not found`, 404, { entity, id });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, 409, details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

/**
 * A ledger leg was handed to the ledger carrying more decimal places than the
 * platform money scale. This is a PROGRAMMING error in a money builder, never
 * user input: the builder is supposed to quantize its inputs once (Money.fromDb)
 * and derive the rest by exact subtraction, so the set balances by construction.
 *
 * Its own class, and a 500, so it stands out in the logs and can be alerted on
 * separately — an occurrence means some flow is one rounding step away from
 * booking an unbalanced set.
 */
export class LedgerScaleError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('LEDGER_SCALE', message, 500, details);
  }
}

/** Per-API-key rate limit exceeded. Mapped to 429 with a clean, flat envelope. */
export class RateLimitError extends DomainError {
  constructor(d: { limit: number; windowSeconds: number }) {
    super(
      'RATE_LIMITED',
      `Rate limit exceeded: ${d.limit} requests per ${d.windowSeconds}s`,
      429,
      d,
    );
  }
}

/**
 * A repeat of a transaction that is NOT the same transaction: its reference (or
 * idempotencyKey) is already recorded, but with a different amount or currency
 * — or the idempotencyKey belongs to a different reference. Answering it as a
 * replay would silently drop the money it carries, so it is refused and nothing
 * is recorded. `details` never carries internal identifiers.
 */
export class TransactionMismatchError extends DomainError {
  constructor(message: string, details: Record<string, unknown>) {
    super('TRANSACTION_MISMATCH', message, 409, details);
  }
}

/**
 * An `externalTransactionId` that is already used for this source (the
 * `(source, externalTransactionId)` pair is globally unique). Distinct from a
 * same-company idempotent replay, which returns the existing transaction.
 */
export class DuplicateTransactionError extends DomainError {
  constructor(externalTransactionId: string) {
    super(
      'DUPLICATE_TRANSACTION',
      `A transaction with externalTransactionId '${externalTransactionId}' already exists for this source.`,
      409,
      { externalTransactionId },
    );
  }
}

/** Not enough available balance to cover a request (amount, or amount+fee). */
export class InsufficientBalanceError extends DomainError {
  constructor(d: { currency: string; required: string; available: string; shortfall: string }) {
    super(
      'INSUFFICIENT_BALANCE',
      `Insufficient ${d.currency} balance: need ${d.required}, have ${d.available}. ` +
        `Top up ${d.shortfall} ${d.currency} and try again.`,
      409,
      d,
    );
  }
}
