import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { ChangeOrderStatusDto, CreateOrderDto, UpdateOrderDto } from "./operations.dto.js";

const validCreateOrder = {
  areaId: "10000000-0000-4000-8000-000000000001",
  codAmount: 100,
  customerAddress: "Dubai",
  customerMobileNumber: "971501234567",
  customerName: "Customer",
  serialNumber: "000123",
  traderId: "20000000-0000-4000-8000-000000000001",
};

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

  it("rejects a decimal Package count when creating an Order", async () => {
    const input = plainToInstance(CreateOrderDto, { ...validCreateOrder, packageCount: 1.5 });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "packageCount")).toBe(true);
  });

  it("accepts an integer Package count when creating an Order", async () => {
    const input = plainToInstance(CreateOrderDto, { ...validCreateOrder, packageCount: 3 });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "packageCount")).toBe(false);
  });

  it("rejects a decimal Package count when updating an Order", async () => {
    const input = plainToInstance(UpdateOrderDto, { packageCount: 2.5 });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "packageCount")).toBe(true);
  });

  it("accepts an integer Package count when updating an Order", async () => {
    const input = plainToInstance(UpdateOrderDto, { packageCount: 5 });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "packageCount")).toBe(false);
  });

  it("accepts an unconventional Customer mobile on the Create Order path (advisory only)", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerMobileNumber: "555-1234",
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(false);
    // Non-UAE text is preserved trimmed, not blanked or normalized.
    expect(input.customerMobileNumber).toBe("555-1234");
  });

  it.each([
    "0506468442",
    "971506468442",
    "+971 50 646 8442",
    "+44 7700 900123",
    "00962 79 123 4567",
    "050 646 8442",
  ])("accepts and preserves the exact Customer mobile %s (no normalization)", async (value) => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerMobileNumber: value,
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(false);
    // Stored exactly as entered (trimmed only) — never folded to canonical form.
    expect(input.customerMobileNumber).toBe(value.trim());
  });

  it("still rejects an empty Customer mobile on the Create Order path", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerMobileNumber: "   ",
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(true);
  });

  it("rejects a Customer mobile exceeding the safe maximum length", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerMobileNumber: "9".repeat(33),
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(true);
  });

  it("rejects a Customer mobile containing control characters", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerMobileNumber: `05012${String.fromCharCode(9)}34567`,
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(true);
  });

  it("accepts an inline new Customer with an international mobile at the DTO layer", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      customerId: undefined,
      inlineCustomer: {
        address: "Villa 9",
        areaId: validCreateOrder.areaId,
        mobileNumber: "+44 7700 900123",
        name: "New Buyer",
      },
    });
    const errors = await validate(input);
    expect(errors.find((error) => error.property === "inlineCustomer")).toBeUndefined();
  });

  it("keeps strict UAE mobile validation on the Order edit (Update) path", async () => {
    const input = plainToInstance(UpdateOrderDto, { customerMobileNumber: "555-1234" });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerMobileNumber")).toBe(true);
  });
});
