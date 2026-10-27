import { describe, expect, it } from "vitest";

import type { CompanyBranding } from "../company-profile/company-profile.service.js";
import { accountingReportHtml } from "./accounting-report-html.js";

const branding = { nameAr: "شركة", nameEn: "Company" } as unknown as CompanyBranding;

function render(language: "ar" | "en") {
  return accountingReportHtml({
    branding,
    document: {
      columns: ["Ref", "Trader Amount"],
      filters: {},
      generatedAt: "now",
      negativeColumns: ["Trader Amount"],
      rows: [
        { Ref: "2109", "Trader Amount": "-25.00" },
        { Ref: "2113", "Trader Amount": "850.00" },
      ],
      snapshotAt: "now",
      title: "Orders",
      warnings: [],
    },
    language,
    showTelephone: false,
  }).html;
}

describe("accountingReportHtml negative amounts (27 Oct 2026)", () => {
  it("shows what is owed back in red with the minus sign first, also in Arabic", () => {
    for (const language of ["ar", "en"] as const) {
      const html = render(language);
      expect(html).toContain('<td class="void"><bdi dir="ltr">-25.00</bdi></td>');
      expect(html).toContain("<td><bdi>850.00</bdi></td>");
    }
  });
});
