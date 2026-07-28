import {
  buildDriverShipmentManifestHtml,
  type ManifestData,
} from "./driver-shipment-manifest-html.js";

const sample: ManifestData = {
  header: {
    company: {
      hasLogo: true,
      nameAr: "شركة الاختبار",
      nameEn: "Test Company",
      subtitleAr: null,
      subtitleEn: "Delivery operations",
      telephone: "+971 4 000 0000",
    },
    driverMobile: "971500000001",
    driverName: "Test Driver",
    driverType: "outsourced",
    generatedBy: "ops.user",
    manifestNumber: "MAN-ABC123",
    orderCount: 1,
  },
  orders: [
    {
      areaName: "Deira",
      codAmount: "150.00",
      customerAddress: "Villa 12, Street 4",
      customerMobileNumber: "971500000002",
      customerName: "Test Customer",
      customerSecondMobileNumber: "971500000003",
      deliveryInstructions: "Call before arrival",
      deliveryStatus: "assigned_to_driver",
      deliveryStatusLabel: "Assigned to Driver",
      emirateName: "Dubai",
      notes: "Fragile",
      packageCount: 2,
      referenceNumber: "REF-9",
      serialNumber: "SER-9",
      traderName: "Test Trader",
    },
  ],
  summary: {
    countAssignedToDriver: 1,
    countCancelled: 0,
    countDelivered: 0,
    countNew: 0,
    countOutForDelivery: 0,
    countReturned: 0,
    totalCod: "150.00",
    totalOrders: 1,
    totalPackages: 2,
  },
};

describe("buildDriverShipmentManifestHtml", () => {
  it("renders the English manifest LTR with every required field", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "27/07/2026, 12:00 (UAE)");
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("Driver Shipment Manifest");
    expect(html).toContain("MAN-ABC123");
    expect(html).toContain("SER-9");
    expect(html).toContain("REF-9");
    expect(html).toContain("Test Trader");
    expect(html).toContain("Test Customer");
    expect(html).toContain("971500000002");
    expect(html).toContain("971500000003");
    expect(html).toContain("Dubai");
    expect(html).toContain("Deira");
    expect(html).toContain("Villa 12, Street 4");
    expect(html).toContain("AED 150.00");
    expect(html).toContain("Call before arrival");
    expect(html).toContain("Fragile");
    expect(html).toContain("Assigned to Driver");
    expect(html).toContain("Test Company");
    expect(html).toContain("Delivery operations");
    expect(html).toContain("Test Driver");
    expect(html).toContain("Outsourced");
    // Signatures for Driver, Operations Handover and Returned/Received By.
    expect(html).toContain("Operations Handover");
    expect(html).toContain("Returned/Received By");
  });

  it("renders the Arabic manifest RTL with Arabic business names and labels", () => {
    const html = buildDriverShipmentManifestHtml(sample, "ar", "٢٧/٠٧/٢٠٢٦");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("كشف شحنات السائق");
    expect(html).toContain("شركة الاختبار");
    // Serial numbers, references and amounts are never translated.
    expect(html).toContain("SER-9");
    expect(html).toContain("REF-9");
    expect(html).toContain("AED 150.00");
  });

  it("is a strictly separate document from the Driver Collection Report", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    // Never a financial reconciliation term, and never claims proof of payment.
    expect(html).not.toContain("Driver Collection Report");
    expect(html).not.toContain("Net Expected");
    expect(html).not.toContain("Reconciliation");
  });

  it("supports multi-page tables with repeated headers via a native <thead>", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(html).toContain("<thead>");
    expect(html).toContain("display: table-header-group");
  });

  it("does not hardcode page numbers — those come from the PDF renderer's footerTemplate", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(html).not.toContain("pageNumber");
  });

  it("never includes internal database IDs (the manifest data shape carries none)", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(html)).toBe(false);
  });

  it("escapes HTML-significant characters in business data", () => {
    const withHtml: ManifestData = {
      ...sample,
      orders: [{ ...sample.orders[0]!, customerName: '<script>alert("x")</script>' }],
    };
    const html = buildDriverShipmentManifestHtml(withHtml, "en", "now");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders every summary total and delivery-status count", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(html).toContain("Total Orders");
    expect(html).toContain("Total COD");
    expect(html).toContain("Total Packages");
    expect(html).toContain("Cancelled");
    expect(html).toContain("Delivered");
    expect(html).toContain("Returned");
    expect(html).toContain("Out for Delivery");
  });

  it("omits optional fields cleanly when null rather than printing 'null'", () => {
    const sparse: ManifestData = {
      ...sample,
      header: { ...sample.header, company: { ...sample.header.company, telephone: null } },
      orders: [
        {
          ...sample.orders[0]!,
          customerSecondMobileNumber: null,
          deliveryInstructions: null,
          emirateName: null,
          notes: null,
          referenceNumber: null,
        },
      ],
    };
    const html = buildDriverShipmentManifestHtml(sparse, "en", "now");
    expect(html).not.toContain("null");
  });
});
