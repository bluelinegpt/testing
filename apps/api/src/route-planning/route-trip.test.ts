import { describe, expect, it } from "vitest";

import { sumMoney, tripStatusKey } from "./route-planning.service.js";

describe("sumMoney", () => {
  it("adds money strings exactly", () => {
    expect(sumMoney(["120.00", "120.00"])).toBe("240.00");
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(sumMoney(["15", "2.5"])).toBe("17.50");
  });

  it("skips missing values and handles none", () => {
    expect(sumMoney([null, "", "30.00"])).toBe("30.00");
    expect(sumMoney([])).toBe("0.00");
  });

  it("handles a negative value", () => {
    expect(sumMoney(["10.00", "-12.50"])).toBe("-2.50");
  });
});

describe("tripStatusKey", () => {
  it("is stable for the same trip and Order, and differs per Order", () => {
    const first = tripStatusKey("trip-key-123456", "order-a");
    expect(tripStatusKey("trip-key-123456", "order-a")).toBe(first);
    expect(tripStatusKey("trip-key-123456", "order-b")).not.toBe(first);
  });

  it("matches the Order status change key format", () => {
    expect(tripStatusKey("k".repeat(200), "order-a")).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  });
});
