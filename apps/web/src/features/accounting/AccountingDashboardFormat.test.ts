import { describe, expect, it } from "vitest";

import { formatAed, isNegativeAmount } from "./AccountingDashboardPage.js";

/**
 * Amount presentation on the Accounting Dashboard.
 *
 * The redesign required `AED 30,000.00` where the page had been printing the
 * raw `30000.00`. That is a formatting change on a MONEY value, so the risk it
 * carries is not visual: a formatter that rounds, truncates or re-parses would
 * silently misstate a balance.
 *
 * These tests pin the property that makes the change safe -- every digit the
 * server sent survives, in order, with the same number of decimal places.
 */
describe("formatAed", () => {
  it("groups thousands and prefixes the currency", () => {
    expect(formatAed("30000.00")).toBe("AED 30,000.00");
  });

  it("keeps the sign in front of the digits", () => {
    expect(formatAed("-325.00")).toBe("AED -325.00");
  });

  it("leaves a zero balance as a zero balance", () => {
    expect(formatAed("0.00")).toBe("AED 0.00");
  });

  it("does not round, truncate or re-scale", () => {
    // A float round-trip is exactly what these cases would expose.
    expect(formatAed("0.01")).toBe("AED 0.01");
    expect(formatAed("1234567.89")).toBe("AED 1,234,567.89");
    expect(formatAed("9007199254740993.75")).toBe("AED 9,007,199,254,740,993.75");
    expect(formatAed("100.10")).toBe("AED 100.10");
  });

  it("preserves trailing decimal zeros rather than normalising them", () => {
    expect(formatAed("5.50")).toBe("AED 5.50");
    expect(formatAed("5.5")).toBe("AED 5.5");
  });

  it("groups only the integer part", () => {
    expect(formatAed("1000.1234")).toBe("AED 1,000.1234");
  });

  it("passes through a value that is not a plain decimal untouched", () => {
    // Better to show the server's own answer than to mangle an unexpected one.
    expect(formatAed("n/a")).toBe("n/a");
    expect(formatAed("")).toBe("");
  });
});

describe("isNegativeAmount", () => {
  it("detects a negative balance", () => {
    expect(isNegativeAmount("-325.00")).toBe(true);
  });

  it("treats zero and positive values as not negative", () => {
    expect(isNegativeAmount("0.00")).toBe(false);
    expect(isNegativeAmount("325.00")).toBe(false);
  });
});
