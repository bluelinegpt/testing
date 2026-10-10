import { HttpStatus } from "@nestjs/common";
import { Decimal } from "decimal.js";

import { ApplicationException } from "../presentation/errors/application.exception.js";

/**
 * Driver Collections: Cash/Visa per Order, zero-collection Orders and
 * Company-pays-Driver (Aiman, 10-11 Oct 2026; spec
 * `claude/driver-collection-mixed-payment-spec.md`, rules R1-R5, R7).
 *
 * Pure rules only -- no database. `driver-cash-reconciliation.service.ts`
 * calls these for both the read-only preview and the locked confirm, so the
 * operator is always shown exactly the numbers that confirm enforces.
 *
 * - Each Order line is Cash or Visa; an Order with nothing to collect (0.00)
 *   is `none` and can never be switched.
 * - A default method applies to every line the operator did not override.
 * - Driver Expenses and the Outsourced Driver Fee Offset come out of CASH
 *   only. Visa money went straight to the bank; the Driver never held it.
 * - Cash net below zero means the Company pays the Driver that amount in
 *   cash (never by transfer).
 */
export type CollectionMethod = "cash" | "visa";
export type LineMethod = CollectionMethod | "none";
export type HeaderMethod = LineMethod | "mixed";

export interface SplitOrder {
  readonly amountCollected: string;
  readonly id: string;
  readonly orderNumber: string;
}

export interface MethodOverride {
  readonly method: CollectionMethod;
  readonly orderId: string;
}

export interface SplitTotals {
  readonly cashCount: number;
  readonly cashGross: Decimal;
  readonly gross: Decimal;
  readonly visaCount: number;
  readonly visaGross: Decimal;
  readonly zeroCount: number;
}

export interface SettlementExpectation {
  /** Cash the Driver hands over (> 0), nothing (0) or, when negative, what the Company pays the Driver. */
  readonly cashNet: Decimal;
  /** |cashNet| when cashNet < 0, else 0. */
  readonly companyPaysDriver: Decimal;
  /** Header net: gross - offset - expenses (= cashNet + visaExpected). */
  readonly net: Decimal;
  readonly visaExpected: Decimal;
}

export interface SplitPayment {
  readonly amount: number | string;
  readonly direction?: "in" | "out";
  readonly paymentMethod?: "bank_transfer" | "cash";
}

function badRequest(code: string, message: string, details?: readonly string[]): ApplicationException {
  return new ApplicationException(code, message, HttpStatus.BAD_REQUEST, details);
}

/** Line method for every selected Order: override ?? default, `none` for 0.00. */
export function resolveLineMethods(
  orders: readonly SplitOrder[],
  defaultMethod: CollectionMethod,
  overrides: readonly MethodOverride[] = [],
): Map<string, LineMethod> {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const overrideById = new Map<string, CollectionMethod>();
  for (const override of overrides) {
    if (overrideById.has(override.orderId)) {
      throw badRequest(
        "reconciliation_method_duplicate_order",
        "Each Order can have only one payment method",
      );
    }
    const order = byId.get(override.orderId);
    if (order === undefined) {
      throw badRequest(
        "reconciliation_method_order_not_selected",
        "A payment method was given for an Order that is not in this collection",
      );
    }
    if (new Decimal(order.amountCollected).isZero()) {
      throw badRequest(
        "reconciliation_method_on_zero_order",
        "An Order with nothing to collect cannot have a payment method",
        [order.orderNumber],
      );
    }
    overrideById.set(override.orderId, override.method);
  }
  const methods = new Map<string, LineMethod>();
  for (const order of orders) {
    methods.set(
      order.id,
      new Decimal(order.amountCollected).isZero()
        ? "none"
        : (overrideById.get(order.id) ?? defaultMethod),
    );
  }
  return methods;
}

export function splitTotals(
  orders: readonly SplitOrder[],
  methods: ReadonlyMap<string, LineMethod>,
): SplitTotals {
  let cashGross = new Decimal(0);
  let visaGross = new Decimal(0);
  let cashCount = 0;
  let visaCount = 0;
  let zeroCount = 0;
  for (const order of orders) {
    const method = methods.get(order.id) ?? "none";
    if (method === "cash") {
      cashGross = cashGross.plus(order.amountCollected);
      cashCount += 1;
    } else if (method === "visa") {
      visaGross = visaGross.plus(order.amountCollected);
      visaCount += 1;
    } else {
      zeroCount += 1;
    }
  }
  return { cashCount, cashGross, gross: cashGross.plus(visaGross), visaCount, visaGross, zeroCount };
}

