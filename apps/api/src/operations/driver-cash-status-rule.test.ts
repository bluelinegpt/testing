import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { driverCashStatusAfterStatusChange, isDeliveredFreeNoValue } from "./driver-cash-status-rule.js";

const base = {
  assignedDriverId: "driver-1",
  currentDriverReconciliationStatus: "not_applicable",
  customerAmountDue: 100,
  isFreeOrder: false,
  status: "delivered",
  traderNetPayable: 80,
} as const;

describe("Driver Cash Status after a delivery status change (Option A, 10 Oct 2026)", () => {
  it("makes an ordinary delivered COD Order pending", () => {
    expect(driverCashStatusAfterStatusChange(base)).toBe("pending");
  });

  it("makes a delivered COD-0, Trader-pays-fee Order pending so it reaches Driver Collections", () => {
    expect(
      driverCashStatusAfterStatusChange({ ...base, customerAmountDue: 0, traderNetPayable: 0 }),
    ).toBe("pending");
  });

  it("keeps an explicit no-value Free Order not_applicable (14 Aug 2026 repair rule)", () => {
    const free = { ...base, customerAmountDue: 0, isFreeOrder: true, traderNetPayable: 0 };
    expect(isDeliveredFreeNoValue(free)).toBe(true);
    expect(driverCashStatusAfterStatusChange(free)).toBe("not_applicable");
  });

  it("still collects a Free Order that has money due from the customer", () => {
    expect(
      driverCashStatusAfterStatusChange({ ...base, customerAmountDue: 25, isFreeOrder: true, traderNetPayable: 0 }),
    ).toBe("pending");
  });

  it("leaves a delivered Order without a Driver not_applicable", () => {
    expect(driverCashStatusAfterStatusChange({ ...base, assignedDriverId: null })).toBe("not_applicable");
    expect(
      driverCashStatusAfterStatusChange({ ...base, assignedDriverId: null, customerAmountDue: 0 }),
    ).toBe("not_applicable");
  });

  it("keeps the current status on hold and closed", () => {
    for (const status of ["hold", "closed"]) {
      for (const current of ["pending", "reconciled", "not_applicable"]) {
        expect(
          driverCashStatusAfterStatusChange({ ...base, currentDriverReconciliationStatus: current, status }),
        ).toBe(current);
      }
    }
  });

  it("is not_applicable for every non-delivered status", () => {
    for (const status of [
      "new",
      "in_branch",
      "assigned_to_driver",
      "out_for_delivery",
      "returned_to_branch",
      "returned_to_trader",
      "cancelled",
    ]) {
      expect(driverCashStatusAfterStatusChange({ ...base, status })).toBe("not_applicable");
      expect(driverCashStatusAfterStatusChange({ ...base, customerAmountDue: 0, status })).toBe(
        "not_applicable",
      );
    }
  });

  it("never treats a non-numeric amount as collectable", () => {
    expect(driverCashStatusAfterStatusChange({ ...base, customerAmountDue: Number.NaN })).toBe(
      "not_applicable",
    );
  });
});

describe("Both delivery paths use the shared rule", () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), "src/operations", file), "utf8");

  it.each(["operations.service.ts", "orders-workflow.service.ts"])(
    "%s computes the Driver Cash Status with driverCashStatusAfterStatusChange",
    (file) => {
      const source = read(file);
      expect(source).toContain('from "./driver-cash-status-rule.js"');
      expect(source).toContain("const reconciliationStatus = driverCashStatusAfterStatusChange({");
      // The old inline gate that kept COD-0 deliveries out of collections is gone.
      expect(source).not.toMatch(/order\.assignedDriverId !== null &&\s*amountDue > 0 &&/);
    },
  );
});
