import { describe, expect, it } from "vitest";

import { isMoneySummaryKey, summaryCardLabel } from "./AccountingComponents.js";

/* Summary cards are built from whatever keys the summary endpoint returns, so
   these two helpers are the only thing standing between a raw API key and the
   screen. They are tested directly rather than through a render: the defect
   they fix ("DRAFTCOUNT") is a pure key-to-label question. */

const translate = (key: string, options: { readonly defaultValue: string }) =>
  key === "accounting.summary.draftCount"
    ? "Draft"
    : key === "accounting.summary.totalPostedDebit"
      ? "Total posted debit"
      : options.defaultValue;

describe("summaryCardLabel", () => {
  it("uses the translated label when one exists", () => {
    expect(summaryCardLabel("draftCount", translate)).toBe("Draft");
    expect(summaryCardLabel("totalPostedDebit", translate)).toBe("Total posted debit");
  });

  it("never renders a raw camelCase key", () => {
    /* The keys the live Opening Balances summary returns. None of them may
       reach the card as an identifier, which is what put "VALIDATEDCOUNT" on
       screen once CSS uppercased it. */
    for (const key of [
      "draftCount",
      "validatedCount",
      "approvedCount",
      "postedCount",
      "reversedCount",
      "totalPostedDebit",
    ]) {
      expect(summaryCardLabel(key, translate)).not.toBe(key);
    }
  });

  it("humanises an untranslated key instead of falling back to the identifier", () => {
    // A metric the API adds later must still read as prose.
    expect(summaryCardLabel("totalPostedCredit", translate)).toBe("Total posted credit");
    expect(summaryCardLabel("reversedCount", translate)).toBe("Reversed count");
  });
});

describe("isMoneySummaryKey", () => {
  it("treats totals as money", () => {
    expect(isMoneySummaryKey("totalPostedDebit")).toBe(true);
    expect(isMoneySummaryKey("totalPostedCredit")).toBe(true);
  });

  it("leaves counts as plain numbers", () => {
    // Formatting a record count as "AED 5.00" would be worse than the raw label.
    expect(isMoneySummaryKey("draftCount")).toBe(false);
    expect(isMoneySummaryKey("totalCount")).toBe(false);
  });
});
