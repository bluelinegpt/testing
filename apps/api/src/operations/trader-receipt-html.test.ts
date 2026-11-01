import { describe, expect, it } from "vitest";

import { buildTraderReceiptHtml } from "./trader-receipt-html.js";
import type { TraderCollectionReportData } from "./trader-receivable.service.js";

const line = (overrides: Partial<TraderCollectionReportData["lines"][number]>) => ({
  amountCollectedNow: "20.00",
  areaName: "Al Quoz 1",
  areaNameAr: "القوز 1",
  businessDate: "2026-10-27",
  customerMobileNumber: "0504656400",
  customerName: "Customer",
  emirateName: "Dubai",
  emirateNameAr: "دبي",
  orderCodAmount: "0.00",
  orderNumber: "ORD-001805",
  orderType: "delivery" as const,
  originalAmountDue: "25.00",
  previouslyCollected: "5.00",
  reason: "Order service fee owed by Trader",
  receivableId: "r",
  receivableNumber: "RCV-000098",
  receivableStatus: "collected",
  referenceNumber: "4283",
  remainingDue: "0.00",
  sourceReference: "ORD-001805",
  sourceType: "service_charge",
  ...overrides,
});

const data = (lines: TraderCollectionReportData["lines"], status: "confirmed" | "reversed" = "confirmed") =>
  ({
    header: {
      collectionNumber: "COL-000025",
      company: { hasLogo: false, logoDataUri: null, nameAr: null, nameEn: "Lahthza", subtitleAr: null, subtitleEn: null, telephone: null },
      companyBankAccount: null,
      generatedAt: "",
      paymentDate: "2026-10-27",
      paymentMethod: "cash",
      paymentReference: null,
      receivedBy: "ahmed",
      reversalDate: null,
      reversalReason: status === "reversed" ? "Wrong amount" : null,
      reversedBy: null,
      status,
      traderMobile: "971501234567",
      traderName: "BERVAZ",
    },
    lines,
    summary: { amountReceivedNow: "0", previouslyCollected: "0", receivableCount: lines.length, remainingDue: "0", totalOriginalAmountDue: "0", notes: null },
  }) as TraderCollectionReportData;

describe("Trader Receipt printed like the Trader Invoice", () => {
  it("shows the reference number (or the Order number), sorted, with the invoice columns and total", () => {
    const html = buildTraderReceiptHtml(
      data([
        line({ referenceNumber: "4285", orderNumber: "ORD-001799", amountCollectedNow: "20.00" }),
        line({ referenceNumber: null, orderNumber: "ORD-000900", amountCollectedNow: "50.00" }),
        line({ referenceNumber: "4283", amountCollectedNow: "20.00" }),
      ]),
      "en",
    );
    expect(html).toContain("Trader Receipt");
    expect(html).toContain("COL-000025");
    expect(html).toContain("Employee : <bdi>ahmed</bdi>");
    expect(html).toContain("Date : <bdi dir=\"ltr\">27-Oct-2026</bdi>");
    for (const heading of ["Reference No", "Customer Address", "Pro Price", "Del Price", "VAT", "Status", "Amount"]) {
      expect(html).toContain(`<th>${heading}</th>`);
    }
    expect(html.indexOf(">4283<")).toBeLessThan(html.indexOf(">4285<"));
    // No reference: the Order number stands in.
    expect(html).toContain(">ORD-000900<");
    // A reference keeps its Order number under it.
    expect(html).toContain("4285<br><small>ORD-001799</small>");
    expect(html).toContain("Dubai, Al Quoz 1");
    expect(html).toContain("90.00");
    expect(html).toContain("Payment : Cash");
  });

  it("prints Arabic names on the Arabic receipt and marks a reversed one", () => {
    const html = buildTraderReceiptHtml(data([line({})], "reversed"), "ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("إيصال استلام من التاجر");
    expect(html).toContain("دبي, القوز 1");
    expect(html).toContain("هذا الإيصال معكوس");
  });
});
