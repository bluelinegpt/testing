import { buildTraderSettlementStatementHtml } from "./trader-settlement-report-html.js";
import type { TraderSettlementReportData } from "./trader-settlement.service.js";

const sample: TraderSettlementReportData = {
  header: {
    beneficiaryBank: {
      accountName: "Trader Account",
      accountNumberMasked: "******7890",
      bankName: "Trader Bank",
      ibanMasked: "AE12******7890",
      swiftCode: "TRADAEXX",
    },
    company: {
      hasLogo: true,
      logoDataUri: null,
      nameAr: "شركة الاختبار",
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: "Delivery operations",
      telephone: "+971 4 000 0000",
    },
    confirmedBy: "ops.user",
    createdBy: "ops.user",
    generatedAt: "27/07/2026, 12:00 (UAE)",
    moneyReceivedBy: null,
    moneyReceivedDate: null,
    moneyReceivedNotes: null,
    moneyReceivedReference: null,
    moneySentAt: "2026-07-27T11:00:00.000Z",
    paymentDate: "2026-07-27",
    paymentMethod: "bank_transfer",
    paymentReference: "REF-BANK-1",
    reversalDate: null,
    reversalOfSettlementNumber: null,
    reversalReason: null,
    reversedBy: null,
    reversedBySettlementNumber: null,
    settlementNumber: "SET-000123",
    sourceBank: { accountName: "Company Account", bankName: "Company Bank" },
    status: "confirmed",
    traderName: "Test Trader",
  },
  orders: [
    {
      additionalFees: "0.00",
      amountPaidNow: "100.00",
      areaName: "Deira",
      codAmount: "110.00",
      customerName: "Test Customer",
      deliveryDate: "2026-07-20T09:00:00.000Z",
      emirateName: "Dubai",
      orderNumber: "ORD-000001",
      orderSettlementStatus: "money_sent_to_trader",
      originalTraderPayable: "100.00",
      previouslyPaid: "0.00",
      referenceNumber: "REF-1",
      remainingOutstanding: "0.00",
      serialNumber: "SER-1",
      serviceFee: "10.00",
      totalDeductions: "10.00",
      vatAmount: "0.00",
    },
  ],
  summary: {
    amountPaidNow: "100.00",
    orderCount: 1,
    previouslyPaid: "0.00",
    remainingOutstanding: "0.00",
    totalAdditionalFees: "0.00",
    totalCod: "110.00",
    totalDeductions: "10.00",
    totalOriginalTraderPayable: "100.00",
    totalServiceFees: "10.00",
    totalVat: "0.00",
  },
};

describe("buildTraderSettlementStatementHtml", () => {
  it("renders the English statement LTR with every required field", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("Trader Settlement Statement");
    expect(html).toContain("SET-000123");
    expect(html).toContain("SER-1");
    expect(html).toContain("REF-1");
    expect(html).toContain("REF-BANK-1");
    expect(html).toContain("Test Trader");
    expect(html).toContain("Test Customer");
    expect(html).toContain("Dubai");
    expect(html).toContain("Deira");
    expect(html).toContain("AED 100.00");
    expect(html).toContain("AED 110.00");
    expect(html).toContain("Test Company");
    expect(html).toContain("Delivery operations");
    // Bank section: source bank shows only bank/account name (no digits at
    // all today); beneficiary bank shows the masked account/IBAN, never raw.
    expect(html).toContain("Company Bank");
    expect(html).toContain("Company Account");
    expect(html).toContain("Trader Bank");
    expect(html).toContain("AE12******7890");
    expect(html).not.toContain("9876543210");
    // Signature areas.
    expect(html).toContain("Prepared By");
    expect(html).toContain("Company Authorization");
    expect(html).toContain("Trader Acknowledgement");
  });

  it("renders the Arabic statement RTL with Arabic business names and labels", () => {
    const html = buildTraderSettlementStatementHtml(sample, "ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("كشف تسوية التاجر");
    expect(html).toContain("شركة الاختبار");
    expect(html).toContain("SER-1");
    expect(html).toContain("REF-1");
    expect(html).toContain("AED 100.00");
  });

  it("falls back to the other language's Company subtitle when the requested one is missing", () => {
    const html = buildTraderSettlementStatementHtml(sample, "ar");
    expect(html).toContain("Delivery operations");
  });

  it("supports multi-page tables with repeated headers via a native <thead>", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).toContain("<thead>");
    expect(html).toContain("display: table-header-group");
  });

  it("does not hardcode page numbers — those are injected by the PDF renderer's footerTemplate", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).not.toContain("pageNumber");
  });

  it("never includes internal database IDs (the report-data shape carries none)", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(html)).toBe(false);
  });

  it("escapes HTML-significant characters in business data", () => {
    const withHtml: TraderSettlementReportData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, customerName: '<script>alert("x")</script>' }],
    };
    const html = buildTraderSettlementStatementHtml(withHtml, "en");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows a partial-payment Order with distinct previously-paid, paid-now and remaining amounts", () => {
    const partial: TraderSettlementReportData = {
      ...sample,
      orders: [
        {
          ...sample.orders[0]!,
          amountPaidNow: "60.00",
          previouslyPaid: "0.00",
          remainingOutstanding: "40.00",
        },
      ],
      summary: { ...sample.summary, amountPaidNow: "60.00", remainingOutstanding: "40.00" },
    };
    const html = buildTraderSettlementStatementHtml(partial, "en");
    expect(html).toContain("AED 60.00");
    expect(html).toContain("AED 40.00");
  });

  it("shows a Money Received notice with reference and notes when confirmed", () => {
    const received: TraderSettlementReportData = {
      ...sample,
      header: {
        ...sample.header,
        moneyReceivedBy: "ops.user",
        moneyReceivedDate: "2026-07-28T10:00:00.000Z",
        moneyReceivedNotes: "Confirmed by phone",
        moneyReceivedReference: "ACK-1",
      },
    };
    const html = buildTraderSettlementStatementHtml(received, "en");
    expect(html).toContain("Money Received by Trader confirmed.");
    expect(html).toContain("ACK-1");
    expect(html).toContain("Confirmed by phone");
  });

  it("shows a reversal notice when the settlement has been reversed", () => {
    const reversed: TraderSettlementReportData = {
      ...sample,
      header: { ...sample.header, reversedBySettlementNumber: "SET-000200", status: "reversed" },
    };
    const html = buildTraderSettlementStatementHtml(reversed, "en");
    expect(html).toContain("This settlement has been reversed.");
    expect(html).toContain("SET-000200");
  });

  it("shows a reversal cross-reference when the record is itself a reversal", () => {
    const reversal: TraderSettlementReportData = {
      ...sample,
      header: {
        ...sample.header,
        reversalOfSettlementNumber: "SET-000050",
        reversalReason: "Trader disputed the amount",
      },
    };
    const html = buildTraderSettlementStatementHtml(reversal, "en");
    expect(html).toContain("SET-000050");
    expect(html).toContain("Trader disputed the amount");
  });

  it("omits the notices section entirely for a plain, un-reversed, not-yet-received settlement", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).not.toContain('<div class="notice');
  });
});
