import Decimal from 'decimal.js';

// Wall everything in fixed precision. The platform money scale is 2 decimal
// places — whole cents. Every supported currency is 2-decimal fiat, the ledger
// books cents, and a sub-cent residue is not representable in a wallet balance
// or on any statement a company reconciles against.
//
// `precision: 30` is INTERMEDIATE precision and is deliberately NOT reduced:
// percent() and div() must stay high-precision so a rate like 0.125% is applied
// exactly. Only the persistence boundary (round / toString) quantizes.
//
// Rounding mode = ROUND_HALF_EVEN (banker's rounding) to avoid systematic
// upward bias across many transactions.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export const MONEY_SCALE = 2;

/** For user-facing messages, so they can never drift from the scale itself. */
export const MONEY_SCALE_LABEL = `${MONEY_SCALE} decimal places`;

export type MoneyInput = string | number | Decimal;

export class Money {
  readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  static of(input: MoneyInput): Money {
    return new Money(new Decimal(input));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  add(other: Money): Money {
    return new Money(this.value.plus(other.value));
  }

  sub(other: Money): Money {
    return new Money(this.value.minus(other.value));
  }

  mul(scalar: MoneyInput): Money {
    return new Money(this.value.times(new Decimal(scalar)));
  }

  div(scalar: MoneyInput): Money {
    return new Money(this.value.dividedBy(new Decimal(scalar)));
  }

  /** Apply a percentage (e.g. `percent("2.5")` = 2.5%). */
  percent(pct: MoneyInput): Money {
    return new Money(this.value.times(new Decimal(pct)).dividedBy(100));
  }

  cmp(other: Money): -1 | 0 | 1 {
    return this.value.cmp(other.value) as -1 | 0 | 1;
  }

  eq(other: Money): boolean {
    return this.value.eq(other.value);
  }
  gt(other: Money): boolean {
    return this.value.gt(other.value);
  }
  gte(other: Money): boolean {
    return this.value.gte(other.value);
  }
  lt(other: Money): boolean {
    return this.value.lt(other.value);
  }
  lte(other: Money): boolean {
    return this.value.lte(other.value);
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative();
  }
  isZero(): boolean {
    return this.value.isZero();
  }

  /** Round to the platform money scale. */
  round(): Money {
    return new Money(this.value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN));
  }

  /**
   * True when this value already sits on the platform money scale, i.e. it can be
   * persisted without rounding. The ledger asserts this rather than rounding:
   * rounding each leg independently is how an unbalanced set gets booked, because
   * `round(a) + round(b)` can differ from `round(a + b)`.
   */
  isAtScale(): boolean {
    return this.value.decimalPlaces() <= MONEY_SCALE;
  }

  /**
   * Quantize a value read back out of a Decimal column. THE one place historical
   * over-scale data is collapsed onto the platform scale, so a legacy row can
   * never feed an over-scale amount into a fresh calculation.
   */
  static fromDb(v: { toString(): string } | null | undefined): Money {
    return Money.of(v?.toString() ?? '0').round();
  }

  /**
   * Quantize DOWNWARD. For capping against a balance we must not exceed — half-even
   * could round *up* past what the wallet actually holds and overdraw it.
   */
  floorToScale(): Money {
    return new Money(this.value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN));
  }

  /**
   * Quantize UPWARD. For clearing a debt that has to reach exactly zero — flooring
   * would leave a sub-scale remainder that stays `isPositive()` forever and keeps
   * blocking money-out.
   */
  ceilToScale(): Money {
    return new Money(this.value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_UP));
  }

  /** Round DOWN to a whole unit (e.g. 18.67 → 18, 25.99 → 25). Never rounds up. */
  floorToWhole(): Money {
    return new Money(this.value.floor());
  }

  /** String form at the platform money scale — what we send to the DB. */
  toString(): string {
    return this.round().value.toFixed();
  }

  /**
   * String form with NO rounding — every digit the value actually carries.
   * Only for writing a column whose scale is wider than MONEY_SCALE, where
   * rounding on write would silently truncate legacy precision and diverge that
   * row from the ledger it is a projection of.
   */
  toExactString(): string {
    return this.value.toFixed();
  }

  /** Fixed-decimal display (e.g. 2 dp for USD UI). */
  toFixed(dp = 2): string {
    return this.value.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp);
  }
}

/**
 * A fee priced on an amount: a FIXED fee is its own dollar value, a PERCENTAGE
 * fee is `amount × value %`. Quantized ONCE, here, to the money scale
 * (half-even) — so the API that charges a fee and the dashboard that previews
 * it can never disagree by a cent.
 */
export function feeOnAmount(amount: Money, type: 'FIXED' | 'PERCENTAGE', value: MoneyInput): Money {
  return type === 'FIXED' ? Money.of(value).round() : amount.percent(value).round();
}
