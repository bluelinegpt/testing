import { Money } from "./money.js";

describe("Money", () => {
  it("rounds half-up to two decimal places", () => {
    expect(Money.from("1.005").toString()).toBe("1.01");
    expect(Money.from("1.004").toString()).toBe("1.00");
  });

  it("adds and subtracts without floating-point arithmetic", () => {
    const total = Money.from("250.00").add(Money.from("20.00"));
    expect(total.toString()).toBe("270.00");
    expect(total.subtract(Money.from("20.00")).equals(Money.from("250.00"))).toBe(true);
  });

  it("rejects values outside NUMERIC(18,2)", () => {
    expect(() => Money.from("10000000000000000.00")).toThrow("NUMERIC(18,2)");
  });

  it("multiplies by an integer quantity without floating-point drift", () => {
    expect(Money.from("19.99").multiplyByInteger(3).toString()).toBe("59.97");
    expect(Money.from("0.10").multiplyByInteger(3).toString()).toBe("0.30");
  });

  it("rejects a non-integer or negative multiplier", () => {
    expect(() => Money.from("10.00").multiplyByInteger(1.5)).toThrow("non-negative integer");
    expect(() => Money.from("10.00").multiplyByInteger(-1)).toThrow("non-negative integer");
  });

  it("reports zero", () => {
    expect(Money.from("0.00").isZero()).toBe(true);
    expect(Money.from("0.01").isZero()).toBe(false);
  });
});
