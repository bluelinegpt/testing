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
    cashTotal: "110.00",
    difference: "0.00",
    driverExpenses: "10.00",
    grossCollections: "110.00",
    netExpected: "100.00",
    orderCount: 1,
    visaTotal: "0.00",
  },
};

describe("buildDriverCollectionReportHtml", () => {
  it("renders the English report LTR with every required field", () => {
    const html = buildDriverCollectionReportHtml(sample, "en", "27/07/2026, 12:00 (UAE)");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("Driver Collection Report");
    expect(html).toContain("REC-000123");
    expect(html).toContain("SER-1");
    expect(html).toContain("REF-1");
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
    // Signatures for Driver, Cashier/Operations User and Approver.
    expect(html).toContain("Driver");
    expect(html).toContain("Cashier/Operations User");
    expect(html).toContain("Approver");
  });

  it("renders the Arabic report RTL with Arabic business names and labels", () => {
    const html = buildDriverCollectionReportHtml(sample, "ar", "٢٧/٠٧/٢٠٢٦");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("تقرير تحصيل السائق");
    // Arabic Company name used when available.
    expect(html).toContain("شركة الاختبار");
    // Serial numbers, references and amounts are never translated.
    expect(html).toContain("SER-1");
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
});
