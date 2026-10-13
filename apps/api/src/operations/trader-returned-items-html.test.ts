import { describe, expect, it } from "vitest";

import { buildTraderReturnedItemsHtml, type ReturnedItemsData } from "./trader-returned-items-html.js";

// Lahthza, 13 Oct 2026: three Cancelled Orders of one Trader (refs 4670, 4665, 4654).
const data: ReturnedItemsData = {
  header: {
    company: {
      hasLogo: false,
      logoDataUri: null,
      nameAr: "لحظه لخدمات التوصيل",
      nameEn: "Lahthza",
      subtitleAr: null,
      subtitleEn: "Lahthza for Delivery Services",
      telephone: "+971586589964",
    },
    generatedBy: "ops",
    orderCount: 3,
    reportNumber: "RET-TEST",
    traderMobile: "0500000000",
    traderName: "فيصل عبايا",
  },
  orders: [
    { areaName: "Deira", codAmount: "85.00", customerMobileNumber: "0552052692", customerName: "عميل", orderNumber: "ORD-000677", packageCount: 1, reason: "لال", referenceNumber: "4670", returnKind: "cancelled", serialNumber: "23" },
    { areaName: "Downtown Dubai", codAmount: "305.00", customerMobileNumber: "0565599658", customerName: "عميل", orderNumber: "ORD-000679", packageCount: 1, reason: "لال", referenceNumber: "4665", returnKind: "cancelled", serialNumber: "25" },
    { areaName: "Deira", codAmount: "295.00", customerMobileNumber: "0547869933", customerName: "<b>x</b>", orderNumber: "ORD-000680", packageCount: 2, reason: null, referenceNumber: "4654", returnKind: "returned_to_trader", serialNumber: "26" },
  ],
  summary: { countCancelled: 2, countReturned: 1, totalOrders: 3, totalPackages: 4, totalValue: "685.00" },
};

describe("buildTraderReturnedItemsHtml", () => {
  it("is headed by the Trader and lists every returned Order with its status and reason", () => {
    const html = buildTraderReturnedItemsHtml(data, "en", "13/10/2026, 13:30 (UAE)");
    expect(html).toContain("Trader Returned Items");
    expect(html).toContain("Trader: فيصل عبايا");
    for (const reference of ["4670", "4665", "4654"]) expect(html).toContain(reference);
    expect(html).toContain("Cancelled");
    expect(html).toContain("Returned to Trader");
    expect(html).toContain("لال");
    expect(html).toContain("685.00");
    expect(html).toContain("Received by Trader");
    // Customer text is escaped, never rendered as markup.
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    // One header cell per row cell.
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    const firstRow = html.slice(html.indexOf("<tbody>") + 7, html.indexOf("</tr>", html.indexOf("<tbody>")));
    expect((firstRow.match(/<td/g) ?? []).length).toBe((head.match(/<th[\s>]/g) ?? []).length);
  });

  it("renders the Arabic report right-to-left with Arabic labels", () => {
    const html = buildTraderReturnedItemsHtml(data, "ar", "13/10/2026, 13:30 (UAE)");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("كشف المرتجعات للتاجر");
    expect(html).toContain("ملغى");
    expect(html).toContain("استلمه التاجر");
  });
});
