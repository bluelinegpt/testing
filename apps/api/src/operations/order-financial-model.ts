import { Decimal } from "decimal.js";

/**
 * The Order money model, as pure functions.
 *
 * Extracted from OperationsService unchanged so that Order creation, Order
 * editing and Order Maintenance all compute a Trader's position from ONE
 * implementation. They did not before: `repairTraderReceivable` used the raw
 * `service_fee` while every other path used `traderReceivableDue`, which is
 * the fee less whatever the customer's COD already covers. On any Order where
 * COD partly covers the fee those two disagree, and the Trader is billed the
 * wrong amount.
 *
 * Nothing here touches the database or the request. The formulas are the
 * originals, moved verbatim -- `this.money` became `roundMoney` and
 * `this.calculateVatAmount` became a direct call, and nothing else changed.
 */

export interface VatPolicy {
  readonly enabled: boolean;
  readonly priceMode: "exclusive" | "inclusive" | null;
  readonly rate: Decimal;
}

export interface OrderFinancials {
  readonly additionalFees: Decimal;
  readonly additionalFeeVatAmount: Decimal;
  readonly codAmount: Decimal;
  readonly companyRevenue: Decimal;
  readonly customerAmountDue: Decimal;
  readonly orderProfit: Decimal;
  readonly serviceFee: Decimal;
  readonly serviceFeeNetAmount: Decimal;
  readonly serviceFeeVatAmount: Decimal;
  readonly totalDeductions: Decimal;
  readonly traderDeductions: Decimal;
  readonly traderPaidServiceFee: Decimal;
  readonly traderReceivableDue: Decimal;
  readonly traderNetPayable: Decimal;
  readonly vatAmount: Decimal;
}

export function roundMoney(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function calculateVatAmount(serviceFee: Decimal, vatPolicy: VatPolicy): Decimal {
  if (!vatPolicy.enabled || vatPolicy.rate.isZero()) {
    return new Decimal(0);
  }
  if (vatPolicy.priceMode === "inclusive") {
    return roundMoney(serviceFee.mul(vatPolicy.rate).div(new Decimal(100).plus(vatPolicy.rate)));
  }
  return roundMoney(serviceFee.mul(vatPolicy.rate).div(100));
}

export function calculateOrderFinancials(input: {
  readonly additionalFees?: Decimal;
  readonly codAmount: Decimal;
  readonly driverCost: Decimal;
  readonly paymentCondition?: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
  readonly prospective?: boolean;
  readonly serviceFee: Decimal;
  readonly vatPolicy: VatPolicy;
}): OrderFinancials {
  const additionalFeeInput = input.additionalFees ?? new Decimal(0);
  const serviceFeeVatAmount = calculateVatAmount(input.serviceFee, input.vatPolicy);
  const additionalFeeVatAmount = calculateVatAmount(additionalFeeInput, input.vatPolicy);
  const inclusive = input.vatPolicy.enabled && input.vatPolicy.priceMode === "inclusive";
  const serviceFeeNetAmount = inclusive
    ? input.serviceFee.minus(serviceFeeVatAmount)
    : input.serviceFee;
  const additionalFees = inclusive
    ? additionalFeeInput.minus(additionalFeeVatAmount)
    : additionalFeeInput;
  const feeTotal = serviceFeeNetAmount
    .plus(serviceFeeVatAmount)
    .plus(additionalFees)
    .plus(additionalFeeVatAmount);
  const customerPaysFee = input.paymentCondition !== "customer_pays_cod_trader_pays_fee";
  const customerPaidFeeCoveredByCod = customerPaysFee && input.codAmount.greaterThan(0);
  const traderPaidServiceFee = input.prospective
    ? customerPaidFeeCoveredByCod || !customerPaysFee
      ? serviceFeeNetAmount.plus(serviceFeeVatAmount)
      : new Decimal(0)
    : serviceFeeNetAmount.plus(serviceFeeVatAmount);
  const traderDeductions = input.prospective
    ? customerPaidFeeCoveredByCod || !customerPaysFee
      ? additionalFees.plus(additionalFeeVatAmount)
      : new Decimal(0)
    : additionalFees.plus(additionalFeeVatAmount);
  const totalDeductions = traderPaidServiceFee.plus(traderDeductions);
  const vatAmount = input.prospective
    ? serviceFeeVatAmount.plus(additionalFeeVatAmount)
    : serviceFeeVatAmount;
  const companyRevenue = input.prospective
    ? serviceFeeNetAmount.plus(additionalFees)
    : serviceFeeNetAmount;
  const customerAmountDue = input.prospective
    ? customerPaysFee
      ? input.codAmount.greaterThan(0)
        ? input.codAmount
        : feeTotal
      : input.codAmount
    : input.vatPolicy.enabled && input.vatPolicy.priceMode === "exclusive"
      ? input.codAmount.plus(input.serviceFee).plus(serviceFeeVatAmount)
      : input.codAmount.plus(input.serviceFee);
  const signedTraderPosition = input.codAmount.minus(totalDeductions);
  const traderNetPayable = input.prospective
    ? Decimal.max(signedTraderPosition, 0)
    : Decimal.max(input.codAmount.minus(input.serviceFee), 0);
  // A Trader receivable is required both when creating an Order and when an
  // edit changes the payment condition to "Trader pays fee". Previously the
  // `prospective` guard made every edit calculate AED 0 here, so the update
  // path never created the receivable even though the fee remained payable.
  const traderReceivableDue = !customerPaysFee
    ? Decimal.max(signedTraderPosition.negated(), 0)
    : new Decimal(0);
  return {
    additionalFees: roundMoney(additionalFees),
    additionalFeeVatAmount: roundMoney(additionalFeeVatAmount),
    codAmount: roundMoney(input.codAmount),
    companyRevenue: roundMoney(companyRevenue),
    customerAmountDue: roundMoney(customerAmountDue),
    orderProfit: roundMoney(Decimal.max(companyRevenue.minus(input.driverCost), 0)),
    serviceFee: roundMoney(input.serviceFee),
    serviceFeeNetAmount: roundMoney(serviceFeeNetAmount),
    serviceFeeVatAmount: roundMoney(serviceFeeVatAmount),
    totalDeductions: roundMoney(totalDeductions),
    traderDeductions: roundMoney(traderDeductions),
    traderPaidServiceFee: roundMoney(traderPaidServiceFee),
    traderReceivableDue: roundMoney(traderReceivableDue),
    traderNetPayable: roundMoney(traderNetPayable),
    vatAmount: roundMoney(vatAmount),
  };
}
