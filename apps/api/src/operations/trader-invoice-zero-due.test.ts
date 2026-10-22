import { describe, expect, it } from "vitest";

import {
  mergeZeroDueLines,
  type TraderSettlementDetailOrder,
  type TraderSettlementSummaryTotals,
} from "./trader-settlement.service.js";

const line = (referenceNumber: string, cod: string, fee: string, paid: string): TraderSettlementDetailOrder => ({
  additionalFees: "0.00",
  amountPaidNow: paid,
  areaName: "Deira",
  codAmount: cod,
  customerMobileNumber: "0500000000",
  customerName: "عميل",
  deliveryDate: "2026-10-13",
  emirateName: "Dubai",
  orderNumber: `ORD-${referenceNumber}`,
  orderSettlementStatus: "money_sent_to_trader",
  orderType: "delivery",
  originalTraderPayable: paid,
  previouslyPaid: "0.00",
  referenceNumber,
  remainingOutstanding: "0.00",
  serialNumber: referenceNumber,
  serviceFee: fee,
  totalDeductions: fee,
  vatAmount: "0.00",
});

const summary: TraderSettlementSummaryTotals = {
  amountPaidNow: "453.00",
  grossOrderPayable: "453.00",
  netPayment: "453.00",
  orderCount: 2,
  previouslyPaid: "0.00",
  remainingOutstanding: "0.00",
  totalAdditionalFees: "0.00",
  totalCod: "485.00",
  totalDeductions: "32.00",
  totalOriginalTraderPayable: "453.00",
  totalServiceFees: "32.00",
  totalVat: "0.00",
  traderFeeDeductions: "0.00",
};

// SET-000098 (ARMAN ABYA): ref 4980, COD 15 / fee 16 / paid 0, sits between
// 4979 and 4981 and adds to COD, fees and the order count -- never to the
// amount paid (Aiman, 22 Oct 2026).
describe("mergeZeroDueLines (Trader Invoice zero-payable Orders)", () => {
  it("lists the zero-payable Order in Reference order without changing the amount paid", () => {
    const merged = mergeZeroDueLines(
      { lines: [line("4979", "145.00", "16.00", "129.00"), line("4981", "340.00", "16.00", "324.00")], summary },
      [line("4980", "15.00", "16.00", "0.00")],
    );
    expect(merged.lines.map((row) => row.referenceNumber)).toEqual(["4979", "4980", "4981"]);
    expect(merged.lines[1]?.amountPaidNow).toBe("0.00");
    expect(merged.summary.orderCount).toBe(3);
    expect(merged.summary.totalCod).toBe("500.00");
    expect(merged.summary.totalServiceFees).toBe("48.00");
    expect(merged.summary.netPayment).toBe("453.00");
  });

  it("leaves an invoice with no zero-payable Orders unchanged", () => {
    const settled = { lines: [line("4979", "145.00", "16.00", "129.00")], summary };
    expect(mergeZeroDueLines(settled, [])).toBe(settled);
  });
});
