import { Decimal } from "decimal.js";

const maximumAbsoluteAmount = new Decimal("10000000000000000");

export class Money {
  private constructor(private readonly value: Decimal) {}

  public static from(value: string): Money {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) {
      throw new Error("Money must be a finite decimal value");
    }
    const rounded = parsed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (rounded.abs().greaterThanOrEqualTo(maximumAbsoluteAmount)) {
      throw new Error("Money exceeds PostgreSQL NUMERIC(18,2) range");
    }
    return new Money(rounded.isZero() ? new Decimal(0) : rounded);
  }

  public add(other: Money): Money {
    return Money.from(this.value.add(other.value).toFixed(2));
  }

  public subtract(other: Money): Money {
    return Money.from(this.value.sub(other.value).toFixed(2));
  }

  public equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  public toString(): string {
    return this.value.toFixed(2);
  }
}
