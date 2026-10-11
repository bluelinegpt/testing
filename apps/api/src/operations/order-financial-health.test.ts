import { describe, expect, it } from "vitest";

import { ORDER_FINANCIAL_HEALTH, orderFinancialHealth } from "./order-financial-classification.js";
import * as maintenance from "./order-maintenance.service.js";

/**
 * The high-level Verify First outcome. A Receivable fully satisfied by
 * currently effective Settlement offsets is HEALTHY: an offset is a valid
 * settlement mechanism, and a physical Trader Collection is not mandatory.
 * ISSUE is reserved for an actual, actionable inconsistency; REVIEW for a
 * state that cannot safely be classified.
 */
describe("Order financial health mapping", () => {
  it("maps every detailed classification", () => {
    expect(ORDER_FINANCIAL_HEALTH).toEqual({
      ALREADY_PHYSICALLY_COLLECTED: "HEALTHY",
      HEALTHY_ACTIVE_RECEIVABLE: "HEALTHY",
      MISSING_RECEIVABLE: "ISSUE",
      NEEDS_REVIEW: "REVIEW",
      NO_TRADER_RECEIVABLE_REQUIRED: "HEALTHY",
      OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION: "HEALTHY",
      // Phase 3 Prompt 2: a current receivable that does not reconcile with
      // its own effective records (or with the Order amount) is ISSUE.
      RECEIVABLE_INCONSISTENT: "ISSUE",
      REVERSED_NEEDS_REPAIR: "ISSUE",
    });
  });

  it("treats a valid offset settlement as HEALTHY, never ISSUE", () => {
    expect(orderFinancialHealth("OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION")).toBe("HEALTHY");
  });

  it("is the same table Order Maintenance re-exports (one vocabulary)", () => {
    expect(maintenance.ORDER_FINANCIAL_HEALTH).toBe(ORDER_FINANCIAL_HEALTH);
    expect(maintenance.orderFinancialHealth).toBe(orderFinancialHealth);
  });
});
