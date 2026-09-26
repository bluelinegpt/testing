import { buildDailyOperationsSummaryHtml } from "./daily-operations-summary-html.js";
import type { DailyOperationsSummaryReport } from "./daily-operations-summary.service.js";

const sampleReport: DailyOperationsSummaryReport = {
  dateMode: "business_day",
  driverSummary: [
    {
      deliveredOrders: 5,
      deliveryIncome: "95.00",
      driverCode: "DRV-000005",
      driverId: "driver-1",
      driverName: "Ahmed",
      driverType: "employee",
    },
  ],
  expenses: [],
  metadata: {
    businessDayStart: "04:00",
    dateFrom: "2026-08-23",
    dateTo: "2026-08-23",
    displayEnd: "2026-08-23",
    endUtc: "2026-08-23T20:00:00.000Z",
    spansRuleChange: false,
    startUtc: "2026-08-22T20:00:00.000Z",
    timezone: "Asia/Dubai",
  },
  netResult: "95.00",
  netStatus: "positive",
  includeTraderPayments: true,
  includeTraderCollections: true,
  includeTraderPayables: false,
  includeTraderReceivables: true,
  totalDeliveryIncome: "95.00",
  totalExpenses: "0.00",
  totalOrders: 5,
  totalTraderPayments: "275.00",
  totalTraderCollections: "200.00",
  totalTraderPayables: "0.00",
  totalTraderReceivables: "50.00",
  traderPayables: [],
  traderCollections: [
    {
      amount: "200.00",
      businessDate: "2026-08-23",
      calendarDate: "2026-08-23",
      collectionId: "collection-1",
      collectionNumber: "COL-000016",
      paymentMethod: "cash",
      reference: "COL-000016",
      traderName: "Ahmed Store",
    },
  ],
  traderPayments: [
    {
      amount: "275.00",
      businessDate: "2026-08-23",
      calendarDate: "2026-08-23",
      customerName: "flah",
      orderId: "order-1",
      orderNumber: "ORD-000001",
      orderSerialNumber: "1",
      originalAmountDue: "275.00",
      paymentMethod: "cash",
      previouslyPaid: "0.00",
      reference: "SET-000036",
      referenceNumber: "550",
      settlementId: "settlement-1",
      settlementNumber: "SET-000036",
      traderName: "Abudll Storeq",
    },
  ],
  traderReceivables: [
    {
      amountCollected: "0.00",
      businessDate: "2026-08-23",
      calendarDate: "2026-08-23",
      createdAt: "2026-08-23T08:00:00.000Z",
      orderSerialNumber: "7",
      originalAmountDue: "50.00",
      outstandingAmount: "50.00",
      reason: "Order service fee owed by Trader",
      receivableId: "receivable-1",
      receivableNumber: "RCV-000012",
      sourceReference: "ORD-000085",
      traderName: "Cools",
    },
  ],
};

describe("buildDailyOperationsSummaryHtml", () => {
  it("renders trader payments in the PDF HTML review", () => {
    const html = buildDailyOperationsSummaryHtml(sampleReport, "en", "23/08/2026, 14:19 (UAE)");

    expect(html).toContain("Trader Payments");
    expect(html).toContain("Total Trader Payments");
    expect(html).toContain("Abudll Storeq");
    expect(html).toContain("flah");
    expect(html).toContain("550");
    expect(html).toContain("AED 275.00");
  });

  it("hides optional Trader sections when the report flags are false", () => {
    const html = buildDailyOperationsSummaryHtml(
      {
        ...sampleReport,
        includeTraderPayments: false,
        includeTraderCollections: false,
        includeTraderReceivables: false,
      },
      "en",
      "23/08/2026, 14:19 (UAE)",
    );

    expect(html).not.toContain("Trader Payments");
    expect(html).not.toContain("Trader Collections");
    expect(html).not.toContain("Money to Collect from Traders");
    expect(html).not.toContain("flah");
    expect(html).not.toContain("RCV-000012");
    expect(html).not.toContain("COL-000016");
  });

  it("renders Trader Collections when the PDF flag is enabled", () => {
    const html = buildDailyOperationsSummaryHtml(
      { ...sampleReport, includeTraderPayments: false, includeTraderReceivables: false },
      "en",
      "23/08/2026, 14:19 (UAE)",
    );

    expect(html).toContain("Trader Collections");
    expect(html).toContain("Total Trader Collections");
    expect(html).toContain("Ahmed Store");
    expect(html).toContain("COL-000016");
    expect(html).toContain("AED 200.00");
  });

  it("renders Money to Collect from Traders when the PDF flag is enabled", () => {
    const html = buildDailyOperationsSummaryHtml(
      { ...sampleReport, includeTraderPayments: false, includeTraderReceivables: true },
      "en",
      "23/08/2026, 14:19 (UAE)",
    );

    expect(html).toContain("Money to Collect from Traders");
    expect(html).toContain("Total Money to Collect from Traders");
    expect(html).toContain("RCV-000012");
    expect(html).toContain("ORD-000085");
    expect(html).toContain("AED 50.00");
    expect(html).not.toContain("Trader Payments");
  });

  it("renders Arabic trader payment labels in RTL reports", () => {
    const html = buildDailyOperationsSummaryHtml(sampleReport, "ar", "23/08/2026, 14:19 (UAE)");

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("مدفوعات التجار");
    expect(html).toContain("إجمالي مدفوعات التجار");
    expect(html).toContain("flah");
    expect(html).toContain("550");
  });
});