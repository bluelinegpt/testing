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

  /**
   * The reported defect: create-order's COD amount defaults to "0.00". The
   * operator clicks in, the cursor lands right after the leading "0", and the
   * first digit they type produces "05.00" for one render -- a value a
   * native `<input type="number">` accepts without complaint. Screens that
   * echo the field straight back through formatCurrency (order totals,
   * settlement previews) used to throw on that interim string and take the
   * whole workflow screen down with them.
   */
  it("tolerates a leading zero picked up mid-edit instead of throwing", () => {
    expect(formatCurrency("05.00", "AED", "en")).toContain("5.00");
    expect(formatCurrency("00.50", "AED", "en")).toContain("0.50");
    expect(formatCurrency("-05.00", "AED", "en")).toMatch(/^-.*5\.00$/u);
    expect(formatCurrency("0", "AED", "en")).toContain("0.00");
  });
});
