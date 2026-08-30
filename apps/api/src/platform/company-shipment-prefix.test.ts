import { describe, expect, it } from "vitest";

import { companyShipmentPrefixCandidates } from "./company-shipment-prefix.js";

describe("companyShipmentPrefixCandidates", () => {
  it("prefers the first three normalized English letters", () => {
    expect(companyShipmentPrefixCandidates("Lahza Delivery")[0]).toBe("LAH");
    expect(companyShipmentPrefixCandidates("Éclair Express")[0]).toBe("ECL");
  });

  it("returns deterministic alternative name-based combinations", () => {
    const candidates = companyShipmentPrefixCandidates("Dana");
    expect(candidates).toEqual(["DAN", "DAA", "DNA", "ANA"]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("does not invent a prefix for a name with fewer than three English letters", () => {
    expect(companyShipmentPrefixCandidates("AI")).toEqual([]);
    expect(companyShipmentPrefixCandidates("دانا")).toEqual([]);
  });
});
