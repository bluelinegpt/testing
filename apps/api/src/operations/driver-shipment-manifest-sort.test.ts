import { describe, expect, it } from "vitest";

import { sortForRoute, type ManifestOrderRow } from "./driver-shipment-manifest.service.js";

const row = (referenceNumber: string, areaName: string, emirateOrder: number): ManifestOrderRow => ({
  areaId: `area:${areaName}`,
  areaName,
  areaNameAr: null,
  assignedDriverId: "d",
  amountToCollect: "0.00",
  customerMobileNumber: "",
  customerName: "",
  customerSecondMobileNumber: null,
  deliveryInstructions: null,
  deliveryStatus: "out_for_delivery",
  emirateName: null,
  emirateNameAr: null,
  emirateOrder,
  notes: null,
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
