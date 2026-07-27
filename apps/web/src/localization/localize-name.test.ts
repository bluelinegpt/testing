import { describe, expect, it } from "vitest";

import { localizeName } from "./localize-name.js";

describe("localizeName", () => {
  it("shows the preferred language first", () => {
    expect(localizeName("ar", { ar: "دبي", en: "Dubai" })).toBe("دبي");
    expect(localizeName("en", { ar: "دبي", en: "Dubai" })).toBe("Dubai");
  });

  it("falls back to the alternate language when the preferred value is missing", () => {
    expect(localizeName("ar", { ar: null, en: "Dubai" })).toBe("Dubai");
    expect(localizeName("en", { ar: "دبي", en: "" })).toBe("دبي");
    expect(localizeName("ar", { ar: "   ", en: "Dubai" })).toBe("Dubai");
  });

  it("never returns a blank when either language has a value", () => {
    expect(localizeName("ar", { ar: undefined, en: "Only EN" })).toBe("Only EN");
    expect(localizeName("en", { ar: "عربي فقط", en: null })).toBe("عربي فقط");
  });

  it("returns an empty string only when neither language has a value", () => {
    expect(localizeName("en", { ar: null, en: "  " })).toBe("");
    expect(localizeName("ar", {})).toBe("");
  });

  it("falls back to English for AREA-000004 (Au Hail) which has no Arabic name", () => {
    // Real data-quality record: name_ar is missing. Arabic preference must show
    // the English value rather than a blank.
    const auHail = { ar: null, en: "Au Hail" };
    expect(localizeName("ar", auHail)).toBe("Au Hail");
    expect(localizeName("en", auHail)).toBe("Au Hail");
  });
});
