import { buildDriverCollectionReportHtml } from "./driver-collection-report-html.js";
import type { DriverCollectionReportData } from "./driver-cash-reconciliation.service.js";

const sample: DriverCollectionReportData = {
  expenses: [
    {
      amount: "10.00",
      description: "Petrol refill",
      enteredBy: "ops.user",
      expenseType: "Petrol",
      reason: "Route to Sharjah",
      recordedAt: "2026-07-27T10:00:00.000Z",
      reference: "EXP-1",
    },
  ],
  header: {
    businessDate: "2026-07-27",
    collectionPaymentMethod: "cash",
    company: {
      hasLogo: true,
      logoDataUri: "data:image/png;base64,c2FtcGxl",
      nameAr: "شركة الاختبار",
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: "Delivery operations",
      telephone: "+971 4 000 0000",
    },
    confirmedAt: "2026-07-27T11:00:00.000Z",
    confirmedBy: "ops.user",
    createdAt: "2026-07-27T10:30:00.000Z",
    createdBy: "ops.user",
    driverCode: "DRV-000001",
    driverName: "Test Driver",
    driverNameAr: null,
    driverType: "outsourced",
    isReversal: false,
    notes: "End of day handover",
    reconciliationNumber: "REC-000123",
    reversedByReconciliationNumber: null,
    reversesReconciliationNumber: null,
    status: "confirmed",
    statusLabel: "Confirmed",
  },
  orders: [
    {
      additionalFees: "0.00",
      areaName: "Deira",
      codAmount: "100.00",
      customerAmountToCollect: "110.00",
      customerName: "Test Customer",
      deliveryDate: "2026-07-27T09:00:00.000Z",
      driverReconciliationStatus: "reconciled",
      driverReconciliationStatusLabel: "Money Received from Driver",
      emirateName: "Dubai",
      paymentMethod: "cash",
      referenceNumber: "REF-1",
      serialNumber: "SER-1",
      serviceFee: "10.00",
      totalDeductions: "10.00",
      traderName: "Test Trader",
      traderPayable: "100.00",
      vatAmount: "0.00",
    },
  ],
  summary: {
    actualReceived: "100.00",
    cashNetExpected: "100.00",
    cashOrderCount: 1,
    cashTotal: "110.00",
    companyPaidDriver: "0.00",
    difference: "0.00",
    driverExpenses: "10.00",
    grossCollections: "110.00",
    netExpected: "100.00",
    orderCount: 1,
    visaOrderCount: 0,
    visaTotal: "0.00",
    zeroOrderCount: 0,
  },
};

