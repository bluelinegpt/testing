import { describe, expect, it } from "vitest";

import { ApplicationException } from "../presentation/errors/application.exception.js";

describe("Order Maintenance not-found diagnostics", () => {
  it("exposes only the explicitly gated safe diagnostic fields", () => {
    const exception = new ApplicationException(
      "trader_receivable_not_found",
      "Trader receivable not found",
      404,
      undefined,
      {
        orderUuid: "order-id",
        requestCompanyId: "company-id",
        orderFound: true,
        orderId: "order-id",
        orderNumber: "ORD-TEST",
        orderCompanyId: "company-id",
        receivableMatchCount: 0,
        referenceMatchCount: 1,
        companyReferenceMatchCount: 0,
      },
      true,
    );

    expect(exception.exposeDiagnostics).toBe(true);
    expect(exception.diagnostics).toEqual({
      orderUuid: "order-id",
      requestCompanyId: "company-id",
      orderFound: true,
      orderId: "order-id",
      orderNumber: "ORD-TEST",
      orderCompanyId: "company-id",
      receivableMatchCount: 0,
      referenceMatchCount: 1,
      companyReferenceMatchCount: 0,
    });
  });
});
