import { describe, expect, it } from "vitest";

import {
  planCompensationPosting,
  planReversal,
  type ReceivableOffsetState,
  refuseReversal,
  traderNetPositionChange,
  untouchedOffsetCount,
} from "./receivable-offset-reversal-plan.js";

/**
 * The real shape: RCV-000047, AED 18, ORD-000108, cleared by one offset inside
 * SET-000007, which carries six offsets totalling AED 108.
 */
const RCV_000047: ReceivableOffsetState = {
  amountCollected: "18.00",
  offsetAmount: "18.00",
  originalAmountDue: "18.00",
  physicalCollectionCount: 0,
  receivableStatus: "collected",
  settlementAlreadyReversed: false,
  settlementAccountingPosted: true,
  settlementOffsetCount: 6,
  settlementStatus: "confirmed",
};

describe("RCV-000047 is reversible, and only it", () => {
  it("allows the reversal", () => {
    expect(refuseReversal(RCV_000047)).toBeNull();
  });

  it("reverses exactly one receivable and no offsets", () => {
    const plan = planReversal(RCV_000047);
    expect(plan.receivableStatus).toBe("reversed");
    expect(plan.offsetRowsWritten).toBe(0);
    expect(plan.otherOffsetsAffected).toBe(0);
    expect(plan.settlementWritten).toBe(false);
  });

  it("leaves the other five offsets in SET-000007 alone", () => {
    expect(untouchedOffsetCount(RCV_000047)).toBe(5);
    expect(planReversal(RCV_000047).otherOffsetsAffected).toBe(0);
  });

  it("never writes the settlement header", () => {
    // The confirmation trigger no longer polices a confirmed Settlement, so a
    // write here would corrupt it silently rather than raise.
    expect(planReversal(RCV_000047).settlementWritten).toBe(false);
  });

  it("keeps amount_collected as historical fact", () => {
    // Zeroing it would make the reversed Receivable report
    // outstanding_amount = 18.00 and reappear in outstanding sums.
    expect(planReversal(RCV_000047).amountCollected).toBe("18.00");
  });

  it("never writes the order's payable settlement status", () => {
    // `trader_settlement_status` is a pure function of the Order's payable TO
    // the Trader, not of the Receivable. ORD-000108 is Trader-pays-fee with
    // COD 0.00, so it is correctly `not_eligible` and must stay so -- forcing
    // `unsettled` would assert a payable that does not exist and would put the
    // Order into payable-settlement eligibility, which filters
    // `not in ('not_eligible','reversed')`.
    expect(planReversal(RCV_000047).orderSettlementStatusWritten).toBe(false);
  });

  it("leaves reopening the order as a separate operation", () => {
    // An earlier draft changed the flag purely to make a later reopen
    // possible. Reversing what the Trader owes must not silently alter the
    // Order's payable eligibility.
    const plan = planReversal(RCV_000047);
    expect(plan.orderSettlementStatusWritten).toBe(false);
    expect(plan.settlementWritten).toBe(false);
    expect(plan.offsetRowsWritten).toBe(0);
  });
});

describe("the AED 18 compensation", () => {
  it("credits the trader exactly the amount that was offset", () => {
    expect(planReversal(RCV_000047).creditAmount).toBe("18.00");
    expect(planCompensationPosting(RCV_000047).amount).toBe("18.00");
  });

  it("moves no cash", () => {
    expect(planReversal(RCV_000047).cashMovement).toBe("0.00");
  });

  it("uses only mapping keys that already exist and are configured", () => {
    // The whole point: no invented mapping key. `cod_receivable` was invented
    // in the loader on another path and resolved to nothing for seven weeks.
    const posting = planCompensationPosting(RCV_000047);
    expect(posting.debitMappingKey).toBe("order_cod_receivable");
    expect(posting.creditMappingKey).toBe("trader_payable");
  });

  it("leaves the trader's net position changed by exactly zero", () => {
    // The assertion that catches a half-built reversal. Restoring the
    // Receivable without the Credit leaves him 18 down; crediting without
    // reversing leaves him 18 up.
    expect(traderNetPositionChange(RCV_000047)).toBe("0.00");
  });

  it("holds the net-zero invariant at every amount", () => {
    for (const amount of ["0.01", "18.00", "30.00", "108.00", "1234.56"]) {
      expect(
        traderNetPositionChange({ ...RCV_000047, amountCollected: amount, offsetAmount: amount }),
      ).toBe("0.00");
    }
  });
});