describe("buildDriverCollectionReportHtml", () => {
  it("renders the English report LTR with every required field", () => {
    const html = buildDriverCollectionReportHtml(sample, "en", "27/07/2026, 12:00 (UAE)");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("Driver Collection Report");
    expect(html).toContain("REC-000123");
    // One Reference column: the External Reference Number when present.
    expect(html).toContain("REF-1");
    expect(html).not.toContain("SER-1");
    expect(html).toContain("Test Trader");
    expect(html).toContain("Test Customer");
    expect(html).toContain("Dubai");
    expect(html).toContain("Deira");
    expect(html).toContain("AED 100.00");
    expect(html).toContain("AED 110.00");
    expect(html).toContain("Petrol");
    expect(html).toContain("Route to Sharjah");
    expect(html).toContain("Test Company");
    expect(html).toContain("Delivery operations");
    expect(html).toContain('class="company-logo"');
    expect(html).toContain("data:image/png;base64,c2FtcGxl");
    // Signatures for Driver, Cashier/Operations User and Approver.
    expect(html).toContain("Driver");
    expect(html).toContain("Cashier/Operations User");
    expect(html).toContain("Approver");
  });

  it("renders the Arabic report RTL with Arabic business names and labels", () => {
    const html = buildDriverCollectionReportHtml(sample, "ar", "٢٧/٠٧/٢٠٢٦");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("تقرير تحصيل المندوب");
    // Arabic says المندوب, never السائق (Aiman, 11 Oct 2026).
    expect(html).not.toContain("السائق");
    // Arabic Company name used when available.
    expect(html).toContain("شركة الاختبار");
    // References and amounts are never translated.
    expect(html).toContain("REF-1");
    expect(html).toContain("AED 100.00");
  });

  it("falls back to the other language's Company subtitle when the requested one is missing", () => {
    const html = buildDriverCollectionReportHtml(sample, "ar", "now");
    // subtitleAr is null on the fixture; the English subtitle is shown instead
    // of leaving the block empty.
    expect(html).toContain("Delivery operations");
  });

  it("supports multi-page tables with repeated headers via a native <thead>", () => {
    const html = buildDriverCollectionReportHtml(sample, "en", "now");
    expect(html).toContain("<thead>");
    expect(html).toContain("display: table-header-group");
  });

  it("includes page-number placeholders are handled by the PDF renderer, not the HTML itself", () => {
    // The HTML document intentionally does not hardcode page numbers — those
    // are injected by the PDF engine's footerTemplate at render time.
    const html = buildDriverCollectionReportHtml(sample, "en", "now");
    expect(html).not.toContain("pageNumber");
  });

  it("never includes internal database IDs (the report-data shape carries none)", () => {
    const html = buildDriverCollectionReportHtml(sample, "en", "now");
    // A UUID pattern would only appear if some internal ID leaked through.
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(html)).toBe(false);
  });

  it("escapes HTML-significant characters in business data", () => {
    const withHtml: DriverCollectionReportData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, customerName: '<script>alert("x")</script>' }],
    };
    const html = buildDriverCollectionReportHtml(withHtml, "en", "now");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows a reversal cross-reference when the entry is itself a reversal", () => {
    const reversal: DriverCollectionReportData = {
      ...sample,
      header: {
        ...sample.header,
        isReversal: true,
        reconciliationNumber: "REC-000200",
        reversesReconciliationNumber: "REC-000123",
      },
    };
    const html = buildDriverCollectionReportHtml(reversal, "en", "now");
    expect(html).toContain("REC-000200");
  });
  it("prints Cash, Visa and Nothing-to-collect Orders as separate sections with subtotals (11 Oct 2026)", () => {
    const base = sample.orders[0]!;
    const mixed: DriverCollectionReportData = {
      ...sample,
      header: { ...sample.header, collectionPaymentMethod: "mixed" },
      orders: [
        { ...base, referenceNumber: "REF-C", customerAmountToCollect: "110.00", paymentMethod: "cash" },
        { ...base, referenceNumber: "REF-V", customerAmountToCollect: "267.00", paymentMethod: "visa" },
        // No External Reference: the Order Number is shown instead.
        { ...base, orderNumber: "ORD-Z", referenceNumber: null, customerAmountToCollect: "0.00", paymentMethod: "none" },
      ],
      summary: {
        ...sample.summary,
        cashOrderCount: 1,
        cashTotal: "110.00",
        grossCollections: "377.00",
        orderCount: 3,
        visaOrderCount: 1,
        visaTotal: "267.00",
        zeroOrderCount: 1,
      },
    };
    const html = buildDriverCollectionReportHtml(mixed, "en", "11/10/2026, 12:00 (UAE)");
    expect(html).toContain("Mixed (Cash + Visa)");
    expect(html).toContain("Cash Orders (1) &middot; AED 110.00");
    expect(html).toContain("Visa Orders (1) &middot; AED 267.00");
    expect(html).toContain("Nothing to collect (1) &middot; AED 0.00");
    expect(html.indexOf("REF-C")).toBeLessThan(html.indexOf("REF-V"));
    expect(html.indexOf("REF-V")).toBeLessThan(html.indexOf("ORD-Z"));
    // Visa Total already shows the bank amount; no repeated Visa to Bank line.
    expect(html).not.toContain("Visa to Bank");
    // Short statuses: "Rec Driver" for collected Orders, "Nothing" for 0.00.
    const zeroRow = html.slice(html.indexOf("ORD-Z"));
    expect(zeroRow.slice(0, zeroRow.indexOf("</tr>"))).toContain("<td>Nothing</td>");
    const cashRow = html.slice(html.indexOf("REF-C"));
    expect(cashRow.slice(0, cashRow.indexOf("</tr>"))).toContain("<td>Rec Driver</td>");
    expect(html).not.toContain("Money Received from Driver");
    const arabic = buildDriverCollectionReportHtml(mixed, "ar", "11/10/2026, 12:00 (UAE)");
    expect(arabic).toContain("مختلط (نقدي + فيزا)");
    expect(arabic).toContain("طلبات بدون تحصيل");
    expect(arabic).toContain("لاشي");
    expect(arabic).toContain("تحصيل مندوب");
  });

  it("ends the summary with Net Cash, in red, without the confusing totals", () => {
    const html = buildDriverCollectionReportHtml(sample, "en", "11/10/2026, 12:00 (UAE)");
    const summary = html.slice(html.indexOf('class="summary-section"'), html.indexOf('class="signatures"'));
    expect(summary).toContain(
      '<div class="summary-line summary-final"><span>Net Cash</span><span>AED 100.00</span></div>',
    );
    expect(summary).not.toContain("Net Expected");
    expect(summary).not.toContain("Difference");
    expect(summary).not.toContain(">Amount<");
    expect(html).toContain(".summary-final { color: #c62828;");
  });

  it("keeps the Order columns short: Fees combined, no VAT, Total Deductions or Serial Number", () => {
    const order = { ...sample.orders[0]!, additionalFees: "5.00", serviceFee: "18.00" };
    const html = buildDriverCollectionReportHtml({ ...sample, orders: [order] }, "en", "now");
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    expect(head).toContain("<th>Reference</th>");
    expect(head).toContain("<th>Fees</th>");
    expect(head).toContain("<th>COD</th>");
    expect(head).toContain("<th>Collected</th>");
    expect(head).toContain("<th>Trader Amount</th>");
    expect(head).toContain("<th>Visa/Cash</th>");
    expect(head).toContain("<th>Delivered</th>");
    expect(head).toContain("<th>Status</th>");
    for (const removed of ["VAT", "Total Deductions", "Order Serial Number", "Service Fee", "Additional Fees", "External Reference", "Amount Due", "Customer Amount"]) {
      expect(head).not.toContain(removed);
    }
    // Table amounts carry no currency and every cell stays on one line.
    const row = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(row).toContain('<td class="num">23.00</td>');
    expect(row).not.toContain("AED");
    expect(row).toContain("<td>Cash</td>");
    expect(html).toContain("table.grid.orders th, table.grid.orders td { white-space: nowrap; }");
  });

  it("ends with Cash Paid to Driver when the Company paid the Driver", () => {
    const payout: DriverCollectionReportData = {
      ...sample,
      summary: { ...sample.summary, cashNetExpected: "-30.00", companyPaidDriver: "30.00" },
    };
    const html = buildDriverCollectionReportHtml(payout, "en", "11/10/2026, 12:00 (UAE)");
    expect(html).toContain(
      '<div class="summary-line summary-final"><span>Cash Paid to Driver</span><span>AED 30.00</span></div>',
    );
    expect(html).not.toContain("<span>Net Cash</span>");
  });

  it("lists the Orders an order correction took off the collection (23 Oct 2026)", () => {
    const html = buildDriverCollectionReportHtml(
      {
        ...sample,
        header: {
          ...sample.header,
          amendment: {
            amendedReceived: "4943.00",
            originalReceived: "5213.00",
            removedLines: [
              {
                amount: "270.00",
                correctedAt: "2026-10-23T08:00:00.000Z",
                correctionNumber: "DCX-000001",
                orderNumber: "ORD-000212",
                reason: "Not delivered",
                referenceNumber: "4353",
                serialNumber: "SER-212",
              },
            ],
            version: "amended",
          },
        },
      },
      "en",
      "now",
    );
    expect(html).toContain("Amended collection");
    expect(html).toContain("SER-212 (ref 4353) removed by DCX-000001");
    expect(html).toContain("5213.00");
    expect(html).toContain("4943.00");
    expect(buildDriverCollectionReportHtml(sample, "en", "now")).not.toContain('class="notes-block amendment-block"');
  });
});
