import Decimal from 'decimal.js';

// Wall everything in fixed precision. 8 decimal places is enough for
// fiat (2-4) and most crypto (8). Rounding mode = ROUND_HALF_EVEN
// (banker's rounding) to avoid systematic upward bias.
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export const MONEY_SCALE = 8;

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

  /** Round to the platform money scale (8 dp). */
  round(): Money {
    return new Money(this.value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN));
  }

  /** String form with full precision — what we send to the DB. */
  toString(): string {
    return this.round().value.toFixed();
  }

  /** Fixed-decimal display (e.g. 2 dp for USD UI). */
  toFixed(dp = 2): string {
    return this.value.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp);
  }
}

export function clampMoneyToScale(input: MoneyInput): string {
  return Money.of(input).toString();
}
