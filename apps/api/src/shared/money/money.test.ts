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
});
