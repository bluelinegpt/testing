import { describe, expect, it } from "vitest";

import { isDriverWorkStatus } from "./driver-work-visibility.js";

describe("Driver work visibility", () => {
  it("shows only unfinished delivery work and cash-handover work", () => {
    expect(isDriverWorkStatus({ deliveryStatus: "assigned_to_driver", driverReconciliationStatus: "pending" })).toBe(true);
    expect(isDriverWorkStatus({ deliveryStatus: "out_for_delivery", driverReconciliationStatus: "pending" })).toBe(true);
    expect(isDriverWorkStatus({ deliveryStatus: "delivered", driverReconciliationStatus: "pending" })).toBe(true);
  });

  it("removes delivery work once driver cash is complete", () => {
    for (const driverReconciliationStatus of ["reconciled", "not_applicable"]) {
      expect(isDriverWorkStatus({ deliveryStatus: "delivered", driverReconciliationStatus })).toBe(false);
    }
  });

  it("never treats office-only or finished statuses as Driver work", () => {
    for (const deliveryStatus of ["new", "in_branch", "hold", "returned_to_branch", "returned_to_trader", "cancelled", "closed", "collect_order"]) {
      expect(isDriverWorkStatus({ deliveryStatus, driverReconciliationStatus: "pending" })).toBe(false);
    }
  });
});
