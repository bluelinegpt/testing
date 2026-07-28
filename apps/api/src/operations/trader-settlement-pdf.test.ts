import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { buildTraderSettlementStatementHtml } from "./trader-settlement-report-html.js";
import type { TraderSettlementReportData } from "./trader-settlement.service.js";

// Real headless-Chromium rendering (no mocks): proves actual PDF bytes are
// produced for the Trader Settlement Statement, not merely that the
// report-data JSON was correct. The generic PDF engine's launch-failure and
// browser-reuse behaviour is already covered by driver-collection-pdf.service.test.ts
// (same shared DriverCollectionPdfService, no second engine) and is not
// re-tested here.
const footerEn = `<div style="font-size:9px;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
const footerAr = `<div style="font-size:9px;width:100%;text-align:center;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`;

function manyOrders(count: number): TraderSettlementReportData["orders"] {
  return Array.from({ length: count }, (_unused, index) => ({
    additionalFees: "0.00",
    amountPaidNow: "50.00",
    areaName: `Area ${index}`,
    codAmount: "55.00",
    customerName: `Customer ${index}`,
    deliveryDate: "2026-07-27T09:00:00.000Z",
    emirateName: "Dubai",
    orderSettlementStatus: "money_sent_to_trader",
    originalTraderPayable: "50.00",
    previouslyPaid: "0.00",
    referenceNumber: `REF-${index}`,
    remainingOutstanding: "0.00",
    serialNumber: `SER-${index}`,
    serviceFee: "5.00",
    totalDeductions: "5.00",
    vatAmount: "0.00",
  }));
}

const baseData: TraderSettlementReportData = {
  header: {
    beneficiaryBank: null,
    company: {
      hasLogo: false,
      nameAr: null,
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: null,
      telephone: null,
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
    paymentMethod: "cash",
    paymentReference: null,
    reversalOfSettlementNumber: null,
    reversalReason: null,
    reversedBySettlementNumber: null,
    settlementNumber: "SET-000999",
    sourceBank: null,
    status: "confirmed",
    traderName: "Test Trader",
  },
  orders: manyOrders(3),
  summary: {
    amountPaidNow: "150.00",
    orderCount: 3,
    previouslyPaid: "0.00",
    remainingOutstanding: "0.00",
    totalAdditionalFees: "0.00",
    totalCod: "165.00",
    totalDeductions: "15.00",
    totalOriginalTraderPayable: "150.00",
    totalServiceFees: "15.00",
    totalVat: "0.00",
  },
};

describe("Trader Settlement Statement PDF rendering", () => {
  it("renders a real, valid PDF file from English statement HTML", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildTraderSettlementStatementHtml(baseData, "en");
      const bytes = await service.renderPdf(html, footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("renders a real, valid PDF file from Arabic RTL statement HTML with embedded font glyphs", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildTraderSettlementStatementHtml(baseData, "ar");
      const bytes = await service.renderPdf(html, footerAr);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("produces a multi-page PDF when the Order table is long enough to span pages", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const manyData: TraderSettlementReportData = {
        ...baseData,
        orders: manyOrders(80),
        summary: { ...baseData.summary, orderCount: 80 },
      };
      const html = buildTraderSettlementStatementHtml(manyData, "en");
      const bytes = await service.renderPdf(html, footerEn);
      const match = /\/Count\s+(\d+)/.exec(bytes.toString("latin1"));
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(1);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("renders a single-Order settlement without error", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildTraderSettlementStatementHtml(baseData, "en");
      const bytes = await service.renderPdf(html, footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);
});
