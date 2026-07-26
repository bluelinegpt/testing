import { describe, expect, it } from "vitest";

import { formatCurrency, formatDate, formatNumber } from "./formatters.js";

describe("localized formatters", () => {
  it("formats dates in English and Arabic using the UAE time zone", () => {
    const date = "2026-07-13T21:30:00.000Z";

    expect(formatDate(date, "en")).toContain("2026");
    expect(formatDate(date, "ar")).not.toBe(formatDate(date, "en"));
  });

  it("formats finite operational counts", () => {
    expect(formatNumber(5000, "en")).toBe("5,000");
    expect(() => formatNumber(Number.POSITIVE_INFINITY, "en")).toThrow(RangeError);
  });

  it("formats currency from a decimal string without floating-point conversion", () => {
    expect(formatCurrency("1234567.8", "aed", "en")).toContain("1,234,567.80");
    expect(formatCurrency("1234567.8", "aed", "en")).toContain("AED");
    expect(formatCurrency("42", "AED", "ar")).toContain("AED");
    expect(formatCurrency("-42.50", "AED", "en")).toMatch(/^-.*42\.50$/u);
    expect(() => formatCurrency("1.999", "AED", "en")).toThrow(RangeError);
  });
});
