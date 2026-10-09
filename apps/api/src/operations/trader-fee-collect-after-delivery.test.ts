import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An Order-fee (service_charge) receivable can be collected only after its
 * Order is delivered (decision 9 Oct 2026). The Collect Money list already
 * hid undelivered fees, but auto-allocation, confirmation and the Trader
 * balance did not (XYZ had 21 such fees outstanding).
 */
describe("Order fees are collectable only after delivery", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/trader-receivable.service.ts"), "utf8");

  it("defines the delivered-Order rule once", () => {
    expect(service).toContain("const receivableCollectableNow = sql<boolean>`(");
    expect(service).toContain("collectable_order.delivered_at is not null");
  });

  it("applies it to the Trader balance, auto-allocation and the confirm lock", () => {
    expect(service.split("${receivableCollectableNow}").length - 1).toBeGreaterThanOrEqual(3);
    expect(service).toContain("${receivableCollectableNow} as collectable");
  });

  it("refuses to confirm a collection that includes an undelivered Order fee", () => {
    expect(service).toContain('"trader_collection_order_not_delivered"');
    expect(service).toContain("receivable.collectable === false");
  });
});
