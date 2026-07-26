import { vi } from "vitest";

import {
  buildDriverCollectionPrintDocument,
  type DriverCollectionPrintData,
  type DriverCollectionPrintLabels,
} from "./driver-collection-print.js";

const labels: DriverCollectionPrintLabels = {
  actualReceived: "Actual received",
  address: "Address",
  amountToCollect: "Amount to collect",
  area: "Area",
  cash: "Cash",
  collectionDate: "Collection date",
  collectionNumber: "Collection number",
  companyFees: "Company fees",
  companyReceiverSignature: "Company receiver signature",
  customer: "Customer",
  difference: "Difference",
  driver: "Driver",
  driverExpenses: "Driver expenses",
  driverSignature: "Driver signature",
  grossCustomerCollections: "Gross customer collections",
  mobile: "Mobile",
  netExpected: "Net expected from driver",
  notes: "Notes",
  numberOfOrders: "Number of orders",
  orderStatus: "Order status",
  paymentMethod: "Payment method",
  referenceNumber: "Reference number",
  serialNumber: "Serial number",
  signatureDate: "Date",
  title: "Driver collection",
  totalOrders: "Total orders",
  totalTraders: "Total traders",
  trader: "Trader",
  traderPayable: "Trader payable",
  visa: "Visa",
};

const data: DriverCollectionPrintData = {
  actualReceived: "430.00",
  businessDate: "2026-07-27",
  companyName: "BlueLine Co",
  difference: "0.00",
  driverExpenses: "20.00",
  driverName: "Ali Driver",
  gross: "450.00",
  netExpected: "430.00",
  paymentMethod: "visa",
  reconciliationNumber: "REC-000007",
  totalOrders: 3,
  totalTraders: 2,
  traders: [
    {
      companyFees: "30.00",
      gross: "350.00",
      orderCount: 2,
      traderName: "تاجر الأول",
      traderPayable: "320.00",
      orders: [
        {
          address: "Deira, Dubai",
          amountToCollect: "175.00",
          areaNameAr: "ديرة",
          companyFees: "15.00",
          customerMobile: "971501112233",
          customerName: "Aisha",
          notes: "call first",
          referenceNumber: "REF-000010",
          serialNumber: "000001",
          status: "delivered",
          traderPayable: "160.00",
        },
        {
          address: "Jumeirah, Dubai",
          amountToCollect: "175.00",
          areaNameAr: "الجميرا",
          companyFees: "15.00",
          customerMobile: "971502223344",
          customerName: "Omar",
          notes: null,
          referenceNumber: null,
          serialNumber: "000002",
          status: "delivered",
          traderPayable: "160.00",
        },
      ],
    },
    {
      companyFees: "20.00",
      gross: "100.00",
      orderCount: 1,
      traderName: "تاجر الثاني",
      traderPayable: "80.00",
      orders: [
        {
          address: "Sharjah",
          amountToCollect: "100.00",
          areaNameAr: "الشارقة",
          companyFees: "20.00",
          customerMobile: "971503334455",
          customerName: "Sara",
          notes: null,
          referenceNumber: null,
          serialNumber: "000003",
          status: "delivered",
          traderPayable: "80.00",
        },
      ],
    },
  ],
};

describe("driver collection print document", () => {
  const html = buildDriverCollectionPrintDocument(data, labels);
  const traderSections = html.split('class="trader-page"');

  it("renders one page per trader with page breaks and never mixes traders", () => {
    // split leaves one leading chunk before the first section, so sections = traders + 1.
    expect(traderSections.length - 1).toBe(data.traders.length);
    expect(html).toContain("page-break-after: always"); // each trader page breaks
    expect(html).toContain("page-break-before: always"); // summary starts on its own page

    // Section 1 (first trader) has its serials only; section 2 (second trader) has its own only.
    const firstTrader = traderSections[1] ?? "";
    const secondTrader = traderSections[2] ?? "";
    expect(firstTrader).toContain("000001");
    expect(firstTrader).toContain("000002");
    expect(firstTrader).not.toContain("000003");
    expect(secondTrader).toContain("000003");
    expect(secondTrader).not.toContain("000001");
  });

  it("repeats the company/driver/collection/trader header on every trader page", () => {
    const companyCount = html.split("BlueLine Co").length - 1;
    const collectionCount = html.split("REC-000007").length - 1;
    expect(companyCount).toBeGreaterThanOrEqual(data.traders.length);
    expect(collectionCount).toBeGreaterThanOrEqual(data.traders.length);
    expect(html).toContain("تاجر الأول");
    expect(html).toContain("تاجر الثاني");
  });

  it("shows correct per-trader totals and the final collection summary", () => {
    expect(html).toContain("AED 320.00"); // trader 1 payable total
    expect(html).toContain("AED 80.00"); // trader 2 payable total
    // Summary figures.
    expect(html).toContain("AED 450.00"); // gross
    expect(html).toContain("AED 20.00"); // expenses
    expect(html).toContain("AED 430.00"); // net + actual
    expect(html).toContain("AED 0.00"); // difference
    expect(html).toContain("Total traders");
    expect(html).toContain("Total orders");
  });

  it("labels the payment method, renders Arabic area text, and includes signatures", () => {
    expect(html).toContain("Visa"); // method label (visa collection)
    expect(html).not.toContain(">Cash<");
    expect(html).toContain("ديرة"); // Arabic area
    expect(html).toContain("الشارقة");
    expect(html).toContain("Driver signature");
    expect(html).toContain("Company receiver signature");
  });

  it("preserves leading zeros in identifiers and shows no internal UUIDs", () => {
    expect(html).toContain("000001");
    expect(html).toContain("REC-000007");
    // A v4 UUID pattern must not appear anywhere in the document.
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  it("is pure — building the document performs no network/mutation call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network call during print generation");
    });
    expect(() => buildDriverCollectionPrintDocument(data, labels)).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