describe("refusals", () => {
  it("refuses a receivable already reversed (retry is not a second reversal)", () => {
    expect(refuseReversal({ ...RCV_000047, receivableStatus: "reversed" })).toBe(
      "trader_receivable_already_reversed",
    );
    expect(refuseReversal({ ...RCV_000047, receivableStatus: "cancelled" })).toBe(
      "trader_receivable_already_reversed",
    );
  });

  it("refuses an outstanding receivable (nothing was settled to reverse)", () => {
    expect(refuseReversal({ ...RCV_000047, receivableStatus: "outstanding" })).toBe(
      "trader_receivable_offset_not_reversible",
    );
  });

  it("refuses a physically collected receivable rather than fabricating a credit", () => {
    expect(refuseReversal({ ...RCV_000047, physicalCollectionCount: 1 })).toBe(
      "trader_receivable_has_physical_collection",
    );
  });

  it("refuses when the offset is only part of what was collected", () => {
    expect(
      refuseReversal({ ...RCV_000047, amountCollected: "18.00", offsetAmount: "10.00" }),
    ).toBe("trader_receivable_offset_partial");
  });

  it("refuses an unconfirmed settlement", () => {
    expect(refuseReversal({ ...RCV_000047, settlementStatus: "draft" })).toBe(
      "trader_settlement_not_confirmed",
    );
  });

  it("refuses when the whole settlement has already been reversed", () => {
    expect(refuseReversal({ ...RCV_000047, settlementAlreadyReversed: true })).toBe(
      "trader_settlement_already_reversed",
    );
  });

  it("refuses while the clearing settlement's accounting has not posted", () => {
    // Without the offset's AR credit in the ledger there is no residual for
    // the compensating Credit's AR debit to clear, so it would create an AR
    // balance against a reversed Receivable instead of flattening one.
    expect(refuseReversal({ ...RCV_000047, settlementAccountingPosted: false })).toBe(
      "trader_settlement_accounting_not_posted",
    );
  });

  it("refuses a zero offset", () => {
    expect(
      refuseReversal({ ...RCV_000047, amountCollected: "0.00", offsetAmount: "0.00" }),
    ).toBe("trader_receivable_offset_not_reversible");
  });
});

describe("single-offset settlements are reversible too", () => {
  it("reports no collateral and still compensates", () => {
    const single = { ...RCV_000047, settlementOffsetCount: 1 };
    expect(refuseReversal(single)).toBeNull();
    expect(untouchedOffsetCount(single)).toBe(0);
    expect(traderNetPositionChange(single)).toBe("0.00");
  });

  it("never reports negative collateral", () => {
    expect(untouchedOffsetCount({ ...RCV_000047, settlementOffsetCount: 0 })).toBe(0);
    expect(untouchedOffsetCount({ ...RCV_000047, settlementOffsetCount: Number.NaN })).toBe(0);
  });
});

describe("purity", () => {
  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(RCV_000047);
    planReversal(RCV_000047);
    planCompensationPosting(RCV_000047);
    refuseReversal(RCV_000047);
    traderNetPositionChange(RCV_000047);
    expect(JSON.stringify(RCV_000047)).toBe(snapshot);
  });

  it("is repeatable, so a retry plans identically", () => {
    expect(planReversal(RCV_000047)).toStrictEqual(planReversal(RCV_000047));
    expect(planCompensationPosting(RCV_000047)).toStrictEqual(
      planCompensationPosting(RCV_000047),
    );
  });
});
