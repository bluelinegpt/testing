import "reflect-metadata";
import {
  createBusinessDayServiceStub,
  createCalendarDateReportModeServiceStub,
} from "../test/business-day-stubs.js";

import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { calculateOrderFinancials } from "./order-financial-model.js";
import { OperationsService } from "./operations.service.js";

type FinancialResult = Readonly<
  Record<
    | "additionalFees"
    | "additionalFeeVatAmount"
    | "companyRevenue"
    | "customerAmountDue"
    | "serviceFeeNetAmount"
    | "serviceFeeVatAmount"
    | "totalDeductions"
    | "traderDeductions"
    | "traderPaidServiceFee"
    | "traderReceivableDue"
    | "traderNetPayable"
    | "vatAmount",
    Decimal
  >
>;

type FinancialCalculator = {
  calculateOrderFinancials(input: {
    additionalFees: Decimal;
    codAmount: Decimal;
    driverCost: Decimal;
    paymentCondition?: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
    prospective: boolean;
    serviceFee: Decimal;
    vatPolicy: {
      enabled: boolean;
      priceMode: "exclusive" | "inclusive" | null;
      rate: Decimal;
    };
  }): FinancialResult;
};

const service = new OperationsService(
  undefined as never,
  undefined as never,
  undefined as never,
  // Real stubs rather than `undefined as never`: these two are called on
  // every list path. This suite only exercises the pure financial model, but
  // an inert value here would throw the moment that changed.
  createCalendarDateReportModeServiceStub(),
  createBusinessDayServiceStub(),
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
  undefined as never,
) as unknown as FinancialCalculator;

describe("prospective Order financial model", () => {
  it("keeps the Customer amount equal to COD and deducts exclusive VAT components", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(5),
      codAmount: new Decimal(100),
      driverCost: new Decimal(0),
      prospective: true,
      serviceFee: new Decimal(10),
      vatPolicy: {
        enabled: true,
        priceMode: "exclusive",
        rate: new Decimal(5),
      },
    });

    expect(result.customerAmountDue.toFixed(2)).toBe("100.00");
    expect(result.serviceFeeNetAmount.toFixed(2)).toBe("10.00");
    expect(result.serviceFeeVatAmount.toFixed(2)).toBe("0.50");
    expect(result.additionalFees.toFixed(2)).toBe("5.00");
    expect(result.additionalFeeVatAmount.toFixed(2)).toBe("0.25");
    expect(result.vatAmount.toFixed(2)).toBe("0.75");
    expect(result.totalDeductions.toFixed(2)).toBe("15.75");
    expect(result.traderNetPayable.toFixed(2)).toBe("84.25");
  });

  it("separates VAT from VAT-inclusive fees without double deducting it", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(5),
      codAmount: new Decimal(100),
      driverCost: new Decimal(0),
      prospective: true,
      serviceFee: new Decimal(10),
      vatPolicy: {
        enabled: true,
        priceMode: "inclusive",
        rate: new Decimal(5),
      },
    });

    expect(result.serviceFeeNetAmount.toFixed(2)).toBe("9.52");
    expect(result.serviceFeeVatAmount.toFixed(2)).toBe("0.48");
    expect(result.additionalFees.toFixed(2)).toBe("4.76");
    expect(result.additionalFeeVatAmount.toFixed(2)).toBe("0.24");
    expect(result.totalDeductions.toFixed(2)).toBe("15.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("85.00");
  });

  it("moves a Trader-paid fee excess into a receivable instead of negative settlement", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(0),
      codAmount: new Decimal(0),
      driverCost: new Decimal(0),
      paymentCondition: "customer_pays_cod_trader_pays_fee",
      prospective: true,
      serviceFee: new Decimal(20),
      vatPolicy: {
        enabled: false,
        priceMode: null,
        rate: new Decimal(0),
      },
    });
    expect(result.customerAmountDue.toFixed(2)).toBe("0.00");
    expect(result.companyRevenue.toFixed(2)).toBe("20.00");
    expect(result.totalDeductions.toFixed(2)).toBe("20.00");
    expect(result.traderPaidServiceFee.toFixed(2)).toBe("20.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("0.00");
    expect(result.traderReceivableDue.toFixed(2)).toBe("20.00");
  });

  it("keeps COD collectible when the Trader pays the delivery fee", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(0),
      codAmount: new Decimal(105),
      driverCost: new Decimal(0),
      paymentCondition: "customer_pays_cod_trader_pays_fee",
      prospective: true,
      serviceFee: new Decimal(25),
      vatPolicy: {
        enabled: false,
        priceMode: null,
        rate: new Decimal(0),
      },
    });

    expect(result.customerAmountDue.toFixed(2)).toBe("105.00");
    expect(result.totalDeductions.toFixed(2)).toBe("25.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("80.00");
    expect(result.traderReceivableDue.toFixed(2)).toBe("0.00");
  });

  it("collects the service fee from the Customer when the Customer pays COD and fee", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(0),
      codAmount: new Decimal(0),
      driverCost: new Decimal(0),
      paymentCondition: "customer_pays_cod_and_fee",
      prospective: true,
      serviceFee: new Decimal(25),
      vatPolicy: {
        enabled: false,
        priceMode: null,
        rate: new Decimal(0),
      },
    });

    expect(result.customerAmountDue.toFixed(2)).toBe("25.00");
    expect(result.companyRevenue.toFixed(2)).toBe("25.00");
    expect(result.totalDeductions.toFixed(2)).toBe("0.00");
    expect(result.traderPaidServiceFee.toFixed(2)).toBe("0.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("0.00");
    expect(result.traderReceivableDue.toFixed(2)).toBe("0.00");
  });

  it("deducts customer-paid fees from COD when COD covers the fee", () => {
    const result = service.calculateOrderFinancials({
      additionalFees: new Decimal(0),
      codAmount: new Decimal(250),
      driverCost: new Decimal(0),
      paymentCondition: "customer_pays_cod_and_fee",
      prospective: true,
      serviceFee: new Decimal(10),
      vatPolicy: {
        enabled: false,
        priceMode: null,
        rate: new Decimal(0),
      },
    });

    expect(result.customerAmountDue.toFixed(2)).toBe("250.00");
    expect(result.companyRevenue.toFixed(2)).toBe("10.00");
    expect(result.totalDeductions.toFixed(2)).toBe("10.00");
    expect(result.traderPaidServiceFee.toFixed(2)).toBe("10.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("240.00");
    expect(result.traderReceivableDue.toFixed(2)).toBe("0.00");
  });
});

