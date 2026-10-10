import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  assertPaymentsMatchExpectation,
  cashAvailableForOffset,
  deriveHeaderMethod,
  resolveLineMethods,
  settlementExpectation,
  signedPaymentTotal,
  splitTotals,
  type SplitOrder,
} from "./driver-collection-split.js";

/** Spec E-cases (claude/driver-collection-mixed-payment-spec.md, section 8). */
const order = (id: string, amount: string): SplitOrder => ({
  amountCollected: amount,
  id,
  orderNumber: `ORD-${id}`,
});
const orders = [order("a", "30.00"), order("b", "267.00"), order("c", "0.00"), order("d", "145.00")];

const code = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { errorCode?: string }).errorCode ?? String(error);
  }
};

describe("resolveLineMethods", () => {
  it("applies the default to every Order with money and `none` to an Order with nothing to collect", () => {
    const methods = resolveLineMethods(orders, "cash");
    expect([...methods.values()]).toEqual(["cash", "cash", "none", "cash"]);
  });

  it("applies per-Order overrides on top of the default", () => {
    const methods = resolveLineMethods(orders, "cash", [{ method: "visa", orderId: "b" }]);
    expect(methods.get("b")).toBe("visa");
    expect(methods.get("a")).toBe("cash");
  });

  it("refuses a method on a zero-collection Order (E8)", () => {
    expect(code(() => resolveLineMethods(orders, "cash", [{ method: "visa", orderId: "c" }]))).toMatch(
      /reconciliation_method_on_zero_order/,
    );
  });

  it("refuses an override for an Order outside the selection, and duplicates", () => {
    expect(code(() => resolveLineMethods(orders, "cash", [{ method: "visa", orderId: "zz" }]))).toMatch(
      /reconciliation_method_order_not_selected/,
    );
    expect(
      code(() =>
        resolveLineMethods(orders, "cash", [
          { method: "visa", orderId: "a" },
          { method: "cash", orderId: "a" },
        ]),
      ),
    ).toMatch(/reconciliation_method_duplicate_order/);
  });
});

describe("splitTotals and deriveHeaderMethod", () => {
  it("splits Cash, Visa and zero Orders (E3)", () => {
    const methods = resolveLineMethods(orders, "cash", [{ method: "visa", orderId: "b" }]);
    const split = splitTotals(orders, methods);
    expect(split.cashGross.toFixed(2)).toBe("175.00");
    expect(split.visaGross.toFixed(2)).toBe("267.00");
    expect(split.gross.toFixed(2)).toBe("442.00");
    expect([split.cashCount, split.visaCount, split.zeroCount]).toEqual([2, 1, 1]);
    expect(deriveHeaderMethod(methods)).toBe("mixed");
  });

  it("derives cash, visa and none headers", () => {
    expect(deriveHeaderMethod(resolveLineMethods(orders, "cash"))).toBe("cash");
    expect(deriveHeaderMethod(resolveLineMethods(orders, "visa"))).toBe("visa");
    expect(deriveHeaderMethod(resolveLineMethods([order("z", "0.00")], "cash"))).toBe("none");
  });
});

describe("settlementExpectation", () => {
  it("takes expenses and the offset from cash only; Visa goes to the bank in full (E5)", () => {
    const expectation = settlementExpectation({
      cashGross: new Decimal(100),
      expenseTotal: new Decimal(30),
      offset: new Decimal(70),
      visaGross: new Decimal(267),
    });
    expect(expectation.cashNet.toFixed(2)).toBe("0.00");
    expect(expectation.visaExpected.toFixed(2)).toBe("267.00");
    expect(expectation.net.toFixed(2)).toBe("267.00");
    expect(expectation.companyPaysDriver.toFixed(2)).toBe("0.00");
  });

  it("caps the offset at the cash left after expenses, never below zero (E4, E5)", () => {
    expect(cashAvailableForOffset(new Decimal(100), new Decimal(30)).toFixed(2)).toBe("70.00");
    expect(cashAvailableForOffset(new Decimal(0), new Decimal(40)).toFixed(2)).toBe("0.00");
  });

  it("turns expenses above the cash into a Company-pays-Driver amount (E4)", () => {
    const expectation = settlementExpectation({
      cashGross: new Decimal(0),
      expenseTotal: new Decimal(40),
      offset: new Decimal(0),
      visaGross: new Decimal(67),
    });
    expect(expectation.cashNet.toFixed(2)).toBe("-40.00");
    expect(expectation.companyPaysDriver.toFixed(2)).toBe("40.00");
    expect(expectation.net.toFixed(2)).toBe("27.00");
  });
});

