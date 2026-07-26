import { formatUaeMobile, isUaeMobile, normalizeUaeMobile } from "./uae-mobile.js";

describe("normalizeUaeMobile", () => {
  it("accepts the local form and adds the country code", () => {
    expect(normalizeUaeMobile("0506468442")).toBe("971506468442");
    expect(normalizeUaeMobile("0521234567")).toBe("971521234567");
  });

  it("accepts the international form with and without a plus", () => {
    expect(normalizeUaeMobile("971506468442")).toBe("971506468442");
    expect(normalizeUaeMobile("+971506468442")).toBe("971506468442");
  });

  it("accepts a number written without the trunk zero", () => {
    expect(normalizeUaeMobile("506468442")).toBe("971506468442");
  });

  it("strips formatting people paste from contact apps", () => {
    expect(normalizeUaeMobile("  050 646 8442 ")).toBe("971506468442");
    expect(normalizeUaeMobile("+971-50-646-8442")).toBe("971506468442");
    expect(normalizeUaeMobile("(050) 646.8442")).toBe("971506468442");
  });

  it("normalises every accepted form to the same stored value", () => {
    const forms = ["0506468442", "971506468442", "+971506468442", "050 646 8442"];
    expect(new Set(forms.map((form) => normalizeUaeMobile(form))).size).toBe(1);
  });

  it("rejects numbers that are not UAE mobiles", () => {
    expect(normalizeUaeMobile("")).toBeUndefined();
    expect(normalizeUaeMobile("   ")).toBeUndefined();
    // Landline prefix, not a mobile.
    expect(normalizeUaeMobile("042345678")).toBeUndefined();
    // Too short and too long.
    expect(normalizeUaeMobile("050646844")).toBeUndefined();
    expect(normalizeUaeMobile("05064684421")).toBeUndefined();
    // Another country.
    expect(normalizeUaeMobile("+966506468442")).toBeUndefined();
    // Not digits.
    expect(normalizeUaeMobile("05064684aa")).toBeUndefined();
    expect(normalizeUaeMobile(null)).toBeUndefined();
    expect(normalizeUaeMobile(undefined)).toBeUndefined();
  });

  it("reports validity without throwing", () => {
    expect(isUaeMobile("0506468442")).toBe(true);
    expect(isUaeMobile("042345678")).toBe(false);
  });

  it("groups the canonical form for display and leaves invalid input alone", () => {
    expect(formatUaeMobile("0506468442")).toBe("971 50 646 8442");
    expect(formatUaeMobile("not-a-number")).toBe("not-a-number");
  });
});
