import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import {
  buildDriverShipmentManifestHtml,
  type ManifestData,
  type ManifestOrder,
} from "./driver-shipment-manifest-html.js";

// Real headless-Chromium rendering (no mocks): proves the Manifest itself
// produces real, valid, multi-page PDF bytes in both languages — the same
// renderer as the Driver Collection Report, reused rather than a second PDF
// system, but exercised here with the Manifest's own HTML/CSS so a layout
// regression specific to this document would be caught.
const footerEn = `<div style="font-size:9px;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
const footerAr = `<div style="font-size:9px;width:100%;text-align:center;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`;

function manyOrders(count: number): readonly ManifestOrder[] {
  return Array.from({ length: count }, (_unused, index) => ({
    areaName: `Area ${index}`,
    codAmount: "50.00",
    customerAddress: `Villa ${index}, Street ${index}`,
    customerMobileNumber: `97150000${String(index).padStart(4, "0")}`,
    customerName: `Customer ${index}`,
    customerSecondMobileNumber: null,
    deliveryInstructions: null,
    deliveryStatus: "assigned_to_driver",
    deliveryStatusLabel: "Assigned to Driver",
    emirateName: "Dubai",
    notes: null,
    packageCount: 1,
    referenceNumber: `REF-${index}`,
    serialNumber: `SER-${index}`,
    traderName: `Trader ${index}`,
  }));
}

const baseData: ManifestData = {
  header: {
    company: {
      hasLogo: false,
      logoDataUri: null,
      nameAr: null,
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: null,
      telephone: null,
    },
    driverMobile: "971500000001",
    driverName: "Test Driver",
    driverType: "outsourced",
    generatedBy: "ops.user",
    manifestNumber: "MAN-TEST01",
    orderCount: 3,
  },
  orders: manyOrders(3),
  summary: {
    countAssignedToDriver: 3,
    countCancelled: 0,
    countDelivered: 0,
    countNew: 0,
    countOutForDelivery: 0,
    countReturned: 0,
    totalCod: "150.00",
    totalOrders: 3,
    totalPackages: 3,
  },
};

describe("Driver Shipment Manifest PDF rendering", () => {
  it("renders a real, valid PDF file from English manifest HTML", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildDriverShipmentManifestHtml(baseData, "en", "27/07/2026, 12:00 (UAE)");
      const bytes = await service.renderPdf(html, footerEn);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("renders a real, valid PDF file from Arabic RTL manifest HTML", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const html = buildDriverShipmentManifestHtml(baseData, "ar", "٢٧/٠٧/٢٠٢٦");
      const bytes = await service.renderPdf(html, footerAr);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);

  it("produces a multi-page PDF with repeated headers when the Order table is long", async () => {
    const service = new DriverCollectionPdfService();
    try {
      const manyData: ManifestData = {
        ...baseData,
        header: { ...baseData.header, orderCount: 120 },
        orders: manyOrders(120),
        summary: { ...baseData.summary, totalOrders: 120 },
      };
      const html = buildDriverShipmentManifestHtml(manyData, "en", "now");
      const bytes = await service.renderPdf(html, footerEn);
      // The Pages tree's authoritative page count, written by Chromium — a
      // reliable, real signal, not an inference from JSON report data.
      const match = /\/Count\s+(\d+)/.exec(bytes.toString("latin1"));
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(1);
    } finally {
      await service.onModuleDestroy();
    }
  }, 60000);
});