describe("assertPaymentsMatchExpectation", () => {
  const owes337 = settlementExpectation({
    cashGross: new Decimal(200),
    expenseTotal: new Decimal(40),
    offset: new Decimal(90),
    visaGross: new Decimal(267),
  });

  it("accepts cash 70 in and Visa 267 in, and signs the total correctly", () => {
    const payments = [
      { amount: 70, paymentMethod: "cash" as const },
      { amount: 267, paymentMethod: "bank_transfer" as const },
    ];
    expect(() => assertPaymentsMatchExpectation(payments, owes337)).not.toThrow();
    expect(signedPaymentTotal(payments).toFixed(2)).toBe("337.00");
  });

  it("still lets a Driver deposit part of the cash by bank transfer (unchanged rule)", () => {
    const cashOnly = settlementExpectation({
      cashGross: new Decimal(90),
      expenseTotal: new Decimal(0),
      offset: new Decimal(0),
      visaGross: new Decimal(0),
    });
    expect(() =>
      assertPaymentsMatchExpectation(
        [
          { amount: 40, paymentMethod: "cash" },
          { amount: 50, paymentMethod: "bank_transfer" },
        ],
        cashOnly,
      ),
    ).not.toThrow();
  });

  it("refuses payments that do not add up to the net, or no payment at all", () => {
    expect(
      code(() =>
        assertPaymentsMatchExpectation(
          [
            { amount: 70, paymentMethod: "cash" },
            { amount: 257, paymentMethod: "bank_transfer" },
          ],
          owes337,
        ),
      ),
    ).toBe("reconciliation_payment_difference");
    expect(code(() => assertPaymentsMatchExpectation([], owes337))).toBe(
      "reconciliation_payment_difference",
    );
  });

  it("refuses a payout while the Driver owes money", () => {
    expect(
      code(() =>
        assertPaymentsMatchExpectation(
          [
            { amount: 75, paymentMethod: "cash" },
            { amount: 5, direction: "out", paymentMethod: "cash" },
            { amount: 267, paymentMethod: "bank_transfer" },
          ],
          owes337,
        ),
      ),
    ).toBe("reconciliation_payout_not_allowed");
  });

  const payout40 = settlementExpectation({
    cashGross: new Decimal(0),
    expenseTotal: new Decimal(40),
    offset: new Decimal(0),
    visaGross: new Decimal(67),
  });

  it("requires the cash payout to equal what the Company owes (E4)", () => {
    const ok = [
      { amount: 67, paymentMethod: "bank_transfer" as const },
      { amount: 40, direction: "out" as const, paymentMethod: "cash" as const },
    ];
    expect(() => assertPaymentsMatchExpectation(ok, payout40)).not.toThrow();
    expect(signedPaymentTotal(ok).toFixed(2)).toBe(payout40.net.toFixed(2));
    expect(
      code(() =>
        assertPaymentsMatchExpectation([{ amount: 67, paymentMethod: "bank_transfer" }], payout40),
      ),
    ).toBe("reconciliation_company_payout_required");
    expect(
      code(() =>
        assertPaymentsMatchExpectation(
          [
            { amount: 67, paymentMethod: "bank_transfer" },
            { amount: 30, direction: "out", paymentMethod: "cash" },
          ],
          payout40,
        ),
      ),
    ).toBe("reconciliation_company_payout_required");
  });

  it("requires the money received to equal the Visa total when the Company pays", () => {
    expect(
      code(() =>
        assertPaymentsMatchExpectation(
          [{ amount: 40, direction: "out", paymentMethod: "cash" }],
          payout40,
        ),
      ),
    ).toBe("reconciliation_payment_difference");
  });

  it("never pays the Driver by transfer", () => {
    expect(
      code(() =>
        assertPaymentsMatchExpectation(
          [
            { amount: 67, paymentMethod: "bank_transfer" },
            { amount: 40, direction: "out", paymentMethod: "bank_transfer" },
          ],
          payout40,
        ),
      ),
    ).toBe("reconciliation_payout_cash_only");
  });

  it("accepts a zero-only collection with no payments, and refuses a payment on a zero net (E6)", () => {
    const zero = settlementExpectation({
      cashGross: new Decimal(0),
      expenseTotal: new Decimal(0),
      offset: new Decimal(0),
      visaGross: new Decimal(0),
    });
    expect(() => assertPaymentsMatchExpectation([], zero)).not.toThrow();
    expect(code(() => assertPaymentsMatchExpectation([{ amount: 1, paymentMethod: "cash" }], zero))).toBe(
      "reconciliation_payment_difference",
    );
  });
});
