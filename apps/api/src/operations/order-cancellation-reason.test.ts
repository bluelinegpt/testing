import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORDER_CANCELLATION_REASON,
  ORDER_CANCELLATION_REASONS,
  resolveOrderCancellationReason,
} from "./order-cancellation-reason.js";

describe("Order cancellation reasons", () => {
  it("is exactly the three agreed reasons, defaulting to Cancel Normal", () => {
    expect(ORDER_CANCELLATION_REASONS).toEqual([
      "cancel_by_customer",
      "cancel_by_trader",
      "cancel_normal",
    ]);
    expect(DEFAULT_ORDER_CANCELLATION_REASON).toBe("cancel_normal");
  });

  it("uses the office user's choice, or Cancel Normal when none is sent", () => {
    expect(resolveOrderCancellationReason("company_user", "cancel_by_customer")).toBe(
      "cancel_by_customer",
    );
    expect(resolveOrderCancellationReason("company_user", undefined)).toBe("cancel_normal");
  });

  it("always records a Trader as Cancel by Trader and a Driver as Cancel Normal", () => {
    expect(resolveOrderCancellationReason("trader", "cancel_by_customer")).toBe("cancel_by_trader");
    expect(resolveOrderCancellationReason("trader", undefined)).toBe("cancel_by_trader");
    expect(resolveOrderCancellationReason("driver", "cancel_by_customer")).toBe("cancel_normal");
  });
});
