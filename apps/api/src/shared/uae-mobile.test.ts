import { mobileComparisonKey, normalizeUaeMobile } from "./uae-mobile.js";

describe("mobileComparisonKey", () => {
  it("folds equivalent UAE forms of the same number onto one key", () => {
    const canonical = mobileComparisonKey("971506468442");
    expect(canonical).toBe("971506468442");
    for (const equivalent of [
      "0506468442",
      "971506468442",
      "+971 50 646 8442",
      "+971506468442",
      "050 646 8442",
      "050-646-8442",
      "5 0646 8442",
    ]) {
      expect(mobileComparisonKey(equivalent)).toBe(canonical);
    }
  });

  it("does not collide distinct international numbers", () => {
    const uae = mobileComparisonKey("0506468442");
    const uk = mobileComparisonKey("+44 7700 900123");
    const jordan = mobileComparisonKey("00962 79 123 4567");
    expect(new Set([uae, uk, jordan]).size).toBe(3);
    expect(uk).toBe("447700900123");
    expect(jordan).toBe("00962791234567");
  });

  it("returns an empty key for input without digits (guarded by callers)", () => {
    expect(mobileComparisonKey("no-digits")).toBe("");
    expect(mobileComparisonKey("")).toBe("");
    expect(mobileComparisonKey(null)).toBe("");
    expect(mobileComparisonKey(undefined)).toBe("");
  });

  it("is unrelated to storage — normalizeUaeMobile still only recognizes UAE forms", () => {
    // Comparison folds to a key; storage preserves the entered text. The two are
    // independent, so a non-UAE number has a key but no canonical UAE form.
    expect(normalizeUaeMobile("+44 7700 900123")).toBeUndefined();
    expect(mobileComparisonKey("+44 7700 900123")).toBe("447700900123");
  });
});
