import "reflect-metadata";

import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  CalculateEmployeeDriverEarningPeriodDto,
  ReconcileEmployeeDriverEarningsDto,
  SaveOutsourcedCollectionRuleDto,
} from "./driver-earnings.dto.js";

describe("outsourced Driver collection earning DTO", () => {
  const rule = (collectionPaymentType: string, amount: number) =>
    Object.assign(new SaveOutsourcedCollectionRuleDto(), {
      amount,
      collectionPaymentType,
      effectiveFrom: "2026-08-08",
    });

  it("accepts None and Per Collected Order", async () => {
    await expect(validate(rule("none", 0))).resolves.toEqual([]);
    await expect(validate(rule("per_collected_order", 1))).resolves.toEqual([]);
  });

  it("rejects new legacy flat collection rules", async () => {
    const errors = await validate(rule("flat_per_confirmed_collection", 5));
    expect(errors.map((error) => error.property)).toContain("collectionPaymentType");
  });
});

describe("Employee Driver earning reconciliation DTO", () => {
  it("requires a Driver and a valid date range shape", async () => {
    const valid = Object.assign(new ReconcileEmployeeDriverEarningsDto(), {
      driverId: "10000000-0000-4000-8000-000000000001",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-12",
    });
    await expect(validate(valid)).resolves.toEqual([]);
    const invalid = Object.assign(new ReconcileEmployeeDriverEarningsDto(), {
      driverId: "Kareem",
      dateFrom: "August",
      dateTo: "2026-08-12",
    });
    expect((await validate(invalid)).map((error) => error.property)).toEqual(
      expect.arrayContaining(["driverId", "dateFrom"]),
    );
  });
  it("accepts zero manual collections and rejects negative or fractional counts", async () => {
    const period = (count: number) =>
      Object.assign(new CalculateEmployeeDriverEarningPeriodDto(), {
        collectedOrderCount: count,
        driverId: "10000000-0000-4000-8000-000000000001",
        dateFrom: "2026-08-01",
        dateTo: "2026-08-15",
      });
    await expect(validate(period(0))).resolves.toEqual([]);
    expect((await validate(period(-1))).map((error) => error.property)).toContain(
      "collectedOrderCount",
    );
    expect((await validate(period(1.5))).map((error) => error.property)).toContain(
      "collectedOrderCount",
    );
  });
});