describe("COD shortfall charged to the Trader (per Company switch)", () => {
  const noVat = { enabled: false, priceMode: null, rate: new Decimal(0) };
  const payByCustomer = (codAmount: number, traderPaysCodShortfall: boolean) =>
    calculateOrderFinancials({
      additionalFees: new Decimal(0),
      codAmount: new Decimal(codAmount),
      driverCost: new Decimal(0),
      paymentCondition: "customer_pays_cod_and_fee",
      prospective: true,
      serviceFee: new Decimal(20),
      traderPaysCodShortfall,
      vatPolicy: noVat,
    });

  it("charges the Trader fee - COD when COD is above 0 but below the fee (ORD-000023: 1 vs 20)", () => {
    const result = payByCustomer(1, true);
    expect(result.customerAmountDue.toFixed(2)).toBe("1.00");
    expect(result.traderNetPayable.toFixed(2)).toBe("0.00");
    expect(result.traderReceivableDue.toFixed(2)).toBe("19.00");
  });

  it("charges nothing when the switch is off (every other Company)", () => {
    expect(payByCustomer(1, false).traderReceivableDue.toFixed(2)).toBe("0.00");
  });

  it("leaves COD 0 to the customer, and a COD that covers the fee to the Trader's payout", () => {
    const codZero = payByCustomer(0, true);
    expect(codZero.customerAmountDue.toFixed(2)).toBe("20.00");
    expect(codZero.traderReceivableDue.toFixed(2)).toBe("0.00");
    const covered = payByCustomer(500, true);
    expect(covered.traderNetPayable.toFixed(2)).toBe("480.00");
    expect(covered.traderReceivableDue.toFixed(2)).toBe("0.00");
  });
});
