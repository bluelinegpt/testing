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
      customerMobileNumber: "971500000001",
      deliveryDate: "2026-07-20T09:00:00.000Z",
      emirateName: "Dubai",
      orderNumber: "ORD-000001",
      orderType: "delivery",
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
  receivableOffsets: [],
  summary: {
    amountPaidNow: "100.00",
    grossOrderPayable: "100.00",
    netPayment: "100.00",
    orderCount: 1,
    previouslyPaid: "0.00",
    remainingOutstanding: "0.00",
    totalAdditionalFees: "0.00",
    totalCod: "110.00",
    totalDeductions: "10.00",
    totalOriginalTraderPayable: "100.00",
    totalServiceFees: "10.00",
    totalVat: "0.00",
    traderFeeDeductions: "0.00",
  },
};

describe("buildTraderSettlementStatementHtml", () => {
  it("renders the English statement LTR with every required field", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("Trader Invoice");
    expect(html).toContain("SET-000123");
    // Reference Number replaces the Order Number column when present.
    expect(html).not.toContain("ORD-000001");
    expect(html).toContain("REF-1");
    expect(html).toContain("REF-BANK-1");
    expect(html).toContain("Test Trader");
    expect(html).toContain("Test Customer");
    expect(html).toContain("Dubai");
    expect(html).toContain("Deira");
    expect(html).toContain("100.00");
    expect(html).toContain("110.00");
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

  it("marks a draft as not posted and leaves off the posting fields (one-screen flow)", () => {
    const html = buildTraderSettlementStatementHtml(
      {
        ...sample,
        header: {
          ...sample.header,
          confirmedBy: "",
          hideMoneyReceived: true,
          moneySentAt: null,
          settlementNumber: "—",
          status: "draft",
        },
      },
      "en",
    );
    expect(html).toContain("Draft — not posted");
    expect(html).toContain('class="draft-watermark"');
    expect(html).toContain("not posted, no money has been paid");
    expect(html).not.toContain("Money Received Date");
    expect(html).not.toContain("Money Sent Date");
  });

  it("leaves Money Received off a posted invoice when the Company has no such step", () => {
    const html = buildTraderSettlementStatementHtml(
      { ...sample, header: { ...sample.header, hideMoneyReceived: true } },
      "en",
    );
    expect(html).not.toContain("Money Received Date");
    expect(html).not.toContain('class="draft-watermark"');
  });

  it("renders the Arabic statement RTL with Arabic business names and labels", () => {
    const html = buildTraderSettlementStatementHtml(sample, "ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("فاتورة التاجر");
    expect(html).toContain("شركة الاختبار");
    expect(html).not.toContain("Test Company / شركة الاختبار");
    expect(html.slice(0, html.indexOf("<table"))).not.toContain("الرقم المرجعي");
    expect(html).toContain("التفاصيل المالية");
    expect((html.match(/<table class="grid">/g) ?? []).length).toBe(1);
    const summary = html.slice(
      html.indexOf('<section class="summary-section">'),
      html.indexOf('<div class="signatures">'),
    );
    expect(summary).not.toContain("المستحق الأصلي للتاجر");
    expect(html).toContain("شركة الاختبار");
    // Reference Number replaces the Order Number column when present.
    expect(html).not.toContain("ORD-000001");
    expect(html).toContain("REF-1");
    expect(html).toContain("100.00");
  });

  it("combines Service Fee and Additional Fees into one column and one summary line, so the invoice adds up", () => {
    // Lahthza SET-000063 / ORD-000316: COD 230.00 - Service Fee 16.00 -
    // Additional Fees 16.00 = 198.00 paid. The invoice used to print only the
    // Service Fee, so neither the row nor the totals added up.
    const withAdditional: TraderSettlementReportData = {
      ...sample,
      orders: [
        {
          ...sample.orders[0]!,
          additionalFees: "16.00",
          amountPaidNow: "198.00",
          codAmount: "230.00",
          serviceFee: "16.00",
          totalDeductions: "32.00",
        },
      ],
      summary: { ...sample.summary, totalAdditionalFees: "16.00", totalCod: "230.00", totalServiceFees: "16.00", netPayment: "198.00" },
    };
    const html = buildTraderSettlementStatementHtml(withAdditional, "en");
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    expect(head).toContain("Service Fee + Additional Fees");
    // One combined column, not two.
    expect(head.match(/Additional Fees/g)?.length).toBe(1);
    const headCells = (head.match(/<th[\s>]/g) ?? []).length;
    const firstRow = html.slice(html.indexOf("<tbody>") + 7, html.indexOf("</tr>", html.indexOf("<tbody>")));
    expect((firstRow.match(/<td/g) ?? []).length).toBe(headCells);
    expect(firstRow).toContain("32.00");
    const summary = html.slice(
      html.indexOf('<section class="summary-section">'),
      html.indexOf('<div class="signatures">'),
    );
    expect(summary).toContain("Service Fee + Additional Fees");
    expect(summary).toContain("32.00");
    expect(summary).toContain("198.00");
  });

  it("keeps the plain Service Fee heading when no Order has Additional Fees", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"))).not.toContain("Additional Fees");
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
    expect(html).toContain("60.00");
  });

  it("shows Trader fee deductions as negative lines and the net payment", () => {
    const withDeduction: TraderSettlementReportData = {
      ...sample,
      receivableOffsets: [
        {
          amountApplied: "25.00",
          businessDate: "2026-07-19",
          customerMobileNumber: null,
          customerName: null,
          orderSerialNumber: "SER-FEE-1",
          orderNumber: "ORD-FEE-1",
          referenceNumber: "1706",
          reason: "Service fee owed by Trader",
          receivableNumber: "RCV-000123",
          sourceReference: "ORD-FEE-1",
          sourceType: "service_charge",
        },
      ],
      summary: {
        ...sample.summary,
        grossOrderPayable: "100.00",
        netPayment: "75.00",
        traderFeeDeductions: "25.00",
      },
    };
    const html = buildTraderSettlementStatementHtml(withDeduction, "en");
    expect(html).not.toContain("RCV-000123");
    expect(html).toContain("1706");
    expect(html).toContain("1706");
    expect(html).not.toContain("SER-FEE-1");
    expect(html).not.toContain("Service fee owed by Trader");
    expect(html).toContain("−25.00");
    // The invoice prints plain figures without an "AED" prefix.
    expect(html).toContain('<bdi dir="ltr">75.00</bdi>');
    const summary = html.slice(
      html.indexOf('<section class="summary-section">'),
      html.indexOf('<div class="signatures">'),
    );
    expect(summary).toContain('<bdi dir="ltr">35.00</bdi>');
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
    expect(html).toContain("This invoice has been reversed.");
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

  it("leaves Created By and Money Sent By off AL Fahd Al Maliky's invoice only", () => {
    const withCreator = {
      ...sample,
      header: { ...sample.header, confirmedBy: "Mostafa", createdBy: "Mostafa" },
    };
    const fahd = { ...withCreator, companyId: "2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1" };
    for (const language of ["en", "ar"] as const) {
      const html = buildTraderSettlementStatementHtml(fahd, language);
      expect(html).not.toContain("Mostafa");
      expect(html).not.toContain(language === "en" ? "Created By" : "أنشأه");
      expect(html).not.toContain(language === "en" ? "Money Sent By" : "أرسله");
      expect(html).toContain("SET-000123");
    }
    const other = buildTraderSettlementStatementHtml(
      { ...withCreator, companyId: "dd28829b-2b7c-4851-a0be-181b92673e84" },
      "en",
    );
    expect(other).toContain("Created By");
    expect(other).toContain("Money Sent By");
    expect(other).toContain("Mostafa");
    const otherArabic = buildTraderSettlementStatementHtml(
      { ...withCreator, companyId: "dd28829b-2b7c-4851-a0be-181b92673e84" },
      "ar",
    );
    expect(otherArabic).toContain("أرسله");
  });

  it("prints the compact invoice (no Delivery Date, COD Amount or Service Fee) for XYZ Deliver services only", () => {
    const xyz = { ...sample, companyId: "dd28829b-2b7c-4851-a0be-181b92673e84" };
    const headerCells = (html: string) =>
      (html.split("<tbody>")[0]?.split("<thead>")[1]?.match(/<th[ >]/g) ?? []).length;
    for (const language of ["en", "ar"] as const) {
      const html = buildTraderSettlementStatementHtml(xyz, language);
      const labels =
        language === "en"
          ? { cod: "COD Amount", date: "Delivery Date", fee: "Service Fee", paid: "Amount Paid Now" }
          : { cod: null, date: "تاريخ التسليم", fee: null, paid: null };
      expect(html).not.toContain(labels.date);
      if (labels.cod !== null) expect(html).not.toContain(labels.cod);
      if (labels.fee !== null) expect(html).not.toContain(labels.fee);
      if (labels.paid !== null) expect(html).toContain(labels.paid);
      // The COD (110.00) and fee (10.00) figures are gone; the paid amount stays.
      expect(html).not.toContain("110.00");
      expect(html).toContain("100.00");
      expect(headerCells(html)).toBe(7);
    }
    const other = buildTraderSettlementStatementHtml(
      { ...sample, companyId: "4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb" },
      "en",
    );
    expect(other).toContain("Delivery Date");
    expect(other).toContain("COD Amount");
    expect(other).toContain("Service Fee");
    expect(other).toContain("110.00");
    expect(headerCells(other)).toBe(10);
  });

  it("shows an XYZ Trader fee deduction as a negative Amount Paid Now with matching cell counts", () => {
    const xyzWithDeduction: TraderSettlementReportData = {
      ...sample,
      companyId: "dd28829b-2b7c-4851-a0be-181b92673e84",
      receivableOffsets: [
        {
          amountApplied: "25.00",
          businessDate: "2026-07-19",
          customerMobileNumber: null,
          customerName: null,
          orderSerialNumber: "SER-FEE-1",
          orderNumber: "ORD-FEE-1",
          referenceNumber: "1706",
          reason: "Service fee owed by Trader",
          receivableNumber: "RCV-000123",
          sourceReference: "ORD-FEE-1",
          sourceType: "service_charge",
        },
      ],
      summary: { ...sample.summary, netPayment: "75.00", traderFeeDeductions: "25.00" },
    };
    const html = buildTraderSettlementStatementHtml(xyzWithDeduction, "en");
    expect(html).toContain("1706");
    expect(html).toContain("−25.00");
    expect(html).toContain("75.00");
    expect(html).not.toContain("2026-07-19");
    const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
    const rows = body.split("<tr>").slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect((row.match(/<td[ >]/g) ?? []).length).toBe(7);
  });

  it("omits the notices section entirely for a plain, un-reversed, not-yet-received settlement", () => {
    const html = buildTraderSettlementStatementHtml(sample, "en");
    expect(html).not.toContain('<div class="notice');
  });

  // Per Aiman (13 Oct 2026): a column with no data on the invoice is left off;
  // Order Number prints only in place of a missing Reference Number.
  // ORD-000649 (104.00): 60.00 on SET-000101, 44.00 on SET-000102.
  it("shows Previously Paid / Remaining Outstanding only when they have amounts, and hides empty columns", () => {
    const cells = (html: string) => {
      const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
      const first = html.slice(html.indexOf("<tbody>") + 7, html.indexOf("</tr>", html.indexOf("<tbody>")));
      return [(head.match(/<th[\s>]/g) ?? []).length, (first.match(/<td[\s>]/g) ?? []).length];
    };
    const first: TraderSettlementReportData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, amountPaidNow: "60.00", paidBeforeThisPayment: "0.00", remainingAfterThisPayment: "44.00" }],
    };
    const firstHtml = buildTraderSettlementStatementHtml(first, "en");
    expect(firstHtml).toContain("Remaining Outstanding");
    expect(firstHtml).not.toContain("Previously Paid");
    const [h1, d1] = cells(firstHtml);
    expect(d1).toBe(h1);

    const second: TraderSettlementReportData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, amountPaidNow: "44.00", paidBeforeThisPayment: "60.00", remainingAfterThisPayment: "0.00" }],
    };
    const secondHtml = buildTraderSettlementStatementHtml(second, "ar");
    expect(secondHtml).toContain("مدفوع سابقاً");
    expect(secondHtml).not.toContain("الرصيد المتبقي");

    // No customer, mobile, emirate or area on any row: those columns go; no
    // Reference: the Order Number prints in its place.
    const bare: TraderSettlementReportData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, areaName: "", customerMobileNumber: "", customerName: "", emirateName: null, referenceNumber: null }],
    };
    const bareHtml = buildTraderSettlementStatementHtml(bare, "en");
    for (const label of ["Customer", "Customer Mobile", "Emirate", "Area"]) expect(bareHtml).not.toContain(`>${label}</th>`);
    expect(bareHtml).toContain("ORD-000001");
    const [h3, d3] = cells(bareHtml);
    expect(d3).toBe(h3);
  });

  it("prints the Trader's mobile in the header when one is saved", () => {
    const withMobile: TraderSettlementReportData = { ...sample, header: { ...sample.header, traderMobile: "0501234567" } };
    expect(buildTraderSettlementStatementHtml(withMobile, "en")).toContain("Trader Mobile");
    expect(buildTraderSettlementStatementHtml(withMobile, "en")).toContain("0501234567");
    expect(buildTraderSettlementStatementHtml(withMobile, "ar")).toContain("جوال التاجر");
    expect(buildTraderSettlementStatementHtml(sample, "en")).not.toContain("Trader Mobile");
  });

  it("prints a COD-shortfall deduction with its Order's COD and fee and a negative Amount Paid Now, so the totals add up", () => {
    // ORD-000023 (CMP-000001): COD 1.00, fee 20.00 -> the Trader owes 19.00.
    const shortfall: TraderSettlementReportData = {
      ...sample,
      header: { ...sample.header, deductionRowsShowOrderMoney: true },
      receivableOffsets: [
        {
          amountApplied: "19.00",
          businessDate: "2026-10-22",
          customerMobileNumber: null,
          customerName: null,
          orderCodAmount: "1.00",
          orderSerialNumber: "1",
          orderNumber: "ORD-000023",
          referenceNumber: null,
          reason: "Order service fee owed by Trader",
          receivableNumber: "RCV-000005",
          sourceReference: "ORD-000023",
          sourceType: "service_charge",
        },
      ],
      summary: { ...sample.summary, netPayment: "81.00", traderFeeDeductions: "19.00" },
    };
    const html = buildTraderSettlementStatementHtml(shortfall, "en");
    const body = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
    const row = body.split("<tr>").find((cell) => cell.includes("ORD-000023")) ?? "";
    // COD 1.00, fee 20.00 (1 + 19), Amount Paid Now -19.00.
    expect(row).toContain('<bdi dir="ltr">1.00</bdi>');
    expect(row).toContain('<bdi dir="ltr">20.00</bdi>');
    expect(row).toContain("−19.00");
    const summary = html.slice(
      html.indexOf('<section class="summary-section">'),
      html.indexOf('<div class="signatures">'),
    );
    // COD 110 + 1 = 111, fees 10 + 20 = 30, paid 111 - 30 = 81.
    expect(summary).toContain('<bdi dir="ltr">111.00</bdi>');
    expect(summary).toContain('<bdi dir="ltr">30.00</bdi>');
    expect(summary).toContain('<bdi dir="ltr">81.00</bdi>');
    // The Trader owes: the net prints as the amount collected from him.
    const owes = buildTraderSettlementStatementHtml(
      { ...shortfall, summary: { ...shortfall.summary, netPayment: "-20.00" } },
      "en",
    );
    expect(owes).toContain("Amount Collected from Trader");
    expect(owes).not.toContain(">Amount Paid Now</span>");
    expect(buildTraderSettlementStatementHtml(
      { ...shortfall, summary: { ...shortfall.summary, netPayment: "-20.00" } },
      "ar",
    )).toContain("المبلغ المحصّل من التاجر");
    // A charge added by hand (no Order) prints its number and reason, and a
    // 0-due Order whose fee the customer paid directly stays out of the fee
    // total: fees 150 -> collected 150 (ORD-000037 + RCV-000007, 22 Oct 2026).
    const manual: TraderSettlementReportData = {
      ...shortfall,
      orders: [
        {
          ...sample.orders[0]!,
          amountPaidNow: "0.00",
          codAmount: "0.00",
          orderNumber: "ORD-000037",
          originalTraderPayable: "0.00",
          referenceNumber: "5002",
          serviceFee: "30.00",
        },
      ],
      receivableOffsets: [
        {
          amountApplied: "150.00",
          businessDate: "2026-10-22",
          customerMobileNumber: null,
          customerName: null,
          orderCodAmount: null,
          orderNumber: null,
          orderSerialNumber: null,
          reason: "test",
          receivableNumber: "RCV-000007",
          referenceNumber: null,
          sourceReference: null,
          sourceType: "service_charge",
        },
      ],
      summary: {
        ...sample.summary,
        netPayment: "-150.00",
        totalCod: "0.00",
        totalServiceFees: "30.00",
        traderFeeDeductions: "150.00",
      },
    };
    const manualHtml = buildTraderSettlementStatementHtml(manual, "en");
    const manualRow =
      (manualHtml.split("<tbody>")[1] ?? "").split("<tr>").find((cell) => cell.includes("RCV-000007")) ?? "";
    expect(manualRow).toContain(">test<");
    const manualSummary = manualHtml.slice(
      manualHtml.indexOf('<section class="summary-section">'),
      manualHtml.indexOf('<div class="signatures">'),
    );
    expect(manualSummary).toContain('<span>Service Fee</span><span><bdi dir="ltr">150.00</bdi>');
    expect(manualSummary).toContain("Amount Collected from Trader");
    // Without the switch the row keeps the existing layout.
    const plain = buildTraderSettlementStatementHtml({ ...shortfall, header: sample.header }, "en");
    expect(plain).toContain('<bdi dir="ltr">110.00</bdi>');
  });

  it("marks an amended invoice and its original copy with the removed Orders (order correction, 23 Oct 2026)", () => {
    const amendment = {
      amendedNetPayment: "2750.00",
      originalNetPayment: "3000.00",
      removedLines: [
        {
          amount: "250.00",
          correctedAt: "2026-10-23T08:00:00.000Z",
          correctionNumber: "DCX-000001",
          orderNumber: "ORD-000212",
          reason: "Not delivered, marked by mistake",
          recoveryReceivableNumber: "RCV-000101",
          referenceNumber: "4353",
          serialNumber: "SER-212",
        },
      ],
    };
    const amended = buildTraderSettlementStatementHtml(
      { ...sample, header: { ...sample.header, amendment: { ...amendment, version: "amended" } } },
      "en",
    );
    expect(amended).toContain("Amended invoice");
    expect(amended).toContain("SER-212 (ref 4353) removed by DCX-000001");
    expect(amended).toContain("RCV-000101");
    expect(amended).toContain("3000.00");
    expect(amended).toContain("2750.00");
    expect(amended).not.toContain('class="draft-watermark watermark-original"');
    const original = buildTraderSettlementStatementHtml(
      { ...sample, header: { ...sample.header, amendment: { ...amendment, version: "original" } } },
      "ar",
    );
    expect(original).toContain('class="draft-watermark watermark-original"');
    expect(original).toContain("النسخة الأصلية");
    // No correction: nothing changes.
    expect(buildTraderSettlementStatementHtml(sample, "en")).not.toContain('class="notice notice-amended"');
  });
});
