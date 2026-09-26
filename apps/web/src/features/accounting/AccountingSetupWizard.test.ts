import { describe, expect, it } from "vitest";

import { safeMappingRepairs } from "./AccountingSetupWizard.js";

describe("safeMappingRepairs", () => {
  it("selects only unresolved high-confidence compatible suggestions", () => {
    const safe = {
      compatibilityStatus: "compatible",
      confidence: "high",
      status: "suggested",
      suggestedAccount: { id: "account-1" },
    };
    const result = safeMappingRepairs([
      safe,
      { ...safe, confidence: "medium" },
      { ...safe, compatibilityStatus: "incompatible" },
      { ...safe, status: "already_configured" },
      { ...safe, suggestedAccount: null },
    ]);

    expect(result).toEqual([safe]);
  });

  it("never treats an ambiguous or missing account as an automatic repair", () => {
    expect(
      safeMappingRepairs([
        {
          compatibilityStatus: "compatible",
          confidence: "no_safe_suggestion",
          status: "suggested",
          suggestedAccount: null,
        },
      ]),
    ).toEqual([]);
  });
});
