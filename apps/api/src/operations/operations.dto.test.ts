import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { ChangeOrderStatusDto, CreateOrderDto } from "./operations.dto.js";

describe("Order DTO validation", () => {
  it("accepts Hold as an Order delivery status", async () => {
    const input = plainToInstance(ChangeOrderStatusDto, {
      reason: "Customer requested a later delivery",
      status: "hold",
    });

    await expect(validate(input)).resolves.toEqual([]);
  });

  it("keeps Serial Number mandatory while allowing an omitted Reference Number", async () => {
    const input = plainToInstance(CreateOrderDto, {
      areaId: "10000000-0000-4000-8000-000000000001",
      codAmount: 100,
      customerAddress: "Dubai",
      customerMobileNumber: "971501234567",
      customerName: "Customer",
      serialNumber: "000123",
      traderId: "20000000-0000-4000-8000-000000000001",
    });

    const errors = await validate(input);
    expect(errors.some((error) => error.property === "referenceNumber")).toBe(false);
    expect(errors.some((error) => error.property === "serialNumber")).toBe(false);
  });

  it("converts a whitespace-only Reference Number to an omitted value", async () => {
    const input = plainToInstance(CreateOrderDto, {
      areaId: "10000000-0000-4000-8000-000000000001",
      codAmount: 100,
      customerAddress: "Dubai",
      customerMobileNumber: "971501234567",
      customerName: "Customer",
      referenceNumber: "   ",
      serialNumber: "SER-1",
      traderId: "20000000-0000-4000-8000-000000000001",
    });

    const errors = await validate(input);
    expect(errors.some((error) => error.property === "referenceNumber")).toBe(false);
    expect(input.referenceNumber).toBeUndefined();
  });
});
