import { describe, expect, it } from "vitest";

import {
  CLOSE_ELIGIBLE_SETTLEMENT_STATUSES,
  closeSettlementComplete,
  restoredDeliveryStatus,
  reversalInvalidatesClose,
} from "./order-close-eligibility.js";

/**
 * The real shape: one of the 31 Orders in SET-000017 after SET-000018 reversed
 * it. ORD-000222 / reference 2375, AED 461 payable, left `closed` with
 * `trader_settlement_status = 'unsettled'` and `trader_paid_amount = 0`.
 */
const ORD_000222 = {
  deliveryStatus: "closed",
  settlementStatusAfterReversal: "unsettled",
  traderNetPayable: "461.00",
} as const;

describe("a reversal that invalidates the close", () => {
  it("reopens ORD-000222", () => {
    expect(reversalInvalidatesClose(ORD_000222)).toBe(true);
  });

  it("reopens every status the reversal can write", () => {
    // reverseInTransaction computes exactly these three.
    for (const settlementStatusAfterReversal of ["unsettled", "partially_settled", "settled"]) {
      expect(reversalInvalidatesClose({ ...ORD_000222, settlementStatusAfterReversal })).toBe(true);
    }
  });

  it("reopens at every payable amount in the stranded batch", () => {
    // The batch runs from AED 7.00 (ORD-000249) to AED 1,015.00 (ORD-000252).
    for (const traderNetPayable of ["7.00", "17.00", "461.00", "1015.00", "0.01"]) {
      expect(reversalInvalidatesClose({ ...ORD_000222, traderNetPayable })).toBe(true);
    }
  });
});

describe("what a reversal must leave closed", () => {
  it("leaves an order the company owes nothing on", () => {
    // Trader-pays-fee with COD 0.00: the close gate's second clause holds on its
    // own, so nothing was invalidated. Reopening it would assert a payable that
    // does not exist.
    expect(reversalInvalidatesClose({ ...ORD_000222, traderNetPayable: "0.00" })).toBe(false);
    expect(reversalInvalidatesClose({ ...ORD_000222, traderNetPayable: "-18.00" })).toBe(false);
  });

  it("leaves an order whose settlement survived the reversal", () => {
    for (const settlementStatusAfterReversal of CLOSE_ELIGIBLE_SETTLEMENT_STATUSES) {
      expect(reversalInvalidatesClose({ ...ORD_000222, settlementStatusAfterReversal })).toBe(
        false,
      );
    }
  });

  it("leaves an order that was not closed when the reversal ran", () => {
    // The 10 harmless Orders across SET-000003, SET-000010 and SET-000039: the
    // reversal ran while they were still `delivered`, so there was no close to
    // undo and they re-settled normally.
    for (const deliveryStatus of ["delivered", "returned_to_trader", "collect_order", "hold"]) {
      expect(reversalInvalidatesClose({ ...ORD_000222, deliveryStatus })).toBe(false);
    }
  });
});

describe("closeSettlementComplete mirrors the close gate", () => {
  it("accepts exactly the three eligible statuses", () => {
    for (const settlementStatus of CLOSE_ELIGIBLE_SETTLEMENT_STATUSES) {
      expect(closeSettlementComplete({ settlementStatus, traderNetPayable: "461.00" })).toBe(true);
    }
  });

  it("does not accept settled, which the gate has never accepted", () => {
    // Recorded, not fixed: reverseInTransaction can write `settled` on a partial
    // reversal, and such an Order then cannot close. Widening the gate is a
    // policy decision, so this test pins today's behaviour rather than blessing
    // it.
    expect(closeSettlementComplete({ settlementStatus: "settled", traderNetPayable: "1.00" })).toBe(
      false,
    );
  });

  it("keeps the gate closed on an unparseable payable", () => {
    expect(closeSettlementComplete({ settlementStatus: "unsettled", traderNetPayable: "" })).toBe(
      false,
    );
    expect(
      closeSettlementComplete({ settlementStatus: "unsettled", traderNetPayable: Number.NaN }),
    ).toBe(false);
  });
});

describe("the status an unclose restores", () => {
  it("restores delivered for all 31 stranded orders", () => {
    // Verified against order_status_history: every one of the 31 recorded
    // `delivered -> closed`.
    expect(restoredDeliveryStatus("delivered")).toBe("delivered");
  });

  it("restores the other two predecessors the close gate accepts", () => {
    expect(restoredDeliveryStatus("returned_to_trader")).toBe("returned_to_trader");
    expect(restoredDeliveryStatus("collect_order")).toBe("collect_order");
  });

  it("falls back to delivered when history is missing or unrecognised", () => {
    // Legacy rows predate the delivery dimension. `delivered` is the only
    // predecessor an Order can be settled from, and making settlement possible
    // again is the whole point of the unclose.
    expect(restoredDeliveryStatus(null)).toBe("delivered");
    expect(restoredDeliveryStatus(undefined)).toBe("delivered");
    expect(restoredDeliveryStatus("cancelled")).toBe("delivered");
    expect(restoredDeliveryStatus("closed")).toBe("delivered");
  });

  it("never returns closed, whatever it is given", () => {
    for (const input of ["closed", "", "CLOSED", "delivered", null]) {
      expect(restoredDeliveryStatus(input)).not.toBe("closed");
    }
  });
});
