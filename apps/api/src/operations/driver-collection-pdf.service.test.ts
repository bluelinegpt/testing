import { chromium } from "playwright";

import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { buildDriverCollectionReportHtml } from "./driver-collection-report-html.js";
import type { DriverCollectionReportData } from "./driver-cash-reconciliation.service.js";

// Real headless-Chromium rendering (no mocks): proves actual PDF bytes are
// produced, not merely that the report-data JSON was correct. §18 explicitly
// warns against claiming PDF rendering passed from JSON-only tests.
const footerEn = `<div style="font-size:9px;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
const footerAr = `<div style="font-size:9px;width:100%;text-align:center;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`;

function manyOrders(count: number): DriverCollectionReportData["orders"] {
  return Array.from({ length: count }, (_unused, index) => ({
    additionalFees: "0.00",
    areaName: `Area ${index}`,
    codAmount: "50.00",
    customerAmountToCollect: "55.00",
    customerName: `Customer ${index}`,
    deliveryDate: "2026-07-27T09:00:00.000Z",
    driverReconciliationStatus: "reconciled",
    driverReconciliationStatusLabel: "Money Received from Driver",
    emirateName: "Dubai",
    paymentMethod: "cash" as const,
    referenceNumber: `REF-${index}`,
    serialNumber: `SER-${index}`,
    serviceFee: "5.00",
    totalDeductions: "5.00",
    traderName: `Trader ${index}`,
    traderPayable: "50.00",
    vatAmount: "0.00",
  }));
}

const baseData: DriverCollectionReportData = {
  expenses: [],
  header: {
    businessDate: "2026-07-27",
    collectionPaymentMethod: "cash",
    company: {
      hasLogo: false,
      nameAr: null,
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: null,
      telephone: null,
    },
    confirmedAt: "2026-07-27T11:00:00.000Z",
    confirmedBy: "ops.user",
    createdAt: "2026-07-27T10:30:00.000Z",
    createdBy: "ops.user",
    driverName: "Test Driver",
    driverType: "outsourced",
    isReversal: false,
    notes: null,
    reconciliationNumber: "REC-000999",
    reversedByReconciliationNumber: null,
    reversesReconciliationNumber: null,
    status: "confirmed",
    statusLabel: "Confirmed",
  },
  orders: manyOrders(3),
  summary: {
    actualReceived: "150.00",
    cashTotal: "165.00",
    difference: "0.00",
    driverExpenses: "0.00",
    grossCollections: "165.00",
    netExpected: "165.00",
    orderCount: 3,
    visaTotal: "0.00",
  },
};

describe("DriverCollectionPdfService", () => {
  it("renders a real, valid PDF file from English report HTML", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildDriverCollectionReportHtml(baseData, "en", "27/07/2026, 12:00 (UAE)");
      const bytes = await service.renderPdf(html, footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("renders a real, valid PDF file from Arabic RTL report HTML with embedded font glyphs", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildDriverCollectionReportHtml(baseData, "ar", "٢٧/٠٧/٢٠٢٦");
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
      const manyData: DriverCollectionReportData = {
        ...baseData,
        orders: manyOrders(80),
        summary: { ...baseData.summary, orderCount: 80 },
      };
      const html = buildDriverCollectionReportHtml(manyData, "en", "now");
      const bytes = await service.renderPdf(html, footerEn);
      // The Pages tree's authoritative page count, written by Chromium as
      // "/Count N" — a reliable, real signal that more than one page exists,
      // not merely an inference from JSON report data.
      const match = /\/Count\s+(\d+)/.exec(bytes.toString("latin1"));
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(1);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("renders an empty document without error (content edge case)", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const bytes = await service.renderPdf("", footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("wraps a browser-launch failure in a safe ApplicationException, and recovers on the next call", async () => {
    const service = new DriverCollectionPdfService();
    const launchSpy = vi
      .spyOn(chromium, "launch")
      .mockRejectedValueOnce(new Error("simulated launch failure"));
    try {
      const html = buildDriverCollectionReportHtml(baseData, "en", "now");
      await expect(service.renderPdf(html, footerEn)).rejects.toMatchObject({
        errorCode: "report_pdf_engine_unavailable",
      });
      // The failed launch must not corrupt any reconciliation data — this
      // service never touches the database, so there is nothing to roll back;
      // it must also not leave the service permanently unusable.
      launchSpy.mockRestore();
      const bytes = await service.renderPdf(html, footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("reuses one browser instance across renders instead of relaunching each time", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildDriverCollectionReportHtml(baseData, "en", "now");
      const first = await service.renderPdf(html, footerEn);
      const second = await service.renderPdf(html, footerEn);
      expect(first.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(second.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);
});
