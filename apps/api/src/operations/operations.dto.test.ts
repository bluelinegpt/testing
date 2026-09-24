import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import {
  ChangeOrderStatusDto,
  CreateOrderDto,
  CreateTraderSettlementDto,
  TraderAccountStatementQueryDto,
  UpdateOrderDto,
  ReopenDeliveredOrderDto,
} from "./operations.dto.js";

describe("Trader settlement DTO validation", () => {
  const baseSettlement = {
    allocations: [{ amount: 100, orderId: "10000000-0000-4000-8000-000000000001" }],
    amount: 75,
    cashAccountId: "30000000-0000-4000-8000-000000000001",
    paymentMethod: "cash",
    traderId: "20000000-0000-4000-8000-000000000001",
  };

  it("accepts a valid Trader receivable deduction", async () => {
    const input = plainToInstance(CreateTraderSettlementDto, {
      ...baseSettlement,
      receivableOffsets: [{ amount: 25, receivableId: "40000000-0000-4000-8000-000000000001" }],
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("rejects an invalid or zero Trader receivable deduction", async () => {
    const input = plainToInstance(CreateTraderSettlementDto, {
      ...baseSettlement,
      receivableOffsets: [{ amount: 0, receivableId: "40000000-0000-4000-8000-000000000001" }],
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "receivableOffsets")).toBe(true);
  });
});

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
  it("accepts a Collect Order without Customer, mobile, Emirate, Area, or Driver", async () => {
    const input = plainToInstance(CreateOrderDto, {
      additionalFees: 0,
      codAmount: 0,
      customerAddress: "",
      orderType: "collect_order",
      packageCount: 1,
      serialNumber: "7",
      traderId: "20000000-0000-4000-8000-000000000001",
    });

    await expect(validate(input)).resolves.toEqual([]);
  });

  it("accepts a delivery Order without Customer or mobile", async () => {
    const input = plainToInstance(CreateOrderDto, {
      areaId: "10000000-0000-4000-8000-000000000001",
      codAmount: 100,
      customerAddress: "",
      packageCount: 1,
      serialNumber: "8",
      traderId: "20000000-0000-4000-8000-000000000001",
    });

    await expect(validate(input)).resolves.toEqual([]);
  });

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

  it("rejects caller-supplied PSystem Serial while accepting the user Serial Number", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      psystemSerial: "TST0000001",
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "serialNumber")).toBe(false);
    expect(errors.some((error) => error.property === "psystemSerial")).toBe(true);
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

  it("accepts a supported payment condition when updating an Order", async () => {
    const input = plainToInstance(UpdateOrderDto, {
      paymentCondition: "customer_pays_cod_trader_pays_fee",
    });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "paymentCondition")).toBe(false);
  });

  it("rejects an unsupported payment condition when updating an Order", async () => {
    const input = plainToInstance(UpdateOrderDto, { paymentCondition: "unknown_payer" });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "paymentCondition")).toBe(true);
  });

  it("requires a meaningful reason to reopen a delivered Order", async () => {
    const invalid = await validate(plainToInstance(ReopenDeliveredOrderDto, { reason: "  " }));
    const valid = await validate(
      plainToInstance(ReopenDeliveredOrderDto, { reason: "Customer requested redelivery" }),
    );
    expect(invalid.some((error) => error.property === "reason")).toBe(true);
    expect(valid.some((error) => error.property === "reason")).toBe(false);
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

  /*
   * Customer address is optional everywhere. Deliveries are routinely arranged
   * against a landmark, a dropped pin or a phone call, and the earlier rule
   * produced placeholder text ("n/a", a dot, the Area name again) that read as
   * real data. A new Customer captured this way gets no saved address record
   * rather than an empty one, which is why no `customer_addresses` constraint
   * had to be relaxed.
   */
  it("accepts an Order with no Customer address at all", async () => {
    const { customerAddress: _omitted, ...withoutAddress } = validCreateOrder;
    const errors = await validate(plainToInstance(CreateOrderDto, withoutAddress));
    expect(errors.some((error) => error.property === "customerAddress")).toBe(false);
  });

  it("accepts a blank Customer address on create", async () => {
    const input = plainToInstance(CreateOrderDto, { ...validCreateOrder, customerAddress: "" });
    const errors = await validate(input);
    expect(errors.some((error) => error.property === "customerAddress")).toBe(false);
  });

  it("accepts an inline new Customer with no address", async () => {
    const input = plainToInstance(CreateOrderDto, {
      ...validCreateOrder,
      inlineCustomer: {
        areaId: validCreateOrder.areaId,
        mobileNumber: "971501234567",
        name: "New Buyer",
      },
    });
    const errors = await validate(input);
    expect(errors.find((error) => error.property === "inlineCustomer")).toBeUndefined();
  });

  /*
   * The Trader Account Statement's three boolean flags, as they actually arrive.
   *
   * A query string carries them as the TEXT "true", never as a boolean, and the
   * service tests them with `=== true`. So the whole feature rests on the DTO's
   * `@Type(() => Boolean)` conversion running: if it ever stops, the flags stay
   * strings, every strict comparison is false, and the checkboxes silently do
   * nothing while the request still succeeds. Nothing else would fail.
   */
  it("converts the statement-only flags from query text to real booleans", async () => {
    const input = plainToInstance(TraderAccountStatementQueryDto, {
      language: "en",
      month: "2026-08",
      outstandingOnly: "true",
      paidOnly: "true",
      reversedOnly: "true",
      settlementStatus: "all",
      transactionType: "all",
    });

    await expect(validate(input)).resolves.toEqual([]);
    // Strict identity, matching how the service reads them.
    expect(input.paidOnly).toBe(true);
    expect(input.outstandingOnly).toBe(true);
    expect(input.reversedOnly).toBe(true);
  });

  it("leaves an unticked statement flag absent rather than false", async () => {
    // The web form omits a flag it is not applying. Absent must stay absent:
    // `Boolean("false")` is true, so a flag sent as text "false" would invert.
    const input = plainToInstance(TraderAccountStatementQueryDto, {
      month: "2026-08",
      settlementStatus: "all",
      transactionType: "all",
    });

    await expect(validate(input)).resolves.toEqual([]);
    expect(input.paidOnly).toBeUndefined();
    expect(input.outstandingOnly).toBeUndefined();
    expect(input.reversedOnly).toBeUndefined();
  });

  it("allows an existing Order's Customer address to be cleared", async () => {
    // Clearing a wrong address must be possible; `@MinLength(1)` here used to
    // reject the empty string and leave bad data stuck in place.
    const errors = await validate(plainToInstance(UpdateOrderDto, { customerAddress: "" }));
    expect(errors.some((error) => error.property === "customerAddress")).toBe(false);
  });
});
