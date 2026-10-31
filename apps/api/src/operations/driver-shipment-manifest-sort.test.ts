import { describe, expect, it } from "vitest";

import { sortForRoute, sortManifest, type ManifestOrderRow } from "./driver-shipment-manifest.service.js";

const row = (
  referenceNumber: string,
  areaName: string,
  emirateOrder: number,
  orderDate: string | null = "2026-10-31",
): ManifestOrderRow => ({
  areaId: `area:${areaName}`,
  areaName,
  areaNameAr: null,
  assignedDriverId: "d",
  amountToCollect: "0.00", packageCount: 1,
  customerMobileNumber: "",
  customerName: "",
  customerSecondMobileNumber: null,
  deliveryInstructions: null,
  deliveryStatus: "out_for_delivery",
  emirateName: null,
  emirateNameAr: null,
  emirateOrder,
  notes: null,
  orderDate,
  orderNumber: `ORD-${referenceNumber}`,
  referenceNumber,
  serialNumber: null,
  serviceFee: "0.00",
  traderName: "",
  traderNameAr: null,
});

describe("sortForRoute (Driver Shipment Manifest order)", () => {
  it("groups by Emirate, then Area, then Reference Number (numeric)", () => {
    const sorted = sortForRoute([
      row("5233", "Jebel Ali", 2),
      row("900", "Al Nahda", 3),
      row("4216", "Jebel Ali", 2),
      row("10", "Al Barsha 1", 2),
      row("9", "Al Barsha 1", 2),
    ]);
    expect(sorted.map((r) => r.referenceNumber)).toEqual(["9", "10", "4216", "5233", "900"]);
  });
});

describe("sortManifest (the order chosen when printing)", () => {
  const rows = [
    row("6803", "Hili", 7, "2026-10-30"),
    row("6391", "Al Mutarad", 7, "2026-10-31"),
    row("6398", "Al Towayya", 7, "2026-10-30"),
    row("6345", "Seih Al Sidd", 8, "2026-10-31"),
    row("", "Al Jimi", 7, "2026-10-29"),
  ];
  it("sorts by Reference Number by default, no Reference last", () => {
    expect(sortManifest(rows).map((r) => r.referenceNumber)).toEqual(["6345", "6391", "6398", "6803", ""]);
  });
  it("sorts by Order Date, then Reference", () => {
    expect(sortManifest(rows, "date").map((r) => r.referenceNumber)).toEqual(["", "6398", "6803", "6345", "6391"]);
  });
  it("keeps the Emirate then Area route order", () => {
    expect(sortManifest(rows, "emirate_area").map((r) => r.referenceNumber)).toEqual(["", "6391", "6398", "6803", "6345"]);
  });
});