/** Header method, derived -- never chosen (R7). */
export function deriveHeaderMethod(methods: ReadonlyMap<string, LineMethod>): HeaderMethod {
  const values = new Set(methods.values());
  const hasCash = values.has("cash");
  const hasVisa = values.has("visa");
  if (hasCash && hasVisa) return "mixed";
  if (hasCash) return "cash";
  if (hasVisa) return "visa";
  return "none";
}

/** The amount the Outsourced Driver Fee Offset may never exceed: cash in hand after expenses. */
export function cashAvailableForOffset(cashGross: Decimal, expenseTotal: Decimal): Decimal {
  return Decimal.max(0, cashGross.minus(expenseTotal));
}

export function settlementExpectation(input: {
  readonly cashGross: Decimal;
  readonly expenseTotal: Decimal;
  readonly offset: Decimal;
  readonly visaGross: Decimal;
}): SettlementExpectation {
  const cashNet = input.cashGross.minus(input.expenseTotal).minus(input.offset);
  return {
    cashNet,
    companyPaysDriver: cashNet.isNegative() ? cashNet.abs() : new Decimal(0),
    net: cashNet.plus(input.visaGross),
    visaExpected: input.visaGross,
  };
}

export function signedPaymentTotal(payments: readonly SplitPayment[]): Decimal {
  return payments.reduce(
    (total, payment) =>
      payment.direction === "out" ? total.minus(payment.amount) : total.plus(payment.amount),
    new Decimal(0),
  );
}

/**
 * The payments a confirmable collection must carry (R3-R5). Throws a named
 * 400 for the first rule broken; returns nothing when the payments match.
 *
 * Payment lines say where the money LANDED, not how the customer paid: a
 * Driver may deposit part of a Cash collection by bank transfer, so while the
 * Driver owes money any mix of Cash and Bank Transfer lines is accepted as
 * long as they add up to the net (the rule before 11 Oct 2026, unchanged).
 * New: when expenses exceed the cash collected, the Company pays the Driver --
 * exactly that amount, in cash, as an `out` line -- and the money received
 * must equal the Visa Orders total.
 */
export function assertPaymentsMatchExpectation(
  payments: readonly SplitPayment[],
  expectation: SettlementExpectation,
): void {
  if (payments.some((p) => p.direction === "out" && p.paymentMethod !== "cash")) {
    throw badRequest(
      "reconciliation_payout_cash_only",
      "The Company pays the Driver in cash only, never by transfer",
    );
  }
  const sum = (list: readonly SplitPayment[]) =>
    list.reduce((total, p) => total.plus(p.amount), new Decimal(0));
  const received = payments.filter((p) => p.direction !== "out");
  const paidOut = payments.filter((p) => p.direction === "out");
  const { cashNet, companyPaysDriver, net, visaExpected } = expectation;

  if (!cashNet.isNegative()) {
    if (paidOut.length > 0) {
      throw badRequest(
        "reconciliation_payout_not_allowed",
        "The Driver owes money in this collection, so nothing can be paid to the Driver",
      );
    }
    if (net.isZero() && received.length > 0) {
      throw badRequest(
        "reconciliation_payment_difference",
        "A zero Net Amount Expected must not carry payments",
      );
    }
    if (!sum(received).equals(net)) {
      throw badRequest(
        "reconciliation_payment_difference",
        `Payment total must equal the Net Amount Expected (AED ${net.toFixed(2)})`,
      );
    }
    return;
  }

  if (!sum(paidOut).equals(companyPaysDriver)) {
    throw badRequest(
      "reconciliation_company_payout_required",
      `Record the cash paid to the Driver (AED ${companyPaysDriver.toFixed(2)}), or remove or reduce an expense`,
    );
  }
  if (!sum(received).equals(visaExpected)) {
    throw badRequest(
      "reconciliation_payment_difference",
      `The money received must equal the Visa Orders total (AED ${visaExpected.toFixed(2)})`,
    );
  }
}
