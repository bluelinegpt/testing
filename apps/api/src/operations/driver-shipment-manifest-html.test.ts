import {
  buildDriverShipmentManifestHtml,
  type ManifestData,
} from "./driver-shipment-manifest-html.js";

const sample: ManifestData = {
  header: {
    company: {
      hasLogo: true,
      logoDataUri: null,
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
      customerMobileNumber: "971500000002",
      customerName: "Test Customer",
      customerSecondMobileNumber: "971500000003",
      deliveryInstructions: "Call before arrival",
      deliveryStatus: "assigned_to_driver",
      deliveryStatusLabel: "Assigned to Driver",
      emirateName: "Dubai",
      notes: "Fragile",
      orderNumber: "ORD-9",
      referenceNumber: "REF-9",
      serialNumber: "SER-9",
      serviceFee: "20.00",
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
    expect(html).not.toContain("ORD-9");
    expect(html).toContain("Test Customer");
    expect(html).toContain("971500000002");
    expect(html).toContain("Deira");
    expect(html).toContain("AED 150.00");
    expect(html).not.toContain("AED 20.00");
    expect(html).toContain("Fragile");
    expect(html).toContain("Test Company");
    expect(html).toContain("Delivery operations");
    expect(html).toContain("Test Driver");
    expect(html).toContain("Outsourced");
    expect(html).not.toContain("<th>Customer Address</th>");
    expect(html).not.toContain("Villa 12, Street 4");
    expect(html).not.toContain("<th>Packages</th>");
    expect(html).toContain("<th>Trader</th>");
    expect(html).toContain("Test Trader");
    expect(html).not.toContain("<th>Second Mobile</th>");
    expect(html).toContain("<th>Order Serial Number</th>");
    expect(html).not.toContain("<th>#</th>");
    expect(html).not.toContain("<th>Emirate</th>");
    expect(html).not.toContain("<th>Order Number</th>");
    expect(html).not.toContain("<th>Service Fee</th>");
    expect(html).not.toContain("Total Packages");
    expect(html).toContain("@page { size: A4 portrait;");
    expect(html).toContain("font-size: 12px");
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
    // User-entered Serial, references and amounts are never translated.
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

  /*
   * The manifest summary carries TWO figures and no status breakdown.
   *
   * A manifest is a handover document: it is printed at dispatch, when every
   * Order on it is going out, so the per-status counts were either all zero or a
   * restatement of the Delivery Status column beside them. Total Orders and
   * Total COD are the two figures the Driver and the person handing over
   * actually check against the parcels in hand.
   */
  it("renders Total Orders and Total COD as the only summary figures", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(html).toContain("Total Orders");
    expect(html).toContain("Total COD");
    expect(html).toContain("AED 150.00");
    /* Matched as the rendered summary label rather than as loose text: the word
       "Returned" still belongs on the page, in the "Returned/Received By"
       signature line, and a bare substring check would forbid that too. */
    for (const removed of [
      "Total Packages",
      "Cancelled",
      "Returned",
      "Delivered",
      "Out for Delivery",
      "New",
    ]) {
      expect(html, `${removed} should no longer be a summary figure`).not.toContain(
        `<span>${removed}</span>`,
      );
    }
  });

  it("puts the two summary figures on one line", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    // Side by side rather than stacked, which is what the flex row provides.
    expect(html).toContain(`<div class="summary-row">`);
    expect(html).toContain(".summary-row { display: flex;");
  });

  /*
   * Column widths, which are load-bearing on a printed page.
   *
   * Only columns 1-11 were sized, so COD Amount and Delivery Status silently
   * split the entire remaining width between them -- COD Amount ended up roughly
   * three times wider than the widest amount it can hold, while Customer Mobile
   * wrapped a 10-digit number onto two lines. Nothing failed; it just printed
   * badly. These pin the invariant so adding a column and forgetting its width
   * fails here rather than on the Driver's copy.
   */
  it("sizes every table column and totals exactly 100%", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    const headerCount = (html.match(/<th>/g) ?? []).length;
    const widths = [...html.matchAll(/td:nth-child\((\d+)\) \{ width: (\d+)%/g)].map((match) => ({
      column: Number(match[1]),
      width: Number(match[2]),
    }));

    expect(widths).toHaveLength(headerCount);
    // Every column from 1..n is covered -- no gaps, which is how the last two
    // came to be sharing the leftover.
    expect(widths.map((entry) => entry.column).sort((a, b) => a - b)).toEqual(
      Array.from({ length: headerCount }, (_, index) => index + 1),
    );
    expect(widths.reduce((sum, entry) => sum + entry.width, 0)).toBe(100);
  });

  it("gives Customer Mobile at least as much width as COD Amount", () => {
    // A 10-digit mobile is longer than "AED 9999.00", so the relative order of
    // these two is the point -- it was inverted, and badly.
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    const widthOf = (column: number) =>
      Number(
        new RegExp(`td:nth-child\\(${column}\\) \\{ width: (\\d+)%`).exec(html)?.[1] ?? "0",
      );
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1]);
    const mobileColumn = headers.indexOf("Customer Mobile") + 1;
    const codColumn = headers.indexOf("COD Amount") + 1;

    expect(mobileColumn).toBeGreaterThan(0);
    expect(codColumn).toBeGreaterThan(0);
    expect(widthOf(mobileColumn)).toBeGreaterThanOrEqual(widthOf(codColumn));
  });

  it("prioritizes Trader and Notes space over Customer", () => {
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1]);
    const widthOf = (header: string) => {
      const column = headers.indexOf(header) + 1;
      return Number(
        new RegExp(`td:nth-child\\(${column}\\) \\{ width: (\\d+)%`).exec(html)?.[1] ?? "0",
      );
    };

    expect(widthOf("Trader")).toBeGreaterThan(widthOf("Customer"));
    expect(widthOf("Notes")).toBeGreaterThan(widthOf("Customer"));
  });

  it("prints Notes as the last column, in place of Delivery Status", () => {
    /* The manifest is a handover document: every Order on it is going out, so a
       Delivery Status column read the same on every line and earned nothing.
       The Driver's own note is what belongs in that space. */
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers.at(-1)).toBe("Notes");
    expect(headers).not.toContain("Delivery Status");
    // The value, not just the heading.
    expect(html).toContain("Fragile");
    expect(html).not.toContain("Assigned to Driver");
  });

  it("still leaves out the Delivery Instructions column", () => {
    // Removed earlier and deliberately not brought back with Notes. The data is
    // still supplied by the service; asserted on the VALUE so reinstating the
    // column fails here rather than quietly widening the table again.
    const html = buildDriverShipmentManifestHtml(sample, "en", "now");
    expect(html).not.toContain("<th>Delivery Instructions</th>");
    expect(html).not.toContain("Call before arrival");
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
